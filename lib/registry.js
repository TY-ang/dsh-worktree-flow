// @ts-check
/**
 * dsh-worktree-flow registry: the workspaceRegistry integration that makes
 * feature workspaces selectable in the sidebar and the New-Session picker.
 *
 * Semantics that matter (from dsh-workspace):
 * - create(path, title) is create-or-reuse by canonical path; an existing
 *   path returns the same entity WITHOUT changing its title — use setTitle
 *   to repair a stale title.
 * - delete(id) removes only the registry record: directories, files, and
 *   sessions are untouched; sessions fall back to Ungrouped. Re-registering
 *   later mints a NEW id and does NOT re-attach old sessions.
 *
 * The registry is optional: every helper degrades when the service is absent
 * (headless/test compositions).
 *
 * @module dsh-worktree-flow/registry
 */
import { featureTitle } from "./core.js";

/** @returns {import("./types.js").WorkspaceRegistryLike | undefined} */
function registryOf(ctx) {
	return ctx.get("workspaceRegistry");
}

/**
 * Register a directory as a DSH workspace (idempotent by path). Repairs the
 * title when the path was already registered under a stale one.
 * @param {object} ctx
 * @param {string} dir
 * @param {string} title
 * @returns {Promise<{state: "registered"|"retitled"|"exists"|"unavailable", id?: string}>}
 */
export async function registerWorkspace(ctx, dir, title) {
	const registry = registryOf(ctx);
	if (registry === undefined) return { state: "unavailable" };
	const workspace = await registry.create(dir, title);
	if (workspace.title !== title) {
		await workspace.setTitle(title);
		return { state: "retitled", id: workspace.id };
	}
	return { state: "registered", id: workspace.id };
}

/**
 * Register the feature root with the canonical `<project>/<feature>` title.
 * @param {object} ctx
 * @param {string} featureRoot
 * @param {string} projectName
 * @param {string} feature
 */
export async function registerFeature(ctx, featureRoot, projectName, feature) {
	return registerWorkspace(ctx, featureRoot, featureTitle(projectName, feature));
}

/**
 * Remove the workspace record for a directory (files and sessions untouched;
 * sessions fall back to Ungrouped).
 * @param {object} ctx
 * @param {string} dir
 * @returns {Promise<{state: "unregistered"|"absent"|"unavailable"}>}
 */
export async function unregisterWorkspace(ctx, dir) {
	const registry = registryOf(ctx);
	if (registry === undefined) return { state: "unavailable" };
	const workspace = await registry.resolveByPath(dir);
	if (workspace === undefined) return { state: "absent" };
	await registry.delete(workspace.id);
	return { state: "unregistered" };
}

/**
 * @typedef {object} RegistrationState
 * @property {"registered"|"unregistered"|"unavailable"} state
 * @property {string} [id]
 * @property {string} [title] - current title (may be stale/foreign).
 * @property {number} [sessionCount] - sessions grouped under this workspace.
 * @property {"ok"|"missing-dir"} [workspaceStatus]
 */

/**
 * Inspect the registration state of a directory.
 * @param {object} ctx
 * @param {string} dir
 * @returns {Promise<RegistrationState>}
 */
export async function registrationState(ctx, dir) {
	const registry = registryOf(ctx);
	if (registry === undefined) return { state: "unavailable" };
	const workspace = await registry.resolveByPath(dir);
	if (workspace === undefined) return { state: "unregistered" };
	return {
		state: "registered",
		id: workspace.id,
		title: workspace.title,
		sessionCount: workspace.sessionIds.length,
		workspaceStatus: await workspace.status()
	};
}
