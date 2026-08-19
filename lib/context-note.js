// @ts-check
/**
 * dsh-worktree-flow context note: once per session, when the session's
 * immutable cwd sits inside a known feature workspace (feature root or any
 * component dir), inject a short identity note into the agent's first step —
 * the layout, the feature branch, and the containment rule. This is what
 * makes "选对树" stick: the agent knows where it is without the user
 * declaring paths in every prompt.
 *
 * Mechanism mirrors dsh-worktree's proven hook: `agent/pre-step` with
 * prepend, per-session lookup cache, once-per-session announce set.
 *
 * @module dsh-worktree-flow/context-note
 */
import crypto from "node:crypto";
import path from "node:path";
import { readManifest } from "./manifest.js";
import { loadSet } from "./config.js";
import { isPathWithin } from "./core.js";

/**
 * Walk up from `cwd` (max 4 levels) to the nearest feature root carrying a
 * manifest; verifies containment so a stray manifest higher up the tree
 * never claims an unrelated cwd.
 * @param {string} cwd
 * @returns {Promise<import("./manifest.js").FeatureManifest | null>}
 */
export async function findManifestForCwd(cwd) {
	let dir = path.resolve(cwd);
	for (let depth = 0; depth < 4; depth += 1) {
		const loaded = await readManifest(dir).catch(() => undefined);
		if (loaded !== undefined && isPathWithin(loaded.manifest.root, cwd)) {
			return loaded.manifest;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Render the identity note. Component display names come from the live set
 * config first (so a later rename shows up), falling back to the manifest's
 * creation-time label snapshot — "后端" maps to the right directory.
 * @param {import("./manifest.js").FeatureManifest} manifest
 */
async function renderNote(manifest) {
	const archived = manifest.archived === true || manifest.status === "archived";
	const setConfig = await loadSet(manifest.projectName).catch(() => undefined);
	const lines = [
		`你在 worktree-flow 功能工作区「${manifest.projectName}/${manifest.feature}」中工作。${archived ? "（该功能已归档——目录仍在，确认用户是有意在此继续）" : ""}`,
		`  功能根目录（本会话沙箱根）：${manifest.root}`,
		`  功能分支：${Object.values(manifest.components)[0]?.branch ?? "(见各组件)"}`
	];
	lines.push("  组件 worktree：");
	for (const component of Object.values(manifest.components)) {
		if (component.state === "failed") continue;
		const label = setConfig?.repositories[component.name]?.label ?? component.label;
		const display = label !== undefined && label !== "" && label !== component.name ? `${component.name}（${label}）` : component.name;
		lines.push(`    ${display} → ${component.path}（来源 ${component.sourcePath}，基准 ${component.baseBranch}）`);
	}
	lines.push("  约束：所有读写留在功能根目录内；提交用 git -C <组件目录>；不要操作主工作树或其他功能目录；不要把组件目录当成同一仓库互相拷贝。");
	return lines.join("\n");
}

/**
 * @param {object} ctx
 * @param {string} pluginName
 */
export function registerContextNote(ctx, pluginName) {
	/** @type {Map<string, import("./manifest.js").FeatureManifest | null>} */
	const lookedUp = new Map();
	const announced = new Set();
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		const decision = await next();
		if (decision.kind !== "enter" || signal.aborted) return decision;
		const cwd = agent?.session?.header?.cwd;
		if (typeof cwd !== "string") return decision;
		const sessionId = String(agent.session.id);
		let manifest = lookedUp.get(sessionId);
		if (manifest === undefined) {
			manifest = await findManifestForCwd(cwd).catch(() => null);
			lookedUp.set(sessionId, manifest);
		}
		if (manifest === null || announced.has(sessionId)) return decision;
		announced.add(sessionId);
		const text = await renderNote(manifest);
		return {
			kind: "enter",
			messages: [...decision.messages, {
				id: crypto.randomUUID(),
				role: "user",
				content: [{ type: "text", text }],
				source: {
					kind: "plugin",
					plugin: pluginName,
					form: "snapshot",
					sections: [{ name: pluginName, text }]
				}
			}]
		};
	}, { prepend: true });
}
