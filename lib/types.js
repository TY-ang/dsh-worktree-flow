// @ts-check
/**
 * dsh-worktree-flow types: shared JSDoc shapes (no runtime code).
 *
 * @module dsh-worktree-flow/types
 */

/**
 * The slice of the dsh-workspace `Workspace` entity this plugin uses.
 * @typedef {object} WorkspaceLike
 * @property {string} id
 * @property {string} path
 * @property {string} title
 * @property {readonly string[]} sessionIds
 * @property {(title: string) => Promise<void>} setTitle
 * @property {() => Promise<"ok" | "missing-dir">} status
 */

/**
 * The slice of the dsh-workspace `WorkspaceRegistry` service this plugin
 * uses (fetched with `ctx.get("workspaceRegistry")`).
 * @typedef {object} WorkspaceRegistryLike
 * @property {(path: string, title?: string) => Promise<WorkspaceLike>} create
 * @property {(path: string) => Promise<WorkspaceLike | undefined>} resolveByPath
 * @property {(id: string) => Promise<boolean>} delete
 * @property {() => readonly WorkspaceLike[]} list
 */

export {};
