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
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { writeFeatureContext } from "../lib/feature-context.js";

const commands = new Map();
const spawned = [];
const workspaces = new Map();
const httpRoutes = new Map();
const eventListeners = new Map();
const modelTools = new Map();
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
function answerGit(argv, cwd) {
	const joined = argv.join(" ");
	if (joined === "git rev-parse --show-toplevel") return { exitCode: 0, stdout: cwd };
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

function versionOf(stat) {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

const fakeFs = {
	async resolve(filePath, options = {}) {
		if (options.signal?.aborted) throw options.signal.reason;
		const absolute = path.resolve(options.cwd ?? process.cwd(), filePath);
		return { targetKey: absolute, displayPath: absolute };
	},
	contains(parent, child) {
		const rel = path.relative(parent.targetKey, child.targetKey);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	},
	async stat(target) {
		const stat = await fs.promises.stat(target.targetKey).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
		if (stat === undefined) return undefined;
		return { version: versionOf(stat), type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other", size: stat.isFile() ? stat.size : undefined };
	},
	async readText(target) { return fs.promises.readFile(target.targetKey, "utf8"); },
	async writeText(target, content, intent) {
		const beforeStat = await this.stat(target);
		if (intent?.kind === "createIfAbsent" && beforeStat !== undefined) throw new Error("stale create");
		if (intent?.kind === "replaceIfVersion" && beforeStat?.version !== intent.version) throw new Error("stale replace");
		const before = beforeStat === undefined ? null : await this.readText(target);
		await fs.promises.writeFile(target.targetKey, content, "utf8");
		return { operation: beforeStat === undefined ? "create" : "update", version: versionOf(await fs.promises.stat(target.targetKey)), before, after: content };
	},
	async editText(target, edit, expected) {
		const stat = await this.stat(target);
		if (stat === undefined || (expected !== undefined && stat.version !== expected.version)) throw new Error("stale edit");
		const before = await this.readText(target);
		const count = before.split(edit.oldString).length - 1;
		if (count === 0 || (!edit.replaceAll && count !== 1)) throw new Error("bad edit");
		const after = edit.replaceAll ? before.split(edit.oldString).join(edit.newString) : before.replace(edit.oldString, edit.newString);
		await fs.promises.writeFile(target.targetKey, after, "utf8");
		return { version: versionOf(await fs.promises.stat(target.targetKey)), before, after };
	}
};

const ctx = {
	subprocess: {
		spawn(spec) {
			spawned.push(spec);
			const answer = answerGit(spec.argv, spec.cwd);
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
	fs: fakeFs,
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
	tools: {
		register(definition) {
			if (modelTools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
			modelTools.set(definition.name, definition);
			return () => modelTools.delete(definition.name);
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
check("scoped shared docs write/edit tools registered", modelTools.has("worktree_docs_write") && modelTools.has("worktree_docs_edit"));

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
const reopened = await worktree.handler(invocation("open selection-v2"));
check("open re-registers an archived feature explicitly", reopened.kind === "success" && fakeRegistry.list().length === 1, reopened.text);

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
	req.headers = method === "POST"
		? {
			host: "127.0.0.1:3080",
			origin: "http://127.0.0.1:3080",
			"sec-fetch-site": "same-origin",
			"content-type": "application/json",
			"x-worktree-flow-request": "1"
		}
		: { host: "127.0.0.1:3080" };
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
const sharedDocsRoot = join(fixture, "shared-docs");
mkdirSync(sharedDocsRoot, { recursive: true });
writeFileSync(join(sharedDocsRoot, "guide.md"), "guide\n");
const configWrite = fakeRes();
await httpRoutes.get("/worktree-flow/config").handler(fakeReq("POST", "/worktree-flow/config", {
	set: "demo",
	config: { ...configRes.json().config, sharedDocsPath: sharedDocsRoot, projectInstructions: "项目统一使用 UTC 时间，并先阅读共享 docs。" },
	revision: configRes.json().revision
}), configWrite);
check("POST /config persists sharedDocsPath", configWrite.status === 200, configWrite.body);
const configWithDocs = fakeRes();
await httpRoutes.get("/worktree-flow/config").handler(fakeReq("GET", "/worktree-flow/config?set=demo"), configWithDocs);
check("GET /config round-trips sharedDocsPath", configWithDocs.json().config.sharedDocsPath === sharedDocsRoot, configWithDocs.body);
check("GET /config round-trips project instructions", configWithDocs.json().config.projectInstructions === "项目统一使用 UTC 时间，并先阅读共享 docs。", configWithDocs.body);

const locateHit = fakeRes();
await httpRoutes.get("/worktree-flow/locate").handler(fakeReq("GET", `/worktree-flow/locate?cwd=${encodeURIComponent(join(worktreeRoot, "demo", "selection-v2", "backend"))}`), locateHit);
check("GET /locate maps a component dir to its feature", locateHit.status === 200 && locateHit.json().found === true && locateHit.json().set === "demo" && locateHit.json().feature.feature === "selection-v2", locateHit.body);
const locateMiss = fakeRes();
await httpRoutes.get("/worktree-flow/locate").handler(fakeReq("GET", `/worktree-flow/locate?cwd=${encodeURIComponent(fixture)}`), locateMiss);
check("GET /locate returns found:false outside any feature", locateMiss.status === 200 && locateMiss.json().found === false, locateMiss.body);

const templateRes = fakeRes();
await httpRoutes.get("/worktree-flow/template").handler(fakeReq("GET", "/worktree-flow/template"), templateRes);
check("GET /template returns JSON contract", templateRes.status === 200 && templateRes.json().ok === true && Object.hasOwn(templateRes.json(), "configured"), templateRes.body);
const templateWrite = fakeRes();
await httpRoutes.get("/worktree-flow/template").handler(fakeReq("POST", "/worktree-flow/template", {
	config: { worktreeRoot, defaultBaseBranch: "master", sharedDocsPath: sharedDocsRoot, repositories: {} }
}), templateWrite);
const templateAfterWrite = fakeRes();
await httpRoutes.get("/worktree-flow/template").handler(fakeReq("GET", "/worktree-flow/template"), templateAfterWrite);
check("template HTTP drops project-specific sharedDocsPath", templateWrite.status === 200 && !Object.hasOwn(templateAfterWrite.json().config, "sharedDocsPath"), templateAfterWrite.body);

const createRes = fakeRes();
await httpRoutes.get("/worktree-flow/create").handler(fakeReq("POST", "/worktree-flow/create", { set: "demo", intent: { feature: "http feat", components: ["backend"], branch: "feature/http-feat", sessionInstructions: "SQL 在 backend/sql/http-feat", dryRun: true } }), createRes);
check("POST /create dry-run returns plan", createRes.status === 200 && createRes.json().result.dryRun === true && createRes.json().result.feature === "http-feat", createRes.body);
check("POST /create preserves feature instruction intent", createRes.json().result.context.hasInstructions === true && createRes.json().result.context.instructionBytes > 0, createRes.body);

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

const localPort = fakeRes();
const localPortReq = fakeReq("POST", "/worktree-flow/cleanup", { set: "demo", feature: "selection-v2", force: true });
localPortReq.headers = {
	host: "127.0.0.1:3080",
	origin: "http://127.0.0.1:9999",
	"sec-fetch-site": "same-site",
	"content-type": "text/plain"
};
await httpRoutes.get("/worktree-flow/cleanup").handler(localPortReq, localPort);
check("different localhost port simple POST is rejected", localPort.status === 403, localPort.body);

const wrongMethod = fakeRes();
await httpRoutes.get("/worktree-flow/cleanup").handler(fakeReq("GET", "/worktree-flow/cleanup"), wrongMethod);
check("destructive route rejects the wrong method", wrongMethod.status === 405, wrongMethod.body);

const emptyFeature = fakeRes();
await httpRoutes.get("/worktree-flow/register").handler(fakeReq("POST", "/worktree-flow/register", { set: "demo", feature: "纯中文" }), emptyFeature);
check("register rejects a feature that slugifies empty", emptyFeature.status === 400 && emptyFeature.json().code === "BAD_FEATURE", emptyFeature.body);

const staleConfig = fakeRes();
await httpRoutes.get("/worktree-flow/config").handler(fakeReq("POST", "/worktree-flow/config", {
	set: "demo",
	config: configRes.json().config,
	revision: "stale"
}), staleConfig);
check("config save rejects a stale revision", staleConfig.status === 400 && staleConfig.json().code === "CONFIG_CONFLICT", staleConfig.body);

console.log("context note");
const preStep = eventListeners.get("agent/pre-step");
check("agent/pre-step hook registered", typeof preStep === "function");
const featureRootForNote = join(worktreeRoot, "demo", "selection-v2");
await writeFeatureContext({
	version: 1,
	projectName: "demo",
	feature: "selection-v2",
	sessionInstructions: "本分支 SQL 放在 backend/sql/selection-v2。",
	createdAt: new Date().toISOString()
}, featureRootForNote);
const featureInstructionsGet = fakeRes();
await httpRoutes.get("/worktree-flow/feature-instructions").handler(fakeReq("GET", `/worktree-flow/feature-instructions?set=demo&feature=selection-v2`), featureInstructionsGet);
check("GET /feature-instructions returns trusted feature guidance", featureInstructionsGet.status === 200 && featureInstructionsGet.json().result.sessionInstructions.includes("backend/sql/selection-v2"), featureInstructionsGet.body);
const featureInstructionsSave = fakeRes();
await httpRoutes.get("/worktree-flow/feature-instructions").handler(fakeReq("POST", "/worktree-flow/feature-instructions", {
	set: "demo",
	feature: "selection-v2",
	sessionInstructions: "编辑后的功能区说明：SQL 在 backend/sql/selection-v3。"
}), featureInstructionsSave);
check("POST /feature-instructions updates trusted feature guidance", featureInstructionsSave.status === 200 && featureInstructionsSave.json().result.sessionInstructions.includes("selection-v3"), featureInstructionsSave.body);
const noteManifestFile = join(featureRootForNote, ".dsh-worktree.json");
const creatingManifest = JSON.parse(readFileSync(noteManifestFile, "utf8"));
creatingManifest.status = "creating";
writeFileSync(noteManifestFile, JSON.stringify(creatingManifest));
const creatingAgent = { session: { id: "s-creating", header: { cwd: featureRootForNote } } };
const nextEnter = async () => ({ kind: "enter", messages: [] });
const whileCreating = await preStep({ agent: creatingAgent, signal: new AbortController().signal }, nextEnter);
check("creating feature does not consume first-step context", whileCreating.messages.length === 0);
creatingManifest.status = "ready";
writeFileSync(noteManifestFile, JSON.stringify(creatingManifest));
const afterReady = await preStep({ agent: creatingAgent, signal: new AbortController().signal }, nextEnter);
check("same session receives context after feature becomes ready", afterReady.messages.length === 1 && afterReady.messages[0].content[0].text.includes("demo/selection-v2"), JSON.stringify(afterReady.messages));
const noteAgent = { session: { id: "s-note", header: { cwd: featureRootForNote } } };
const noted = await preStep({ agent: noteAgent, signal: new AbortController().signal }, nextEnter);
check("first step in a feature root injects the identity note", noted.messages.length === 1 && noted.messages[0].content[0].text.includes("demo/selection-v2") && noted.messages[0].content[0].text.includes("backend"), JSON.stringify(noted.messages));
check("note resolves the component display name from the set config", noted.messages[0].content[0].text.includes("backend（后端）"), JSON.stringify(noted.messages));
check("note injects live project instructions", noted.messages[0].content[0].text.includes("项目统一使用 UTC 时间，并先阅读共享 docs。") && noted.messages[0].content[0].text.includes("项目会话说明"), JSON.stringify(noted.messages));
check("note injects edited trusted feature-specific instructions", noted.messages[0].content[0].text.includes("编辑后的功能区说明：SQL 在 backend/sql/selection-v3。") && noted.messages[0].content[0].text.includes("功能区自定义说明"), JSON.stringify(noted.messages));
check("note injects the live shared docs source", noted.messages[0].content[0].text.includes(`项目共享 docs 原始目录：${sharedDocsRoot}`) && noted.messages[0].content[0].text.includes("worktree_docs_edit"), JSON.stringify(noted.messages));
const docsExec = { agent: { session: { header: { cwd: featureRootForNote } } } };
const docsWritten = await modelTools.get("worktree_docs_write").execute({ path: "guide.md", content: "live docs\n" }, docsExec);
check("shared docs write tool updates the original directory", docsWritten.created === false && readFileSync(join(sharedDocsRoot, "guide.md"), "utf8") === "live docs\n", JSON.stringify(docsWritten));
const docsEdited = await modelTools.get("worktree_docs_edit").execute({ path: "guide.md", old_string: "live", new_string: "shared" }, docsExec);
check("shared docs edit tool updates the same original file", docsEdited.replacements === 1 && readFileSync(join(sharedDocsRoot, "guide.md"), "utf8") === "shared docs\n", JSON.stringify(docsEdited));
mkdirSync(join(sharedDocsRoot, "design"));
const nestedDocs = await modelTools.get("worktree_docs_write").execute({ path: "design/new.md", content: "new\n" }, docsExec);
check("shared docs write tool creates a file in an existing subdirectory", nestedDocs.created === true && readFileSync(join(sharedDocsRoot, "design", "new.md"), "utf8") === "new\n", JSON.stringify(nestedDocs));
let traversalRejected = false;
try {
	await modelTools.get("worktree_docs_write").execute({ path: "../escape.md", content: "no" }, docsExec);
} catch (error) {
	traversalRejected = error?.code === "BAD_DOCS_PATH";
}
check("shared docs tools reject traversal outside the configured root", traversalRejected);
let outsideFeatureRejected = false;
try {
	await modelTools.get("worktree_docs_write").execute({ path: "guide.md", content: "no" }, { agent: { session: { header: { cwd: repoRoot } } } });
} catch (error) {
	outsideFeatureRejected = error?.code === "NO_FEATURE";
}
check("shared docs tools reject sessions outside a feature workspace", outsideFeatureRejected);
check("note carries plugin provenance", noted.messages[0]?.source?.plugin === "worktree-flow" && noted.messages[0]?.role === "user");
const notedTwice = await preStep({ agent: noteAgent, signal: new AbortController().signal }, nextEnter);
check("note fires once per session", notedTwice.messages.length === 0);
const projectPromptUpdate = fakeRes();
await httpRoutes.get("/worktree-flow/config").handler(fakeReq("POST", "/worktree-flow/config", {
	set: "demo",
	config: { ...configWithDocs.json().config, projectInstructions: "更新后的项目说明只影响之后的新会话。" },
	revision: configWithDocs.json().revision
}), projectPromptUpdate);
const updatedProjectAgent = { session: { id: "s-project-updated", header: { cwd: featureRootForNote } } };
const updatedProjectNote = await preStep({ agent: updatedProjectAgent, signal: new AbortController().signal }, nextEnter);
check("existing feature sessions read the latest project instructions", projectPromptUpdate.status === 200 && updatedProjectNote.messages[0].content[0].text.includes("更新后的项目说明只影响之后的新会话。") && !updatedProjectNote.messages[0].content[0].text.includes("项目统一使用 UTC 时间"), JSON.stringify(updatedProjectNote.messages));
writeFileSync(join(repoRoot, ".dsh-worktree.json"), JSON.stringify({
	version: 1,
	projectName: "demo",
	feature: "forged",
	root: repoRoot,
	sourceCwd: "",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	status: "ready",
	components: {}
}));
const outside = await preStep({ agent: { session: { id: "s-out", header: { cwd: repoRoot } } }, signal: new AbortController().signal }, nextEnter);
check("forged manifest outside configured feature layout injects no note", outside.messages.length === 0);

console.log(failed === 0 ? "\nLOAD TEST PASSED" : `\nLOAD TEST FAILED (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
