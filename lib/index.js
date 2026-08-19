// @ts-check
/**
 * dsh-worktree-flow — multi-repository feature worktree orchestration for
 * DeepSeek Harness.
 *
 * What this plugin gives a DSH profile:
 *
 * 1. Feature workspaces: one feature/version = one directory holding a git
 *    worktree per component repository, all on one shared feature branch.
 * 2. The feature root is registered in `ctx.workspaceRegistry`, so the DSH
 *    sidebar and the New-Session workspace picker offer it; a session created
 *    there is sandbox-rooted at the feature root and can safely edit every
 *    component in one session.
 * 3. `/worktree` command family (create | status | sync | open | finish |
 *    config) as the scriptable fallback of the settings page.
 * 4. Named workspace SETS stored centrally at `$DSH_HOME/worktree-flow/sets/
 *    <name>.json` — no config lives inside any repository; component paths
 *    are explicit. Feature manifests use `.dsh-worktree.json` with read-only
 *    fallback to the Pi-era name plus sync-time migration.
 *
 * Shape note: `subprocess` is a hard inject; `commands` arrives through a
 * nested fiber so the service still loads in command-less compositions;
 * `workspaceRegistry` is optional and fetched per call with `ctx.get`.
 *
 * @module dsh-worktree-flow
 */
import { WorktreeFlowService } from "./service.js";
import { registerCommands } from "./commands.js";
import { registerHttp } from "./http.js";
import { registerContextNote } from "./context-note.js";

const name = "worktree-flow";
const inject = ["subprocess"];

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
function apply(ctx) {
	const service = new WorktreeFlowService(ctx);
	ctx.provide("worktreeFlow", service);
	registerCommands(ctx, service);
	registerHttp(ctx, service);
	registerContextNote(ctx, name);
	// Startup retitle pass: repairs titles left by older title conventions
	// once the registry is active. It may start later than us — poll a few
	// times, then give up quietly (the next create/sync also repairs titles).
	let attempts = 0;
	const lifecycle = new AbortController();
	const retitle = setInterval(() => {
		attempts += 1;
		if (ctx.get("workspaceRegistry") === undefined || attempts > 15) {
			if (attempts > 15) clearInterval(retitle);
			return;
		}
		clearInterval(retitle);
		service.retitleRegistered({ signal: lifecycle.signal }).catch(() => undefined);
	}, 2000);
	retitle.unref?.();
	const dispose = () => { clearInterval(retitle); lifecycle.abort(); };
	if (typeof ctx.effect === "function") ctx.effect(() => dispose);
	else ctx.on("dispose", dispose);
	ctx.logger(name).info("dsh-worktree-flow loaded (service + /worktree + /worktree-flow/* + context note)");
}

export { apply, inject, name, WorktreeFlowService };
