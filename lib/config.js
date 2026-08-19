// @ts-check
/**
 * dsh-worktree-flow config: named workspace SETS stored centrally — no config
 * file lives inside any repository, no merging, no convention derivation.
 *
 *   sets:     $DSH_HOME/worktree-flow/sets/<name>.json — one self-contained
 *             file per set: {label?, worktreeRoot, defaultBaseBranch,
 *             repositories: {<component>: {label?, path, defaultBaseBranch?}}}.
 *             The set NAME (file slug) is the immutable identity; component
 *             paths are always explicit (picked or typed).
 *   template: $DSH_HOME/worktree-flow.json — "new set template", read ONCE
 *             when a set is first created (prefill values + component
 *             vocabulary); never consulted afterwards.
 *
 * @module dsh-worktree-flow/config
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_BRANCH_TYPES,
	WorktreeFlowError,
	normalizeBranchName,
	normalizeComponentName,
	normalizeSetName,
	slugifyFeature
} from "./core.js";

export const CONFIG_FILE_NAME = "worktree-flow.json";

/** @typedef {{label?: string, path?: string, defaultBaseBranch?: string}} RepoEntry */
/**
 * @typedef {object} SetConfig
 * @property {string} name - immutable set identity (file slug).
 * @property {string} [label] - optional display name.
 * @property {string} worktreeRoot - root holding <name>/<feature>/ trees.
 * @property {string} defaultBaseBranch
 * @property {Record<string, RepoEntry>} repositories
 */
/** @typedef {{version?: number, label?: string, worktreeRoot?: string, defaultBaseBranch?: string, repositories?: Record<string, unknown>}} RawSetFile */

const CONTROL = /[\u0000-\u001f\u007f]/u;
function cleanText(value, field, max = 4096) {
	if (typeof value !== "string" || value.length > max || CONTROL.test(value)) {
		throw new WorktreeFlowError("BAD_CONFIG", `配置字段无效：${field}`);
	}
	return value.trim();
}

function isPortableAbsolute(value) {
	return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

/** Resolve $DSH_HOME the same way the host does: env first, else ~/.dsh. */
export function dshHome() {
	return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}

/**
 * Expand a leading `~` against the user home directory.
 * @param {unknown} p
 * @returns {unknown}
 */
export function expandHome(p) {
	if (typeof p !== "string") return p;
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function setsDir() {
	return path.join(dshHome(), "worktree-flow", "sets");
}

/** @param {string} name - already-normalized set name. */
export function setFile(name) {
	return path.join(setsDir(), `${name}.json`);
}

async function readJson(file) {
	try {
		const stat = await fs.promises.stat(file);
		if (stat.size > (1 << 20)) throw new WorktreeFlowError("BAD_CONFIG", `配置文件过大：${file}`);
		const text = await fs.promises.readFile(file, "utf8");
		return JSON.parse(text);
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) {
			throw new WorktreeFlowError("BAD_CONFIG", `配置不是合法 JSON：${file}（${error.message}）`);
		}
		throw error;
	}
}

/**
 * Normalize one repositories map: values may be plain path strings or objects.
 * Paths are explicit — `~` expands, empties drop; no relative resolution
 * (a central store has no meaningful base) and no convention derivation.
 * @param {Record<string, unknown> | undefined} raw
 * @returns {Record<string, RepoEntry>}
 */
export function normalizeRepositories(raw) {
	if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
		throw new WorktreeFlowError("BAD_CONFIG", "repositories 必须是对象");
	}
	/** @type {Record<string, RepoEntry>} */
	const out = {};
	for (const [rawName, value] of Object.entries(raw ?? {})) {
		const name = normalizeComponentName(rawName);
		if (Object.hasOwn(out, name)) {
			throw new WorktreeFlowError("BAD_CONFIG", `组件名规范化后重复：${rawName} → ${name}`);
		}
		/** @type {RepoEntry} */
		let entry;
		if (typeof value === "string") entry = { path: cleanText(value, `${name}.path`) };
		else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const source = /** @type {Record<string, unknown>} */ (value);
			entry = {};
			if (typeof source.label === "string" && source.label.trim() !== "") entry.label = cleanText(source.label, `${name}.label`, 256);
			if (typeof source.path === "string" && source.path.trim() !== "") {
				entry.path = /** @type {string} */ (expandHome(cleanText(source.path, `${name}.path`)));
			}
			if (typeof source.defaultBaseBranch === "string" && source.defaultBaseBranch.trim() !== "") {
				entry.defaultBaseBranch = normalizeBranchName(source.defaultBaseBranch);
			}
		} else {
			throw new WorktreeFlowError("BAD_CONFIG", `组件配置必须是路径字符串或对象：${rawName}`);
		}
		if (typeof entry.path === "string") entry.path = /** @type {string} */ (expandHome(entry.path.trim()));
		if (typeof entry.path !== "string" || entry.path === "") delete entry.path;
		else if (!isPortableAbsolute(entry.path)) throw new WorktreeFlowError("BAD_CONFIG", `组件路径必须是绝对路径：${name}`);
		out[name] = entry;
	}
	return out;
}

/**
 * @param {RawSetFile | undefined} raw
 * @param {string} name
 * @returns {SetConfig}
 */
function normalizeSet(raw, name) {
	const ne = (v, field, max) => (typeof v === "string" && v.trim() !== "" ? cleanText(v, field, max) : undefined);
	const defaultBaseBranch = normalizeBranchName(ne(raw?.defaultBaseBranch, "defaultBaseBranch", 255) ?? "master");
	const worktreeRoot = /** @type {string} */ (expandHome(ne(raw?.worktreeRoot, "worktreeRoot", 4096) ?? ""));
	if (worktreeRoot !== "" && !isPortableAbsolute(worktreeRoot)) {
		throw new WorktreeFlowError("BAD_CONFIG", "worktreeRoot 必须是绝对路径");
	}
	return {
		name,
		label: ne(raw?.label, "label", 256),
		worktreeRoot,
		defaultBaseBranch,
		repositories: normalizeRepositories(raw?.repositories)
	};
}

/**
 * Load one set by name. Returns undefined when the file does not exist;
 * throws BAD_SET for an invalid name and BAD_CONFIG for malformed JSON.
 * @param {string} name
 * @returns {Promise<SetConfig | undefined>}
 */
export async function loadSet(name) {
	const slug = normalizeSetName(name);
	const raw = /** @type {RawSetFile | undefined} */ (await readJson(setFile(slug)));
	if (raw === undefined) return undefined;
	return normalizeSet(raw, slug);
}

/**
 * List every set (sorted by name). Malformed files surface as BAD_CONFIG —
 * a broken set must be visible, not silently skipped.
 * @returns {Promise<SetConfig[]>}
 */
export async function listSets() {
	let dirents;
	try {
		dirents = await fs.promises.readdir(setsDir(), { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	/** @type {SetConfig[]} */
	const sets = [];
	for (const dirent of dirents) {
		if (!dirent.isFile() || !dirent.name.endsWith(".json")) continue;
		const name = dirent.name.slice(0, -".json".length);
		const raw = /** @type {RawSetFile | undefined} */ (await readJson(path.join(setsDir(), dirent.name)));
		if (raw !== undefined) sets.push(normalizeSet(raw, name));
	}
	return sets.sort((a, b) => a.name.localeCompare(b.name));
}

/** Serialize a set for writing. @param {SetConfig} config */
export function serializeSet(config) {
	/** @type {Record<string, unknown>} */
	const repositories = {};
	for (const [name, entry] of Object.entries(config.repositories ?? {})) {
		repositories[name] = {
			...(entry.label !== undefined ? { label: entry.label } : {}),
			...(entry.path !== undefined ? { path: entry.path } : {}),
			...(entry.defaultBaseBranch !== undefined ? { defaultBaseBranch: entry.defaultBaseBranch } : {})
		};
	}
	return {
		version: 1,
		...(config.label !== undefined && config.label !== "" ? { label: config.label } : {}),
		worktreeRoot: config.worktreeRoot,
		defaultBaseBranch: config.defaultBaseBranch,
		repositories
	};
}

/**
 * Atomically write a set config (tmp file + rename). Creates the sets dir.
 * The set name is validated — it is the file name and the identity.
 * @param {SetConfig} config
 * @returns {Promise<string>} the file written.
 */
export async function saveSet(config) {
	const name = normalizeSetName(config.name);
	const normalized = normalizeSet(/** @type {RawSetFile} */ (config), name);
	await fs.promises.mkdir(setsDir(), { recursive: true });
	const file = setFile(name);
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, `${JSON.stringify(serializeSet(normalized), null, 2)}\n`, "utf8");
		await fs.promises.rename(tmp, file);
	} catch (error) {
		await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
	return file;
}

/** Stable optimistic-concurrency token for one normalized set config. */
export function configRevision(config) {
	return crypto.createHash("sha256").update(JSON.stringify(serializeSet(config))).digest("hex");
}

/**
 * Delete a set config. Feature workspaces on disk are NOT touched — this only
 * removes the binding. Returns whether a file was removed.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function deleteSet(name) {
	const file = setFile(normalizeSetName(name));
	try {
		await fs.promises.rm(file);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Validate that a set config is complete enough to create feature workspaces.
 * @param {SetConfig} config
 * @returns {string[]} human-readable problems; empty means usable.
 */
export function configProblems(config) {
	const problems = [];
	if (config.worktreeRoot.trim() === "") problems.push("worktreeRoot 为空（功能工作区的根目录）");
	if (Object.keys(config.repositories).length === 0) problems.push("repositories 为空（至少绑定一个组件仓库）");
	return problems;
}

/**
 * Read the new-set template ($DSH_HOME/worktree-flow.json). Consumed ONLY as
 * prefill when a set is first created — it never participates afterwards.
 * @returns {Promise<undefined | {worktreeRoot: string, defaultBaseBranch: string, repositories: Record<string, RepoEntry>}>}
 */
export async function readConfigTemplate() {
	const raw = /** @type {RawSetFile | undefined} | undefined */ (await readJson(path.join(dshHome(), CONFIG_FILE_NAME)));
	if (raw === undefined) return undefined;
	return {
		worktreeRoot: typeof raw.worktreeRoot === "string" ? /** @type {string} */ (expandHome(raw.worktreeRoot)) : "",
		defaultBaseBranch: typeof raw.defaultBaseBranch === "string" ? raw.defaultBaseBranch : "",
		repositories: normalizeRepositories(raw.repositories)
	};
}

/**
 * Atomically write the new-set template. Repository entries keep
 * label/defaultBaseBranch only (paths are stripped by callers — a template
 * defines the component vocabulary, not machines).
 * @param {{worktreeRoot?: string, defaultBaseBranch?: string, repositories?: Record<string, RepoEntry>}} config
 */
export async function writeConfigTemplate(config) {
	const dir = dshHome();
	await fs.promises.mkdir(dir, { recursive: true });
	const file = path.join(dir, CONFIG_FILE_NAME);
	const normalizedRepositories = normalizeRepositories(config.repositories ?? {});
	const templateRepositories = {};
	for (const [name, entry] of Object.entries(normalizedRepositories)) {
		templateRepositories[name] = {
			...(entry.label !== undefined ? { label: entry.label } : {}),
			...(entry.defaultBaseBranch !== undefined ? { defaultBaseBranch: entry.defaultBaseBranch } : {})
		};
	}
	/** @type {RawSetFile} */
	const body = {
		version: 1,
		...(config.worktreeRoot ? { worktreeRoot: String(config.worktreeRoot).trim() } : {}),
		...(config.defaultBaseBranch ? { defaultBaseBranch: normalizeBranchName(String(config.defaultBaseBranch)) } : {}),
		repositories: templateRepositories
	};
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
		await fs.promises.rename(tmp, file);
	} catch (error) {
		await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
	return file;
}

// ------------------------------------------------------------- branch types
// Global branch-type vocabulary for the create wizard (类型 + 主题 → 完整分支名).
// Stored at $DSH_HOME/worktree-flow/branch-types.json; the built-in defaults
// are materialized on first read so the list becomes user-editable.

/** @typedef {{key: string, label: string, prefix: string}} BranchType */

export function branchTypesFile() {
	return path.join(dshHome(), "worktree-flow", "branch-types.json");
}

/**
 * Normalize a raw types list: drop empty labels and invalid prefixes, derive
 * unique keys. A prefix is "" or a branch-safe token ending in "/".
 * @param {unknown} list
 * @returns {BranchType[]}
 */
function normalizeBranchTypes(list) {
	if (!Array.isArray(list)) return [];
	/** @type {BranchType[]} */
	const out = [];
	const seen = new Set();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const label = String(/** @type {{label?: unknown}} */ (entry).label ?? "").trim();
		if (label === "") continue;
		let prefix = String(/** @type {{prefix?: unknown}} */ (entry).prefix ?? "").trim().toLowerCase().replace(/\s+/gu, "-");
		if (prefix !== "" && !prefix.endsWith("/")) prefix = `${prefix}/`;
		if (prefix !== "" && !/^[a-z0-9][a-z0-9-_/]*\/$/u.test(prefix)) continue;
		let key = slugifyFeature(String(/** @type {{key?: unknown}} */ (entry).key ?? "")) || slugifyFeature(prefix.replace(/\/+$/u, "")) || `type-${out.length + 1}`;
		while (seen.has(key)) key = `${key}-x`;
		seen.add(key);
		out.push({ key, label, prefix });
	}
	return out;
}

/**
 * Read the branch-type vocabulary. On first run (no file) the built-in
 * defaults are written out and returned, so later edits have a file to land in.
 * @returns {Promise<BranchType[]>}
 */
export async function readBranchTypes() {
	const raw = /** @type {{types?: unknown} | undefined} */ (await readJson(branchTypesFile()));
	if (raw === undefined) {
		await writeBranchTypes(DEFAULT_BRANCH_TYPES);
		return DEFAULT_BRANCH_TYPES.map((entry) => ({ ...entry }));
	}
	return normalizeBranchTypes(raw.types);
}

/**
 * Atomically replace the branch-type vocabulary.
 * @param {unknown} types
 * @returns {Promise<BranchType[]>} the normalized list actually written.
 */
export async function writeBranchTypes(types) {
	const normalized = normalizeBranchTypes(types);
	await fs.promises.mkdir(path.dirname(branchTypesFile()), { recursive: true });
	const file = branchTypesFile();
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, `${JSON.stringify({ version: 1, types: normalized }, null, 2)}\n`, "utf8");
		await fs.promises.rename(tmp, file);
	} catch (error) {
		await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
	return normalized;
}
