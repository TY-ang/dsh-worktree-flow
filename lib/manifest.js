// @ts-check
/**
 * dsh-worktree-flow manifest: the per-feature `.dsh-worktree.json` record at
 * the feature root. Field names match the Pi-era `.pi-workspace.json`
 * verbatim so existing manifests parse unchanged; the legacy file is read as
 * a fallback and never rewritten.
 *
 * @module dsh-worktree-flow/manifest
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WorktreeFlowError } from "./core.js";

export const MANIFEST_NAME = ".dsh-worktree.json";
export const LEGACY_MANIFEST_NAME = ".pi-workspace.json";

/**
 * @typedef {object} ManifestComponent
 * @property {string} name
 * @property {string} repository - component key in config.repositories.
 * @property {string} [label] - display name snapshot at creation (the live
 *   label is resolved from the set config when rendering).
 * @property {string} sourcePath - absolute path of the source repo checkout.
 * @property {string} branch - expected branch.
 * @property {string} baseBranch
 * @property {string} path - absolute component worktree path.
 * @property {string} state - `created` | `existing` | `failed`.
 * @property {string} [error] - failure detail when state is `failed`.
 */

/**
 * @typedef {object} FeatureManifest
 * @property {number} version
 * @property {string} projectName
 * @property {string} feature
 * @property {string} root - feature root directory.
 * @property {string} sourceCwd - repo root the workspace was created from.
 * @property {string} [configPath]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} status - `ready` | `partial` | `archived`.
 * @property {Record<string, ManifestComponent>} components
 * @property {boolean} [archived]
 * @property {string} [registeredTitle] - last workspace title registered.
 */

async function readJson(file) {
	try {
		const text = await fs.promises.readFile(file, "utf8");
		return JSON.parse(text);
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) {
			throw new WorktreeFlowError("BAD_MANIFEST", `清单不是合法 JSON：${file}（${error.message}）`);
		}
		throw error;
	}
}

/**
 * @typedef {object} LoadedManifest
 * @property {FeatureManifest} manifest
 * @property {string} file - the file actually read.
 * @property {boolean} legacy - true when read from the legacy `.pi` file.
 */

/**
 * Read the manifest at a feature root: new name first, legacy fallback.
 * Returns undefined when neither exists.
 * @param {string} featureRoot
 * @returns {Promise<LoadedManifest | undefined>}
 */
export async function readManifest(featureRoot) {
	const file = path.join(featureRoot, MANIFEST_NAME);
	const manifest = /** @type {FeatureManifest | undefined} */ (await readJson(file));
	if (manifest !== undefined) return { manifest, file, legacy: false };
	const legacyFile = path.join(featureRoot, LEGACY_MANIFEST_NAME);
	const legacy = /** @type {FeatureManifest | undefined} */ (await readJson(legacyFile));
	if (legacy !== undefined) return { manifest: legacy, file: legacyFile, legacy: true };
	return undefined;
}

/**
 * Atomically write the manifest (tmp + rename). Stamps `updatedAt`. Always
 * writes the NEW file name, even when the record came from a legacy file
 * (that is the migration step; the legacy file is left untouched as .bak
 * material until the user opts into cleanup).
 * @param {string} featureRoot
 * @param {FeatureManifest} manifest
 */
export async function writeManifest(featureRoot, manifest) {
	const file = path.join(featureRoot, MANIFEST_NAME);
	const next = { ...manifest, updatedAt: new Date().toISOString() };
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await fs.promises.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	await fs.promises.rename(tmp, file);
	return file;
}

/**
 * Scan `<worktreeRoot>/<projectName>/` for feature roots carrying a manifest
 * (new or legacy). Directory entries without a manifest are skipped (they
 * may be orphans — sync reports them separately).
 * @param {string} worktreeRoot
 * @param {string} projectName
 * @returns {Promise<Array<{featureRoot: string, manifest: FeatureManifest, legacy: boolean}>>}
 */
export async function scanManifests(worktreeRoot, projectName) {
	const base = path.join(worktreeRoot, projectName);
	/** @type {Array<{featureRoot: string, manifest: FeatureManifest, legacy: boolean}>} */
	const found = [];
	let dirents;
	try {
		dirents = await fs.promises.readdir(base, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return found;
		throw error;
	}
	for (const dirent of dirents) {
		if (!dirent.isDirectory()) continue;
		const featureRoot = path.join(base, dirent.name);
		const loaded = await readManifest(featureRoot);
		if (loaded !== undefined) {
			found.push({ featureRoot, manifest: loaded.manifest, legacy: loaded.legacy });
		}
	}
	return found;
}
