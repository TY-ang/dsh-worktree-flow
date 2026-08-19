// @ts-check
/**
 * dsh-worktree-flow core: pure helpers. No ctx, no I/O — everything here is
 * deterministic and unit-testable.
 *
 * @module dsh-worktree-flow/core
 */
import path from "node:path";
import fs from "node:fs";

/** Feature slugs are one path segment and a safe branch suffix. */
export const FEATURE_SLUG_MAX = 64;

/**
 * Built-in branch-type vocabulary for the create wizard (类型 + 主题 → 完整
 * 分支名). Materialized to $DSH_HOME/worktree-flow/branch-types.json on first
 * read so the list becomes user-editable; "自定义" is UI-side only.
 */
export const DEFAULT_BRANCH_TYPES = [
	{ key: "bugfix", label: "Bugfix", prefix: "bugfix/" },
	{ key: "feature", label: "功能", prefix: "feature/" },
	{ key: "hotfix", label: "Hotfix", prefix: "hotfix/" },
	{ key: "release", label: "发布", prefix: "release/" }
];

/** Component names are one path segment: lowercase token, no separators. */
const COMPONENT_NAME = /^[a-z0-9][a-z0-9_-]*$/u;

/**
 * Windows reserved device names: they pass the token regex but mkdir/git
 * fail on them with obscure errors — reject up front.
 */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;

/**
 * Branch names that git rejects: control chars, space, and the punctuation
 * git check-ref-format forbids (kept deliberately conservative).
 */
const BRANCH_FORBIDDEN = /[\u0000-\u0020~^:?*[\]\\]/u;

/** A stable, machine-readable failure. `code` is safe to switch on. */
export class WorktreeFlowError extends Error {
	/**
	 * @param {string} code - stable error code, e.g. `NO_CONFIG`.
	 * @param {string} message - user-facing message.
	 */
	constructor(code, message, options) {
		super(message, options);
		this.name = "WorktreeFlowError";
		this.code = code;
	}
}

/**
 * Slugify a feature name into a path/branch-safe token.
 * Non-ascii (e.g. Chinese) characters are dropped; if nothing survives the
 * caller must ask for an explicit ascii name.
 * @param {string} input
 * @returns {string}
 */
export function slugifyFeature(input) {
	return input
		.toLowerCase()
		.replace(/[\s_]+/gu, "-")
		.replace(/[^a-z0-9-]+/gu, "")
		.replace(/-{2,}/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, FEATURE_SLUG_MAX)
		.replace(/-+$/u, "");
}

/**
 * Derive a feature slug from a full branch name: the last `/` segment,
 * slugified (`feature/selection-v2` → `selection-v2`). No fallback to the
 * whole branch — a topic-less branch must be fixed by the caller rather than
 * producing a nonsense directory like "feature".
 * @param {string} branch - an already-normalized branch name.
 * @returns {string} "" when the last segment has no ascii token.
 */
export function deriveFeatureFromBranch(branch) {
	return slugifyFeature(branch.slice(branch.lastIndexOf("/") + 1));
}

/**
 * Validate/normalize a component name.
 * @param {string} input
 * @returns {string}
 */
export function normalizeComponentName(input) {
	const normalized = input.trim().toLowerCase();
	if (!COMPONENT_NAME.test(normalized)) {
		throw new WorktreeFlowError(
			"BAD_COMPONENT",
			`组件名无效：${input}（只允许小写字母/数字/-/_，且以字母或数字开头）`
		);
	}
	if (WINDOWS_RESERVED.test(normalized)) {
		throw new WorktreeFlowError("BAD_COMPONENT", `组件名无效：${input}（Windows 保留设备名）`);
	}
	return normalized;
}

/**
 * Validate/normalize a set name (the immutable identity of a workspace set:
 * one file name under the sets dir and one path segment in feature roots).
 * Same token rules as component names.
 * @param {string} input
 * @returns {string}
 */
export function normalizeSetName(input) {
	const normalized = input.trim().toLowerCase();
	if (!COMPONENT_NAME.test(normalized)) {
		throw new WorktreeFlowError(
			"BAD_SET",
			`仓库组名无效：${input}（只允许小写字母/数字/-/_，且以字母或数字开头）`
		);
	}
	if (WINDOWS_RESERVED.test(normalized)) {
		throw new WorktreeFlowError("BAD_SET", `仓库组名无效：${input}（Windows 保留设备名）`);
	}
	return normalized;
}

/**
 * Validate a branch name (conservative subset of git check-ref-format).
 * @param {string} branch
 * @returns {string}
 */
export function normalizeBranchName(branch) {
	const trimmed = branch.trim();
	if (trimmed === "" || trimmed.startsWith("-") || trimmed.endsWith("/") || trimmed.includes("..") || BRANCH_FORBIDDEN.test(trimmed)) {
		throw new WorktreeFlowError("BAD_BRANCH", `分支名无效：${branch}`);
	}
	return trimmed;
}

/**
 * Compare two paths canonically enough for containment checks: resolve
 * symlinks when possible, otherwise fall back to the lexical absolute path.
 * Case-insensitive on win32 (drive letters and ACL-backed paths disagree).
 * @param {string} p
 * @returns {string}
 */
export function canonical(p) {
	let resolved;
	try {
		resolved = fs.realpathSync(p);
	} catch {
		resolved = path.resolve(p);
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Whether `candidate` is `base` itself or a descendant of `base`. */
export function isPathWithin(base, candidate) {
	const root = canonical(base);
	const target = canonical(candidate);
	return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Resolve the on-disk layout of one feature workspace.
 * @param {{worktreeRoot: string, projectName: string}} config
 * @param {string} feature - already-slugged feature name.
 * @returns {{featureRoot: string, componentPath: (component: string) => string}}
 */
export function featurePaths(config, feature) {
	const featureRoot = path.join(config.worktreeRoot, config.projectName, feature);
	return {
		featureRoot,
		componentPath: (component) => path.join(featureRoot, component)
	};
}

/** Workspace title convention: `<project>/<feature>` (plain text — recognition lives in the session header badge, not a title glyph). */
export function featureTitle(projectName, feature) {
	return `${projectName}/${feature}`;
}

/** Component workspace title convention: `<project>/<feature>/<component>`. */
export function componentTitle(projectName, feature, component) {
	return `${projectName}/${feature}/${component}`;
}

/**
 * Keyword table for natural-language component detection in the creation
 * wizard's optional description box. Structured checkboxes stay authoritative;
 * this only pre-fills them.
 */
const COMPONENT_KEYWORDS = [
	["backend", ["backend", "后端", "前后端", "服务端", "api"]],
	["frontend", ["frontend", "前端", "前后端", "页面", "web"]]
];

/**
 * Lightweight natural-language backfill for the creation wizard: pick the
 * slugged feature name out of the free text when possible and pre-check
 * components by keyword. Never throws — the form stays editable.
 * @param {string} text
 * @param {string[]} knownComponents - component names from config.
 * @returns {{feature: string, components: string[]}}
 */
export function parseNaturalIntent(text, knownComponents) {
	const lower = text.toLowerCase();
	const components = [];
	for (const name of knownComponents) {
		const entry = COMPONENT_KEYWORDS.find(([key]) => key === name);
		const keywords = entry ? entry[1] : [name];
		if (keywords.some((keyword) => lower.includes(keyword))) components.push(name);
	}
	// Prefer an explicit ascii token sequence as the feature name; otherwise
	// slugify whatever is left (may be empty for pure-Chinese input).
	const ascii = lower.match(/[a-z][a-z0-9-_]{1,63}/u);
	const feature = ascii ? slugifyFeature(ascii[0]) : slugifyFeature(text);
	return { feature, components };
}

/**
 * The creation intent shared by the wizard, the /worktree command, and the
 * service. Everything optional except what the caller can prove.
 * @typedef {object} CreateIntent
 * @property {string} [feature] - raw feature name (slugged by the service);
 *   when omitted it is derived from the branch's last `/` segment.
 * @property {string[]} components - component names; empty means "all configured".
 * @property {string} branch - complete feature branch name (required).
 * @property {string} [baseBranch] - default base; per-component overrides win.
 * @property {boolean} [dryRun] - plan only.
 * @property {boolean} [registerComponents] - also register each component dir
 *   as its own DSH workspace (default: feature root only).
 */
