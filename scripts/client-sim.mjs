// @ts-check
/**
 * Client bundle simulation boot: no browser — run the full client lifecycle
 * in Node.
 *   1) vm-execute the bundle, stubbing window.__ModuleLoader__.load
 *   2) materialize the factory with REAL react from the profile's shared
 *      node_modules
 *   3) apply() against a mock ctx.slots with deferred slot declaration
 *   4) ReactDOMServer.renderToString the registered section component
 *
 * Any throw anywhere fails the sim — this is the minimal reproduction of
 * "crashes on startup".
 *
 * Run: node scripts/client-sim.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import os from "node:os";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const dshHome = process.env.DSH_HOME ?? join(os.homedir(), ".dsh");
const profileRequire = createRequire(join(dshHome, "profiles", "package.json"));
const React = profileRequire("react");
const jsxRuntime = profileRequire("react/jsx-runtime");
const ReactDOMServer = profileRequire("react-dom/server");

let failures = 0;
function check(label, fn) {
	try {
		fn();
		console.log("PASS:", label);
	} catch (error) {
		failures += 1;
		console.error("FAIL:", label, "-", error instanceof Error ? error.message : error);
	}
}

// ---- 1) execute bundle, capture handoff ----
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
const handoffs = [];
const sandbox = {
	window: { __ModuleLoader__: { load: (handoff) => handoffs.push(handoff) } },
	console
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });
check("bundle registers exactly one handoff with id dsh-worktree-flow", () => {
	if (handoffs.length !== 1) throw new Error(`handoffs: ${handoffs.length}`);
	if (handoffs[0].id !== "dsh-worktree-flow") throw new Error(`id: ${handoffs[0].id}`);
	if (typeof handoffs[0].factory !== "function") throw new Error("factory missing");
});
check("bundle includes project/feature instructions and shared docs controls", () => {
	for (const marker of ["项目会话说明", "projectInstructions", "功能区会话说明（可选）", "功能区会话说明", "保存说明", "/feature-instructions", "共享 docs 源目录", "sessionInstructions", "sharedDocsPath"]) {
		if (!source.includes(marker)) throw new Error(`missing marker: ${marker}`);
	}
});

// ---- 2) materialize factory (require whitelist = the shell's resolution boundary) ----
const plugin = handoffs[0].factory((spec) => {
	if (spec === "react") return React;
	if (spec === "react/jsx-runtime") return jsxRuntime;
	throw new Error(`unexpected require: ${spec}`);
});
check("exports apply/inject shape", () => {
	if (typeof plugin.apply !== "function") throw new Error("apply missing");
	if (!Array.isArray(plugin.inject)) throw new Error("inject missing");
	if (plugin.inject.join(",") !== "slots,workspaces") throw new Error(`inject: ${JSON.stringify(plugin.inject)}`);
});

// ---- 3) apply against mock ctx.slots (deferred declaration) ----
let registered = null;
const registrations = new Map();
const injectWaiters = [];
const declaredSlots = new Set();
const mockCtx = {
	slots: {
		inject(key, callback) {
			if (declaredSlots.has(key)) callback();
			else injectWaiters.push({ key, callback });
			return () => {};
		},
		register(options, component) {
			if (!declaredSlots.has(options.name)) throw new Error(`slot "${options.name}" is not declared yet`);
			registered = { options, component };
			registrations.set(`${options.name}:${options.id ?? "single"}`, { options, component });
			return () => {};
		}
	}
};
const declare = (key) => {
	declaredSlots.add(key);
	for (const waiter of injectWaiters.splice(0)) {
		if (declaredSlots.has(waiter.key)) waiter.callback();
		else injectWaiters.push(waiter);
	}
};

check("apply() defers until the slot is declared", () => {
	plugin.apply(mockCtx);
	if (registered !== null) throw new Error("register should have been deferred");
});
check("registration completes once settings.section is declared", () => {
	declare("settings.section");
	if (registered === null) throw new Error("register never ran");
	if (registered.options.id !== "worktree-flow") throw new Error(`entry id: ${registered.options.id}`);
	if (registered.options.name !== "settings.section") throw new Error(`slot: ${registered.options.name}`);
	if (typeof registered.options.label !== "string" && typeof registered.options.label !== "function") throw new Error("label missing");
	if (typeof registered.options.inject !== "function") throw new Error("settings inject missing");
	if (typeof registered.options.inject().pickProjectDirectory !== "function") throw new Error("directory picker injection missing");
});

check("session badge with instructions popover + alert dock register into the conversation slots", () => {
	declare("conversation.session.header.actions");
	declare("conversation.input.dock");
	const badge = registrations.get("conversation.session.header.actions:worktree-flow-badge");
	const dock = registrations.get("conversation.input.dock:worktree-flow-alert");
	if (badge === undefined) throw new Error("header badge not registered");
	if (dock === undefined) throw new Error("input dock not registered");
	// Non-feature cwd → both render null (quiet by default).
	const kit = { sessionId: "s1", useSessions: (selector) => selector({ byId: {} }) };
	if (ReactDOMServer.renderToString(React.createElement(badge.component, kit)) !== "") throw new Error("badge should render nothing without a feature cwd");
	if (ReactDOMServer.renderToString(React.createElement(dock.component, kit)) !== "") throw new Error("dock should render nothing without alerts");
});

// ---- 4) real SSR render of the section (initial state, no network) ----
check("section renders two primary tabs and the set config chapter", () => {
	const section = registrations.get("settings.section:worktree-flow");
	if (section === undefined) throw new Error("settings.section entry missing");
	const html = ReactDOMServer.renderToString(React.createElement(section.component, { close: () => {} }));
	if (typeof html !== "string" || html.length === 0) throw new Error("empty render");
	for (const label of ["配置", "功能工作区", "仓库组配置", "+ 新建仓库组", "新仓库组模板", "还没有仓库组", "分支类型"]) {
		if (!html.includes(label)) throw new Error(`missing label: ${label}`);
	}
});

console.log(failures === 0 ? "CLIENT SIM PASSED" : `CLIENT SIM FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
