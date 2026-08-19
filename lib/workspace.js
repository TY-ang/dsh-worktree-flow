// @ts-check
/**
 * dsh-worktree-flow workspace: git worktree operations over ctx.subprocess.
 * Framework-light: only needs a ctx carrying `ctx.subprocess`, which keeps
 * the git logic testable without booting a DSH profile (see test/).
 *
 * @module dsh-worktree-flow/workspace
 */
import fs from "node:fs";
import path from "node:path";
import { WorktreeFlowError, canonical } from "./core.js";

const GIT_COLLECT_BYTES = 1 << 20;
const GIT_GRACE_MS = 30_000;

/**
 * Run one git command through ctx.subprocess. Never shell-interpreted; argv
 * is passed verbatim. Returns collected stdout/stderr; does NOT throw on
 * non-zero exit (callers switch on exitCode).
 */
export async function git(ctx, argv, cwd, signal) {
	const handle = ctx.subprocess.spawn({
		argv: ["git", ...argv],
		cwd,
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: GIT_COLLECT_BYTES },
			stderr: { maxBytes: GIT_COLLECT_BYTES }
		},
		graceMs: GIT_GRACE_MS,
		signal
	});
	const outcome = await handle.done;
	return {
		exitCode: outcome.exitCode,
		signal: outcome.signal,
		stdout: (handle.collected.stdout?.readFrom(0).text ?? "").trim(),
		stderr: (handle.collected.stderr?.readFrom(0).text ?? "").trim()
	};
}

/** Git that must succeed: throws WorktreeFlowError(GIT) otherwise. */
async function mustGit(ctx, argv, cwd, signal, what) {
	const result = await git(ctx, argv, cwd, signal);
	if (result.exitCode !== 0) {
		throw new WorktreeFlowError("GIT", `${what} 失败：${result.stderr || `exit ${result.exitCode}`}`);
	}
	return result.stdout;
}

async function pathExists(p) {
	try {
		await fs.promises.stat(p);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/** The repository root containing `cwd`, or undefined when not in a repo. */
export async function repoRootOf(ctx, cwd, signal) {
	const result = await git(ctx, ["rev-parse", "--show-toplevel"], cwd, signal);
	// git prints forward slashes on Windows; store host-native spellings.
	return result.exitCode === 0 ? path.normalize(result.stdout) : undefined;
}

/**
 * The MAIN repository root when `cwd` sits inside a linked worktree (the
 * common git dir lives under the main clone's .git). Falls back to the
 * toplevel for ordinary repos.
 */
export async function mainRepoRootOf(ctx, cwd, signal) {
	const common = await git(ctx, ["rev-parse", "--git-common-dir"], cwd, signal);
	if (common.exitCode !== 0) return repoRootOf(ctx, cwd, signal);
	// --git-common-dir may be relative to cwd.
	const commonAbs = path.isAbsolute(common.stdout) ? common.stdout : path.resolve(cwd, common.stdout);
	// <main>/.git  →  <main>
	return path.normalize(path.dirname(commonAbs));
}

/**
 * @typedef {object} GitWorktreeEntry
 * @property {string} path - worktree directory (git's own spelling).
 * @property {string} [head]
 * @property {string} [branch] - short branch name; undefined when detached.
 * @property {boolean} bare
 */

/**
 * Parse `git worktree list --porcelain` output.
 * @param {string} text
 * @returns {GitWorktreeEntry[]}
 */
export function parseWorktreeList(text) {
	/** @type {GitWorktreeEntry[]} */
	const entries = [];
	/** @type {Partial<GitWorktreeEntry> | undefined} */
	let current;
	for (const line of text.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current?.path !== undefined) entries.push(/** @type {GitWorktreeEntry} */ (current));
			current = { path: path.normalize(line.slice("worktree ".length)), bare: false };
		} else if (current !== undefined) {
			if (line.startsWith("HEAD ")) current.head = line.slice(5);
			else if (line.startsWith("branch ")) current.branch = line.slice("branch refs/heads/".length);
			else if (line === "bare") current.bare = true;
			else if (line === "detached") current.branch = undefined;
		}
	}
	if (current?.path !== undefined) entries.push(/** @type {GitWorktreeEntry} */ (current));
	return entries;
}

/** @returns {Promise<GitWorktreeEntry[]>} */
export async function listGitWorktrees(ctx, repoPath, signal) {
	const text = await mustGit(ctx, ["worktree", "list", "--porcelain"], repoPath, signal, "git worktree list");
	return parseWorktreeList(text);
}

/** Whether a local branch exists in the repo. */
export async function branchExists(ctx, repoPath, branch, signal) {
	const result = await git(ctx, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath, signal);
	return result.exitCode === 0;
}

/**
 * Resolve the base ref to branch from: local branch, else origin/<base>.
 * Returns undefined when neither exists (caller decides the error text).
 */
export async function resolveBaseRef(ctx, repoPath, baseBranch, signal) {
	if (await branchExists(ctx, repoPath, baseBranch, signal)) return baseBranch;
	const remote = await git(ctx, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`], repoPath, signal);
	if (remote.exitCode === 0) return `origin/${baseBranch}`;
	return undefined;
}

/**
 * Create one linked component worktree.
 *
 * Semantics (fail-safe):
 * - target exists on disk: reuse ONLY when git already registers it for this
 *   repo on the same branch (state `existing`); otherwise refuse.
 * - branch exists: `git worktree add <target> <branch>`; else
 *   `git worktree add -b <branch> <target> <baseRef>`.
 *
 * @param {object} ctx
 * @param {{repoPath: string, targetPath: string, branch: string, baseBranch: string, signal?: AbortSignal}} params
 * @returns {Promise<{state: "created"|"existing", path: string, branch: string}>}
 */
export async function createLinkedWorktree(ctx, params) {
	const { repoPath, targetPath, branch, baseBranch, signal } = params;
	if (await pathExists(targetPath)) {
		const worktrees = await listGitWorktrees(ctx, repoPath, signal);
		const match = worktrees.find((entry) => canonical(entry.path) === canonical(targetPath));
		if (match !== undefined && match.branch === branch) {
			return { state: "existing", path: targetPath, branch };
		}
		throw new WorktreeFlowError(
			"TARGET_EXISTS",
			match === undefined
				? `目标目录已存在且不是本仓库的 worktree：${targetPath}（拒绝接管，请人工处理）`
				: `目标目录已是 worktree 但分支为 ${match.branch ?? "detached"}，期望 ${branch}：${targetPath}`
		);
	}
	await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
	if (await branchExists(ctx, repoPath, branch, signal)) {
		await mustGit(ctx, ["worktree", "add", targetPath, branch], repoPath, signal, `git worktree add ${branch}`);
	} else {
		const baseRef = await resolveBaseRef(ctx, repoPath, baseBranch, signal);
		if (baseRef === undefined) {
			throw new WorktreeFlowError("NO_BASE", `基准分支不存在：${baseBranch}（本地与 origin 都没有）`);
		}
		await mustGit(ctx, ["worktree", "add", "-b", branch, targetPath, baseRef], repoPath, signal, `git worktree add -b ${branch}`);
	}
	return { state: "created", path: targetPath, branch };
}

/**
 * @typedef {object} ComponentGitStatus
 * @property {boolean} present - directory exists on disk.
 * @property {string} [branch] - actual checked-out branch.
 * @property {number} [changed] - `git status --porcelain` line count.
 * @property {number} [ahead] - commits ahead of base.
 * @property {number} [behind] - commits behind base.
 * @property {number} [unpushed] - commits not on any remote (or ahead of upstream).
 * @property {boolean} [branchMismatch] - actual branch ≠ expected branch.
 * @property {string} [readError] - one or more safety-relevant git reads failed.
 */

/**
 * Per-component git status: branch, dirty count, ahead/behind vs base, and
 * unpushed-commit count. All failures degrade to undefined fields rather
 * than throwing (a half-broken worktree must still render in status views).
 * @param {object} ctx
 * @param {{path: string, expectedBranch: string, baseBranch: string, signal?: AbortSignal}} params
 * @returns {Promise<ComponentGitStatus>}
 */
export async function componentGitStatus(ctx, params) {
	const { path: dir, expectedBranch, baseBranch, signal } = params;
	if (!(await pathExists(dir))) return { present: false };
	const errors = [];

	const branchResult = await git(ctx, ["branch", "--show-current"], dir, signal);
	const branch = branchResult.exitCode === 0 && branchResult.stdout !== "" ? branchResult.stdout : undefined;
	if (branch === undefined) errors.push(`无法读取当前分支：${branchResult.stderr || `exit ${branchResult.exitCode}`}`);

	const statusResult = await git(ctx, ["status", "--porcelain"], dir, signal);
	const changed = statusResult.exitCode === 0
		? statusResult.stdout.split("\n").filter((line) => line.trim() !== "").length
		: undefined;
	if (changed === undefined) errors.push(`无法读取工作区状态：${statusResult.stderr || `exit ${statusResult.exitCode}`}`);

	/** @type {number | undefined} */
	let ahead;
	/** @type {number | undefined} */
	let behind;
	const baseRef = await resolveBaseRef(ctx, dir, baseBranch, signal);
	if (baseRef !== undefined) {
		const counts = await git(ctx, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`], dir, signal);
		if (counts.exitCode === 0) {
			const [behindText, aheadText] = counts.stdout.split(/\s+/u);
			behind = Number.parseInt(behindText, 10);
			ahead = Number.parseInt(aheadText, 10);
			if (!Number.isFinite(behind) || !Number.isFinite(ahead)) errors.push("无法解析领先/落后提交数");
		} else {
			errors.push(`无法读取领先/落后提交数：${counts.stderr || `exit ${counts.exitCode}`}`);
		}
	} else {
		errors.push(`基准分支不可解析：${baseBranch}`);
	}

	/** @type {number | undefined} */
	let unpushed;
	const upstream = await git(ctx, ["rev-list", "--count", "@{upstream}..HEAD"], dir, signal);
	if (upstream.exitCode === 0) {
		unpushed = Number.parseInt(upstream.stdout, 10);
	} else {
		const argv = baseRef !== undefined
			? ["rev-list", "--count", `${baseRef}..HEAD`, "--not", "--remotes"]
			: ["rev-list", "--count", "HEAD", "--not", "--remotes"];
		const local = await git(ctx, argv, dir, signal);
		if (local.exitCode === 0) unpushed = Number.parseInt(local.stdout, 10);
		else errors.push(`无法读取未推送提交数：${local.stderr || `exit ${local.exitCode}`}`);
	}
	if (unpushed !== undefined && !Number.isFinite(unpushed)) {
		unpushed = undefined;
		errors.push("无法解析未推送提交数");
	}

	return {
		present: true,
		branch,
		changed,
		ahead,
		behind,
		unpushed,
		branchMismatch: branch !== undefined && branch !== expectedBranch,
		...(errors.length > 0 ? { readError: errors.join("；") } : {})
	};
}

/**
 * Remove one component worktree. `force` is required when the tree is dirty
 * (mirrors git's own guard).
 * @param {object} ctx
 * @param {{repoPath: string, targetPath: string, force?: boolean, signal?: AbortSignal}} params
 */
export async function removeWorktree(ctx, params) {
	const { repoPath, targetPath, force = false, signal } = params;
	const argv = ["worktree", "remove", ...(force ? ["--force"] : []), targetPath];
	await mustGit(ctx, argv, repoPath, signal, `git worktree remove ${targetPath}`);
	// git worktree remove deletes the directory itself; sweep any leftovers.
	if (await pathExists(targetPath)) {
		await fs.promises.rm(targetPath, { recursive: true, force: true });
	}
}
