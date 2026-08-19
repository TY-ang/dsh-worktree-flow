// @ts-check
/**
 * Load test: drive the plugin's command surface with a mock cordis ctx —
 * canned git responses per argv, in-memory workspace registry, and a named
 * SET stored under a fixture $DSH_HOME (worktree-flow/sets/demo.json).
 * Verifies registration, dispatch, flag parsing, cwd→set resolution, and
 * result rendering.
 *
 * Run: node test/load-test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const commands = new Map();
const spawned = [];
const workspaces = new Map();
const httpRoutes = new Map();
const eventListeners = new Map();
let workspaceSeq = 0;

// --- fixture: one named set in a fake $DSH_HOME -----------------------------
const fixture = mkdtempSync(join(tmpdir(), "dsh-wf-load-"));
const repoRoot = join(fixture, "repo");
const worktreeRoot = join(fixture, "wt");
mkdirSync(repoRoot, { recursive: true });
const setsDir = join(fixture, "dsh-home", "worktree-flow", "sets");
mkdirSync(setsDir, { recursive: true });
writeFileSync(
	join(setsDir, "demo.json"),
	JSON.stringify({
		version: 1,
		label: "演示",
		worktreeRoot,
		defaultBaseBranch: "master",
		repositories: { backend: { path: repoRoot, label: "后端" }, frontend: { path: join(fixture, "frontend-repo") } }
	})
);
process.env.DSH_HOME = join(fixture, "dsh-home");

// --- mock ctx ---------------------------------------------------------------
const fakeRegistry = {
	async create(path, title) {
		for (const workspace of workspaces.values()) if (workspace.path === path) return workspace;
		workspaceSeq += 1;
		const workspace = { id: `ws-${workspaceSeq}`, path, title: title ?? path, sessionIds: [], async setTitle(next) { workspace.title = next; }, async status() { return "ok"; } };
		workspaces.set(workspace.id, workspace);
		return workspace;
	},
	async resolveByPath(path) {
		for (const workspace of workspaces.values()) if (workspace.path === path) return workspace;
		return undefined;
	},
	async delete(id) { return workspaces.delete(id); },
	list() { return [...workspaces.values()]; }
};

/** Canned git answers keyed by argv shape. */
function answerGit(argv) {
	const joined = argv.join(" ");
	if (joined === "git rev-parse --show-toplevel") return { exitCode: 0, stdout: repoRoot };
	if (joined === "git rev-parse --git-common-dir") return { exitCode: 0, stdout: join(repoRoot, ".git") };
	if (joined === "git worktree list --porcelain") return { exitCode: 0, stdout: `worktree ${repoRoot}\nHEAD 0123456789012345678901234567890123456789\nbranch refs/heads/master\n` };
	if (joined === `git show-ref --verify --quiet refs/heads/master`) return { exitCode: 0, stdout: "" };
	if (joined.startsWith("git show-ref --verify --quiet")) return { exitCode: 1, stdout: "" };
	if (joined === "git branch --show-current") return { exitCode: 0, stdout: "master" };
	if (joined === "git status --porcelain") return { exitCode: 0, stdout: "" };
	if (joined.startsWith("git symbolic-ref")) return { exitCode: 1, stdout: "" };
	if (joined.startsWith("git rev-list")) return { exitCode: 0, stdout: "0\t0" };
	if (joined.startsWith("git worktree add")) return { exitCode: 0, stdout: "" };
	if (joined.startsWith("git worktree remove")) return { exitCode: 0, stdout: "" };
	return { exitCode: 0, stdout: "" };
}

const ctx = {
	subprocess: {
		spawn(spec) {
			spawned.push(spec);
			const answer = answerGit(spec.argv);
			return {
				done: Promise.resolve({ exitCode: answer.exitCode, signal: undefined }),
				collected: {
					stdout: { readFrom: () => ({ text: answer.stdout }) },
					stderr: { readFrom: () => ({ text: "" }) }
				}
			};
		}
	},
	workspaceRegistry: fakeRegistry,
	webServer: {
		register(route) {
			httpRoutes.set(route.path, route);
			return () => httpRoutes.delete(route.path);
		}
	},
	commands: {
		register(definition) {
			if (commands.has(definition.name)) throw new Error(`duplicate command: ${definition.name}`);
			commands.set(definition.name, definition);
			return () => commands.delete(definition.name);
		}
	},
	provide(name, value) { ctx[name] = value; },
	logger: () => ({ info: (line) => console.log("[plugin log]", line) }),
	get(name) { return ctx[name]; },
	on(event, handler) {
		eventListeners.set(event, handler);
		return () => eventListeners.delete(event);
	},
	inject(deps, fn) {
		if (deps.every((dep) => ctx[dep] !== undefined)) fn(ctx);
	}
};

let failed = 0;
function check(label, condition, detail = "") {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failed += 1;
		console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

const plugin = await import("../lib/index.js");
console.log("plugin shape");
check("name is worktree-flow", plugin.name === "worktree-flow", plugin.name);
check("inject only hard-depends on subprocess", JSON.stringify(plugin.inject) === JSON.stringify(["subprocess"]));
check("exports WorktreeFlowService", typeof plugin.WorktreeFlowService === "function");

plugin.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 50));

console.log("command surface");
const worktree = commands.get("worktree");
check("/worktree registered", worktree !== undefined);
check("service provided as ctx.worktreeFlow", ctx.worktreeFlow !== undefined);

const invocation = (rawInput) => ({ rawInput, signal: new AbortController().signal, agent: { session: { header: { cwd: repoRoot } } } });

const help = await worktree.handler(invocation(""));
check("bare /worktree shows usage", help.kind === "success" && help.text.includes("/worktree create"), help.text.split("\n")[0]);

console.log("cwd → set resolution");
const configShow = await worktree.handler(invocation("config show"));
check("config show resolves the set from cwd", configShow.kind === "success" && configShow.text.includes("仓库组：demo") && configShow.text.includes("backend"), configShow.text);
const explicit = await worktree.handler(invocation("config show --set demo"));
check("--set overrides cwd", explicit.kind === "success" && explicit.text.includes("仓库组：demo"), explicit.text);
const noSet = await worktree.handler({ rawInput: "status", signal: new AbortController().signal, agent: { session: { header: { cwd: fixture } } } });
check("cwd outside every set errors with NO_SET guidance", noSet.kind === "error" && noSet.text.includes("不属于任何仓库组"), noSet.text);

console.log("status (empty)");
const status = await worktree.handler(invocation("status"));
check("status reports no features yet", status.kind === "success" && status.text.includes("还没有功能工作区"), status.text);

console.log("create --dry-run");
const dry = await worktree.handler(invocation("create Selection V2 --branch feature/selection-v2 --dry-run"));
check("dry-run renders plan", dry.kind === "success" && dry.text.includes("demo/selection-v2") && dry.text.includes("backend") && dry.text.includes("frontend"), dry.text);
check("dry-run touches no disk", !existsSync(join(worktreeRoot, "demo")), "feature root should not exist");

console.log("create (mock git)");
const created = await worktree.handler(invocation("create selection-v2 --branch feature/selection-v2"));
check("create reports ready", created.kind === "success" && created.text.includes("ready"), created.text);
check("feature root registered as workspace", fakeRegistry.list().length === 1 && fakeRegistry.list()[0].title === "demo/selection-v2", JSON.stringify(fakeRegistry.list()));
check("manifest written", existsSync(join(worktreeRoot, "demo", "selection-v2", ".dsh-worktree.json")));

console.log("status (with feature)");
const status2 = await worktree.handler(invocation("status"));
check("status lists the feature", status2.kind === "success" && status2.text.includes("demo/selection-v2"), status2.text);

console.log("open");
const open = await worktree.handler(invocation("open selection-v2"));
check("open returns path + guidance", open.kind === "success" && open.text.includes("新建会话"), open.text);

console.log("finish (archive)");
const archived = await worktree.handler(invocation("finish selection-v2"));
check("archive unregisters by default", archived.kind === "success" && archived.text.includes("下架"), archived.text);
check("registry empty after archive", fakeRegistry.list().length === 0);

console.log("errors");
const bogus = await worktree.handler(invocation("bogus"));
check("unknown verb errors with usage", bogus.kind === "error" && bogus.text.includes("未知子命令"), bogus.text);
const noName = await worktree.handler(invocation("create"));
check("create without branch errors", noName.kind === "error" && noName.text.includes("完整分支名"), noName.text);
const noBranch = await worktree.handler(invocation("create selection-v3"));
check("name without branch also errors", noBranch.kind === "error" && noBranch.text.includes("完整分支名"), noBranch.text);
const missingFeature = await worktree.handler(invocation("open nope"));
check("open unknown feature errors", missingFeature.kind === "error", missingFeature.text);
const unknownSet = await worktree.handler(invocation("status --set nope"));
check("unknown set errors", unknownSet.kind === "error" && unknownSet.text.includes("仓库组不存在"), unknownSet.text);

console.log("http routes");
check("routes registered via nested webServer inject", httpRoutes.size >= 15, [...httpRoutes.keys()].join(","));

import { EventEmitter } from "node:events";
function fakeReq(method, url, body) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	// 真实 HTTP/1.1 请求必带 Host；loopback 防护要求它是 loopback。
	req.headers = { host: "127.0.0.1:3080" };
	process.nextTick(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	return req;
}
function fakeRes() {
	return {
		status: 0,
		body: "",
		writableEnded: false,
		writeHead(status) { this.status = status; },
		end(payload) { this.body = payload; this.writableEnded = true; },
		json() { return JSON.parse(this.body); }
	};
}

const setsRes = fakeRes();
await httpRoutes.get("/worktree-flow/sets").handler(fakeReq("GET", "/worktree-flow/sets"), setsRes);
check("GET /sets lists the fixture set", setsRes.status === 200 && setsRes.json().sets?.[0]?.name === "demo" && setsRes.json().sets[0].componentCount === 2, setsRes.body);
check("GET /sets marks a fully-bound set ready", setsRes.json().sets?.[0]?.ready === true, setsRes.body);

const typesRes = fakeRes();
await httpRoutes.get("/worktree-flow/branch-types").handler(fakeReq("GET", "/worktree-flow/branch-types"), typesRes);
check("GET /branch-types returns the built-in vocabulary", typesRes.status === 200 && typesRes.json().types.length === 4 && typesRes.json().types[1].prefix === "feature/", typesRes.body);

const typesWrite = fakeRes();
await httpRoutes.get("/worktree-flow/branch-types").handler(fakeReq("POST", "/worktree-flow/branch-types", { types: [...typesRes.json().types, { label: "重构", prefix: "refactor" }] }), typesWrite);
check("POST /branch-types normalizes and persists", typesWrite.status === 200 && typesWrite.json().types.at(-1)?.prefix === "refactor/", typesWrite.body);

const configRes = fakeRes();
await httpRoutes.get("/worktree-flow/config").handler(fakeReq("GET", "/worktree-flow/config?set=demo"), configRes);
check("GET /config?set returns the set config", configRes.status === 200 && configRes.json().ok === true && configRes.json().config.name === "demo" && configRes.json().config.repositories.backend.path === repoRoot, configRes.body);

const locateHit = fakeRes();
await httpRoutes.get("/worktree-flow/locate").handler(fakeReq("GET", `/worktree-flow/locate?cwd=${encodeURIComponent(join(worktreeRoot, "demo", "selection-v2", "backend"))}`), locateHit);
check("GET /locate maps a component dir to its feature", locateHit.status === 200 && locateHit.json().found === true && locateHit.json().set === "demo" && locateHit.json().feature.feature === "selection-v2", locateHit.body);
const locateMiss = fakeRes();
await httpRoutes.get("/worktree-flow/locate").handler(fakeReq("GET", `/worktree-flow/locate?cwd=${encodeURIComponent(fixture)}`), locateMiss);
check("GET /locate returns found:false outside any feature", locateMiss.status === 200 && locateMiss.json().found === false, locateMiss.body);

const templateRes = fakeRes();
await httpRoutes.get("/worktree-flow/template").handler(fakeReq("GET", "/worktree-flow/template"), templateRes);
check("GET /template returns JSON contract", templateRes.status === 200 && templateRes.json().ok === true && Object.hasOwn(templateRes.json(), "configured"), templateRes.body);

const createRes = fakeRes();
await httpRoutes.get("/worktree-flow/create").handler(fakeReq("POST", "/worktree-flow/create", { set: "demo", intent: { feature: "http feat", components: ["backend"], branch: "feature/http-feat", dryRun: true } }), createRes);
check("POST /create dry-run returns plan", createRes.status === 200 && createRes.json().result.dryRun === true && createRes.json().result.feature === "http-feat", createRes.body);

const badRes = fakeRes();
await httpRoutes.get("/worktree-flow/create").handler(fakeReq("POST", "/worktree-flow/create", { set: "demo", intent: {} }), badRes);
check("POST /create without branch is a 400 with stable code", badRes.status === 400 && badRes.json().code === "BAD_BRANCH", badRes.body);

const missingSetRes = fakeRes();
await httpRoutes.get("/worktree-flow/config").handler(fakeReq("GET", "/worktree-flow/config?set=nope"), missingSetRes);
check("GET /config for unknown set is a 400 NO_SET", missingSetRes.status === 400 && missingSetRes.json().code === "NO_SET", missingSetRes.body);

const crossSite = fakeRes();
const crossReq = fakeReq("POST", "/worktree-flow/cleanup", { set: "demo", feature: "selection-v2", force: true });
crossReq.headers = { host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" };
await httpRoutes.get("/worktree-flow/cleanup").handler(crossReq, crossSite);
check("cross-site browser request is rejected with 403", crossSite.status === 403, crossSite.body);

const rebind = fakeRes();
const rebindReq = fakeReq("GET", "/worktree-flow/sets");
rebindReq.headers = { host: "attacker.example.com" };
await httpRoutes.get("/worktree-flow/sets").handler(rebindReq, rebind);
check("foreign Host (DNS rebinding) is rejected with 403", rebind.status === 403, rebind.body);

console.log("context note");
const preStep = eventListeners.get("agent/pre-step");
check("agent/pre-step hook registered", typeof preStep === "function");
const featureRootForNote = join(worktreeRoot, "demo", "selection-v2");
const noteAgent = { session: { id: "s-note", header: { cwd: featureRootForNote } } };
const nextEnter = async () => ({ kind: "enter", messages: [] });
const noted = await preStep({ agent: noteAgent, signal: new AbortController().signal }, nextEnter);
check("first step in a feature root injects the identity note", noted.messages.length === 1 && noted.messages[0].content[0].text.includes("demo/selection-v2") && noted.messages[0].content[0].text.includes("backend"), JSON.stringify(noted.messages));
check("note resolves the component display name from the set config", noted.messages[0].content[0].text.includes("backend（后端）"), JSON.stringify(noted.messages));
check("note carries plugin provenance", noted.messages[0]?.source?.plugin === "worktree-flow" && noted.messages[0]?.role === "user");
const notedTwice = await preStep({ agent: noteAgent, signal: new AbortController().signal }, nextEnter);
check("note fires once per session", notedTwice.messages.length === 0);
const outside = await preStep({ agent: { session: { id: "s-out", header: { cwd: repoRoot } } }, signal: new AbortController().signal }, nextEnter);
check("cwd outside any feature workspace gets no note", outside.messages.length === 0);

console.log(failed === 0 ? "\nLOAD TEST PASSED" : `\nLOAD TEST FAILED (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
