// @ts-check
/**
 * Feature-manifest persistence and validation. Manifests are writable data
 * inside a workspace, so every read is treated as untrusted input.
 *
 * @module dsh-worktree-flow/manifest
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	WorktreeFlowError,
	canonical,
	isPathWithin,
	normalizeBranchName,
	normalizeComponentName,
	normalizeSetName,
	slugifyFeature
} from "./core.js";

export const MANIFEST_NAME = ".dsh-worktree.json";
export const LEGACY_MANIFEST_NAME = ".pi-workspace.json";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const MANIFEST_LIMIT = 1 << 20;
const STATES = new Set(["pending", "created", "existing", "failed"]);
const STATUSES = new Set(["creating", "ready", "partial", "failed", "archived"]);

/** @typedef {{name: string, repository: string, label?: string, sourcePath: string, branch: string, baseBranch: string, path: string, state: "pending"|"created"|"existing"|"failed", error?: string}} ManifestComponent */
/** @typedef {{version: number, projectName: string, feature: string, root: string, sourceCwd: string, configPath?: string, createdAt: string, updatedAt: string, status: "creating"|"ready"|"partial"|"failed"|"archived", components: Record<string, ManifestComponent>, archived?: boolean, registeredTitle?: string}} FeatureManifest */
/** @typedef {{manifest: FeatureManifest, file: string, legacy: boolean}} LoadedManifest */

function plainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, field, { empty = false, max = 2048, controls = false } = {}) {
	if (typeof value !== "string" || (!empty && value === "") || value.length > max || (!controls && CONTROL.test(value))) {
		throw new WorktreeFlowError("BAD_MANIFEST", `清单字段无效：${field}`);
	}
	return value;
}

/**
 * Validate and clone one untrusted manifest against its actual directory.
 * @param {unknown} raw
 * @param {string} featureRoot
 * @param {{projectName?: string, feature?: string}} [expected]
 * @returns {FeatureManifest}
 */
export function validateManifest(raw, featureRoot, expected = {}) {
	if (!plainObject(raw)) throw new WorktreeFlowError("BAD_MANIFEST", "清单根节点必须是对象");
	const source = /** @type {Record<string, unknown>} */ (raw);
	if (source.version !== 1) throw new WorktreeFlowError("BAD_MANIFEST", `不支持的清单版本：${String(source.version)}`);

	const projectNameRaw = text(source.projectName, "projectName", { max: 128 });
	const projectName = normalizeSetName(projectNameRaw);
	if (projectName !== projectNameRaw || (expected.projectName !== undefined && projectName !== expected.projectName)) {
		throw new WorktreeFlowError("BAD_MANIFEST", `清单仓库组与目录不一致：${projectNameRaw}`);
	}
	const featureRaw = text(source.feature, "feature", { max: 64 });
	const feature = slugifyFeature(featureRaw);
	if (feature === "" || feature !== featureRaw || (expected.feature !== undefined && feature !== expected.feature)) {
		throw new WorktreeFlowError("BAD_MANIFEST", `清单功能名与目录不一致：${featureRaw}`);
	}
	const root = text(source.root, "root", { max: 4096 });
	if (canonical(root) !== canonical(featureRoot)) {
		throw new WorktreeFlowError("BAD_MANIFEST", `清单 root 与实际目录不一致：${root}`);
	}
	const status = text(source.status, "status", { max: 32 });
	if (!STATUSES.has(status)) throw new WorktreeFlowError("BAD_MANIFEST", `清单状态无效：${status}`);
	if (!plainObject(source.components)) throw new WorktreeFlowError("BAD_MANIFEST", "清单 components 必须是对象");

	const componentEntries = Object.entries(/** @type {Record<string, unknown>} */ (source.components));
	if (componentEntries.length > 128) throw new WorktreeFlowError("BAD_MANIFEST", "清单组件数量超过上限（128）");
	/** @type {Record<string, ManifestComponent>} */
	const components = {};
	for (const [rawName, rawComponent] of componentEntries) {
		const name = normalizeComponentName(rawName);
		if (name !== rawName || Object.hasOwn(components, name) || !plainObject(rawComponent)) {
			throw new WorktreeFlowError("BAD_MANIFEST", `清单组件无效：${rawName}`);
		}
		const item = /** @type {Record<string, unknown>} */ (rawComponent);
		const itemName = normalizeComponentName(text(item.name, `components.${name}.name`, { max: 128 }));
		const repository = normalizeComponentName(text(item.repository, `components.${name}.repository`, { max: 128 }));
		if (itemName !== name || repository !== name) {
			throw new WorktreeFlowError("BAD_MANIFEST", `清单组件身份不一致：${name}`);
		}
		const componentPath = text(item.path, `components.${name}.path`, { max: 4096 });
		const expectedPath = path.join(featureRoot, name);
		if (canonical(componentPath) !== canonical(expectedPath) || !isPathWithin(featureRoot, componentPath)) {
			throw new WorktreeFlowError("BAD_MANIFEST", `清单组件路径越界或漂移：${componentPath}`);
		}
		const state = text(item.state, `components.${name}.state`, { max: 32 });
		if (!STATES.has(state)) throw new WorktreeFlowError("BAD_MANIFEST", `清单组件状态无效：${name}/${state}`);
		const component = {
			name,
			repository,
			sourcePath: text(item.sourcePath, `components.${name}.sourcePath`, { max: 4096 }),
			branch: normalizeBranchName(text(item.branch, `components.${name}.branch`, { max: 255 })),
			baseBranch: normalizeBranchName(text(item.baseBranch, `components.${name}.baseBranch`, { max: 255 })),
			path: componentPath,
			state: /** @type {ManifestComponent["state"]} */ (state)
		};
		if (item.label !== undefined) component.label = text(item.label, `components.${name}.label`, { max: 256 });
		if (item.error !== undefined) component.error = text(item.error, `components.${name}.error`, { empty: true, max: 4096, controls: true });
		components[name] = component;
	}

	const manifest = {
		version: 1,
		projectName,
		feature,
		root,
		sourceCwd: text(source.sourceCwd ?? "", "sourceCwd", { empty: true, max: 4096 }),
		createdAt: text(source.createdAt, "createdAt", { max: 128 }),
		updatedAt: text(source.updatedAt, "updatedAt", { max: 128 }),
		status: /** @type {FeatureManifest["status"]} */ (status),
		components
	};
	if (source.configPath !== undefined) manifest.configPath = text(source.configPath, "configPath", { max: 4096 });
	if (source.registeredTitle !== undefined) manifest.registeredTitle = text(source.registeredTitle, "registeredTitle", { max: 256 });
	if (source.archived === true) manifest.archived = true;
	return manifest;
}

async function readJson(file) {
	try {
		const stat = await fs.promises.stat(file);
		if (stat.size > MANIFEST_LIMIT) throw new WorktreeFlowError("BAD_MANIFEST", `清单过大：${file}`);
		const text = await fs.promises.readFile(file, "utf8");
		if (Buffer.byteLength(text, "utf8") > MANIFEST_LIMIT) throw new WorktreeFlowError("BAD_MANIFEST", `清单过大：${file}`);
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
 * @param {string} featureRoot
 * @param {{projectName?: string, feature?: string}} [expected]
 * @returns {Promise<LoadedManifest | undefined>}
 */
export async function readManifest(featureRoot, expected = {}) {
	const file = path.join(featureRoot, MANIFEST_NAME);
	const raw = await readJson(file);
	if (raw !== undefined) return { manifest: validateManifest(raw, featureRoot, expected), file, legacy: false };
	const legacyFile = path.join(featureRoot, LEGACY_MANIFEST_NAME);
	const legacy = await readJson(legacyFile);
	if (legacy !== undefined) return { manifest: validateManifest(legacy, featureRoot, expected), file: legacyFile, legacy: true };
	return undefined;
}

/** @param {string} featureRoot @param {FeatureManifest} manifest */
export async function writeManifest(featureRoot, manifest) {
	const file = path.join(featureRoot, MANIFEST_NAME);
	const next = validateManifest({ ...manifest, updatedAt: new Date().toISOString() }, featureRoot, {
		projectName: manifest.projectName,
		feature: manifest.feature
	});
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await fs.promises.rename(tmp, file);
	} catch (error) {
		await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
	return file;
}

/**
 * @param {string} worktreeRoot
 * @param {string} projectName
 * @returns {Promise<Array<{featureRoot: string, manifest: FeatureManifest, legacy: boolean}>>
 * }
 */
export async function scanManifests(worktreeRoot, projectName, options = {}) {
	const base = path.join(worktreeRoot, projectName);
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
		try {
			const loaded = await readManifest(featureRoot, { projectName, feature: dirent.name });
			if (loaded !== undefined) found.push({ featureRoot, manifest: loaded.manifest, legacy: loaded.legacy });
		} catch (error) {
			if (Array.isArray(options.errors) && error instanceof WorktreeFlowError && error.code === "BAD_MANIFEST") {
				options.errors.push({ featureRoot, error: error.message });
				continue;
			}
			throw error;
		}
	}
	return found;
}
