// @ts-check
/**
 * dsh-worktree-flow HTTP surface: same-origin loopback endpoints the
 * settings-page client calls. Thin adapter — every route parses input, calls
 * WorktreeFlowService, and serializes the result. No business rules here.
 *
 *   GET  /worktree-flow/sets
 *   GET  /worktree-flow/config?set=<name>
 *   POST /worktree-flow/config           {set, config}
 *   GET  /worktree-flow/template         new-set template (prefill-only)
 *   POST /worktree-flow/template         {config}
 *   GET  /worktree-flow/branch-types     global branch-type vocabulary
 *   POST /worktree-flow/branch-types     {types}
 *   POST /worktree-flow/detect           → template prefill for a new set
 *   POST /worktree-flow/probe            {path}  → isRepo + probed base branch
 *   POST /worktree-flow/git-init         {cwd}
 *   GET  /worktree-flow/features?set=<name>
 *   GET  /worktree-flow/locate?cwd=<dir>  feature workspace owning cwd (conversation UI)
 *   POST /worktree-flow/create           {set, intent}
 *   POST /worktree-flow/sync             {set}
 *   POST /worktree-flow/archive          {set, feature, keepRegistered}
 *   POST /worktree-flow/cleanup/plan     {set, feature}
 *   POST /worktree-flow/cleanup          {set, feature, force}
 *   POST /worktree-flow/register         {set, feature}
 *   POST /worktree-flow/unregister       {set, feature}
 *   POST /worktree-flow/validate         {set}   → inline config validation
 *   POST /worktree-flow/scan-siblings    {cwd}   → bindable neighbouring repos
 *   POST /worktree-flow/parse-intent     {text, components}
 *
 * Every route passes a loopback guard: the Host header must be loopback
 * (127.0.0.1/localhost/::1) and cross-site fetch metadata / foreign Origin
 * headers are rejected — see registerHttp for the threat model (CSRF via
 * no-cors simple requests, DNS rebinding).
 *
 * @module dsh-worktree-flow/http
 */
import { WorktreeFlowError, featurePaths, parseNaturalIntent, slugifyFeature } from "./core.js";
import { readBranchTypes, readConfigTemplate, writeBranchTypes, writeConfigTemplate } from "./config.js";
import { registerFeature, unregisterWorkspace } from "./registry.js";

const BODY_LIMIT = 1 << 20;

// Read-path TTL cache. The settings section remounts on every open and re-runs
// the expensive per-component git scans; a short TTL makes rapid re-opens
// instant while bounding staleness for externally-changed git state. Writes
// clear the whole cache (writes are rare, so this is simpler than key math).
const READ_TTL_MS = 10_000;
const SETS_TTL_MS = 30_000;
const readCache = new Map();

function cacheGet(key) {
	const hit = readCache.get(key);
	if (hit !== undefined && Date.now() - hit.at < hit.ttl) return hit.value;
	readCache.delete(key);
	return undefined;
}

function cacheSet(key, value, ttl) {
	readCache.set(key, { at: Date.now(), value, ttl });
}

function invalidateReadCache() {
	readCache.clear();
}

function sendJson(res, status, body) {
	if (res.writableEnded) return;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

/** Collect a JSON request body (node http.IncomingMessage). */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > BODY_LIMIT) {
				reject(new WorktreeFlowError("BODY_TOO_LARGE", "请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new WorktreeFlowError("BAD_BODY", "请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

/** Uniform error payload; WorktreeFlowError surfaces its stable code. */
function sendError(res, error) {
	if (error instanceof WorktreeFlowError) {
		sendJson(res, 400, { ok: false, code: error.code, error: error.message });
		return;
	}
	sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
}

function requireField(body, name) {
	const value = body?.[name];
	if (typeof value !== "string" || value.trim() === "") {
		throw new WorktreeFlowError("BAD_INPUT", `缺少字段：${name}`);
	}
	return value;
}

function requireQuery(req, name) {
	const url = new URL(req.url ?? "", "http://localhost");
	const value = url.searchParams.get(name) ?? "";
	if (value === "") throw new WorktreeFlowError("BAD_INPUT", `缺少查询参数：${name}`);
	return value;
}

/**
 * Register all routes. `webServer` arrives through a nested inject fiber so
 * the plugin still loads where no web server exists (headless/tui).
 * @param {object} ctx
 * @param {import("./service.js").WorktreeFlowService} service
 */
export function registerHttp(ctx, service) {
	ctx.inject(["webServer"], (webCtx) => {
		const log = ctx.logger("dsh-worktree-flow");

		// Loopback guard. These endpoints delete worktrees and rewrite config,
		// yet a loopback web server is reachable from ANY page open in the
		// user's browser: no-cors "simple" requests deliver POST bodies without
		// CORS, and DNS rebinding makes a remote origin resolve to 127.0.0.1.
		// Defense: require a loopback Host header (rebinding keeps the foreign
		// host name) and reject cross-site fetch metadata / foreign Origins.
		const isLoopbackHost = (host) => {
			const value = String(host ?? "").toLowerCase();
			const name = value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : value.split(":")[0];
			return name === "127.0.0.1" || name === "localhost" || name === "::1" || name === "[::1]";
		};
		const guardRequest = (req, res) => {
			const deny = (reason) => { sendJson(res, 403, { ok: false, error: reason }); return false; };
			const headers = req.headers ?? {};
			if (!isLoopbackHost(headers.host)) return deny("仅允许 loopback Host 访问");
			const site = headers["sec-fetch-site"];
			if (typeof site === "string" && !["same-origin", "same-site", "none"].includes(site)) return deny("拒绝跨站请求");
			const origin = headers.origin;
			if (typeof origin === "string" && origin !== "" && origin !== "null") {
				try {
					if (!isLoopbackHost(new URL(origin).host)) return deny("拒绝跨站 Origin");
				} catch {
					return deny("非法 Origin");
				}
			}
			return true;
		};
		const route = (spec) => webCtx.webServer.register({
			kind: spec.kind,
			path: spec.path,
			handler: async (req, res) => {
				if (!guardRequest(req, res)) return;
				await spec.handler(req, res);
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/sets",
			handler: async (_req, res) => {
				try {
					let sets = cacheGet("sets");
					if (sets === undefined) {
						sets = await service.listSets();
						cacheSet("sets", sets, SETS_TTL_MS);
					}
					sendJson(res, 200, { ok: true, sets });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/config",
			handler: async (req, res) => {
				try {
					if (req.method === "GET") {
						const set = requireQuery(req, "set");
						const config = await service.getSet(set);
						sendJson(res, 200, { ok: true, config });
						return;
					}
					if (req.method === "POST") {
						const body = await readBody(req);
						const set = requireField(body, "set");
						const config = body.config;
						if (config === null || typeof config !== "object") throw new WorktreeFlowError("BAD_INPUT", "缺少字段：config");
						const file = await service.saveSetConfig({
							name: set,
							label: typeof config.label === "string" && config.label.trim() !== "" ? config.label.trim() : undefined,
							worktreeRoot: String(config.worktreeRoot ?? ""),
							defaultBaseBranch: String(config.defaultBaseBranch ?? "master"),
							repositories: config.repositories ?? {}
						});
						invalidateReadCache();
						sendJson(res, 200, { ok: true, file });
						return;
					}
					sendJson(res, 405, { ok: false, error: "GET/POST only" });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/template",
			handler: async (req, res) => {
				try {
					if (req.method === "GET") {
						const template = await readConfigTemplate();
						sendJson(res, 200, { ok: true, configured: template !== undefined, config: template ?? null });
						return;
					}
					if (req.method === "POST") {
						const body = await readBody(req);
						const config = body.config;
						if (config === null || typeof config !== "object") throw new WorktreeFlowError("BAD_INPUT", "缺少字段：config");
						const file = await writeConfigTemplate({
							worktreeRoot: String(config.worktreeRoot ?? ""),
							defaultBaseBranch: String(config.defaultBaseBranch ?? ""),
							repositories: config.repositories ?? {}
						});
						sendJson(res, 200, { ok: true, file });
						return;
					}
					sendJson(res, 405, { ok: false, error: "GET/POST only" });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/detect",
			handler: async (_req, res) => {
				try {
					sendJson(res, 200, { ok: true, config: await service.prefillSet() });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/branch-types",
			handler: async (req, res) => {
				try {
					if (req.method === "GET") {
						sendJson(res, 200, { ok: true, types: await readBranchTypes() });
						return;
					}
					if (req.method === "POST") {
						const body = await readBody(req);
						if (!Array.isArray(body.types)) throw new WorktreeFlowError("BAD_INPUT", "缺少字段：types（数组）");
						sendJson(res, 200, { ok: true, types: await writeBranchTypes(body.types) });
						return;
					}
					sendJson(res, 405, { ok: false, error: "GET/POST only" });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/probe",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					sendJson(res, 200, { ok: true, result: await service.probeComponent(requireField(body, "path")) });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/git-init",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const cwd = requireField(body, "cwd");
					sendJson(res, 200, { ok: true, ...(await service.gitInit(cwd)) });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/features",
			handler: async (req, res) => {
				try {
					const set = requireQuery(req, "set");
					const cacheKey = `features:${set}`;
					let payload = cacheGet(cacheKey);
					if (payload === undefined) {
						const { features, config } = await service.listFeatures(set);
						payload = { setName: config.name, setLabel: config.label ?? null, worktreeRoot: config.worktreeRoot, features };
						cacheSet(cacheKey, payload, READ_TTL_MS);
					}
					sendJson(res, 200, { ok: true, ...payload });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/locate",
			handler: async (req, res) => {
				try {
					const url = new URL(req.url ?? "/", "http://localhost");
					const cwd = requireQuery(req, "cwd");
					// 默认快速定位（manifest + 目录存在性，徽章立即可显示）；
					// detail=1 才对每个组件 spawn git（浮层/告警条用）。不走缓存。
					const detail = url.searchParams.get("detail") === "1";
					sendJson(res, 200, { ok: true, ...(await service.locate(cwd, { withGit: detail })) });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/create",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const set = requireField(body, "set");
					const intent = body.intent ?? {};
					const result = await service.createFeature(set, {
						feature: typeof intent.feature === "string" ? intent.feature : "",
						components: Array.isArray(intent.components) ? intent.components.map(String) : [],
						branch: typeof intent.branch === "string" && intent.branch !== "" ? intent.branch : undefined,
						baseBranch: typeof intent.baseBranch === "string" && intent.baseBranch !== "" ? intent.baseBranch : undefined,
						dryRun: intent.dryRun === true,
						registerComponents: intent.registerComponents === true
					});
					invalidateReadCache();
					sendJson(res, 200, { ok: true, result });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/sync",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					invalidateReadCache();
					sendJson(res, 200, { ok: true, result: await service.sync(requireField(body, "set")) });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/archive",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const result = await service.archiveFeature(requireField(body, "set"), requireField(body, "feature"), {
						keepRegistered: body.keepRegistered === true
					});
					invalidateReadCache();
					sendJson(res, 200, { ok: true, result });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/cleanup/plan",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const plan = await service.planCleanup(requireField(body, "set"), requireField(body, "feature"));
					sendJson(res, 200, { ok: true, plan });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/cleanup",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const result = await service.cleanupFeature(requireField(body, "set"), requireField(body, "feature"), {
						force: body.force === true
					});
					invalidateReadCache();
					sendJson(res, 200, { ok: true, result });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/register",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const set = requireField(body, "set");
					const feature = slugifyFeature(requireField(body, "feature"));
					const config = await service.getSet(set);
					const paths = featurePaths({ worktreeRoot: config.worktreeRoot, projectName: config.name }, feature);
					const outcome = await registerFeature(ctx, paths.featureRoot, config.name, feature);
					invalidateReadCache();
					sendJson(res, 200, { ok: true, state: outcome.state, title: `${config.name}/${feature}` });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/unregister",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const set = requireField(body, "set");
					const feature = slugifyFeature(requireField(body, "feature"));
					const config = await service.getSet(set);
					const paths = featurePaths({ worktreeRoot: config.worktreeRoot, projectName: config.name }, feature);
					const outcome = await unregisterWorkspace(ctx, paths.featureRoot);
					invalidateReadCache();
					sendJson(res, 200, { ok: true, state: outcome.state });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/validate",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					sendJson(res, 200, { ok: true, result: await service.validateConfig(requireField(body, "set")) });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/scan-siblings",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					sendJson(res, 200, { ok: true, result: await service.scanSiblingRepos(requireField(body, "cwd")) });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		route({
			kind: "exact",
			path: "/worktree-flow/parse-intent",
			handler: async (req, res) => {
				try {
					const body = await readBody(req);
					const text = typeof body.text === "string" ? body.text : "";
					const components = Array.isArray(body.components) ? body.components.map(String) : [];
					sendJson(res, 200, { ok: true, result: parseNaturalIntent(text, components) });
				} catch (error) {
					sendError(res, error);
				}
			}
		});

		log.info("worktree-flow HTTP endpoints registered (/worktree-flow/*)");
	});
}
