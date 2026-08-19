// @ts-check
/**
 * Trusted per-feature session context and shared-docs snapshots.
 *
 * Custom instructions must not be read from the workspace manifest: that file
 * is writable from the feature sandbox and would turn into an automatic prompt
 * injection surface. The authoritative text therefore lives under DSH_HOME;
 * only a generated docs snapshot is placed inside the feature root so sessions
 * can read it without escaping their sandbox.
 *
 * @module dsh-worktree-flow/feature-context
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dshHome } from "./config.js";
import {
	WorktreeFlowError,
	canonical,
	isPathWithin,
	normalizeSetName,
	slugifyFeature
} from "./core.js";

const CONTEXT_LIMIT = 64 << 10;
const INSTRUCTIONS_MAX = 16 << 10;
const DOCS_FILE_LIMIT = 20_000;
const DOCS_DIR_LIMIT = 20_000;
const DOCS_DEPTH_LIMIT = 64;
const DOCS_BYTES_LIMIT = 100 << 20;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/u;

function safeText(value, field, max = 4096) {
	if (typeof value !== "string" || value === "" || value.length > max || ANY_CONTROL.test(value)) {
		throw new WorktreeFlowError("BAD_FEATURE_CONTEXT", `功能区上下文字段无效：${field}`);
	}
	return value;
}

function portableAbsolute(value) {
	return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function lexicalPath(value) {
	const normalized = path.normalize(path.resolve(value));
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export const FEATURE_META_DIR = ".worktree-flow";
export const DOCS_SNAPSHOT_DIR = "docs";

export function normalizeSessionInstructions(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new WorktreeFlowError("BAD_INSTRUCTIONS", "功能区提示词必须是文本");
	const normalized = value.replace(/\r\n?/gu, "\n").trim();
	if (normalized === "") return undefined;
	if (Buffer.byteLength(normalized, "utf8") > INSTRUCTIONS_MAX || UNSAFE_CONTROL.test(normalized)) {
		throw new WorktreeFlowError("BAD_INSTRUCTIONS", "功能区提示词无效或超过 16 KiB");
	}
	return normalized;
}

function identity(projectName, feature) {
	const project = normalizeSetName(projectName);
	const featureSlug = slugifyFeature(feature);
	if (featureSlug === "" || featureSlug !== feature) {
		throw new WorktreeFlowError("BAD_FEATURE", `功能标识无效：${feature}`);
	}
	return { projectName: project, feature: featureSlug };
}

export function featureContextFile(projectName, feature) {
	const id = identity(projectName, feature);
	return path.join(dshHome(), "worktree-flow", "contexts", id.projectName, `${id.feature}.json`);
}

export function docsSnapshotPath(featureRoot) {
	return path.join(featureRoot, FEATURE_META_DIR, DOCS_SNAPSHOT_DIR);
}

function validateContext(raw, projectName, feature, featureRoot) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new WorktreeFlowError("BAD_FEATURE_CONTEXT", "功能区上下文必须是对象");
	}
	const source = /** @type {Record<string, unknown>} */ (raw);
	const id = identity(projectName, feature);
	if (source.version !== 1 || source.projectName !== id.projectName || source.feature !== id.feature) {
		throw new WorktreeFlowError("BAD_FEATURE_CONTEXT", "功能区上下文身份不一致");
	}
	const createdAt = safeText(source.createdAt, "createdAt", 64);
	if (!Number.isFinite(Date.parse(createdAt))) throw new WorktreeFlowError("BAD_FEATURE_CONTEXT", "功能区上下文 createdAt 无效");
	const contextRoot = safeText(source.featureRoot, "featureRoot");
	if (!portableAbsolute(contextRoot) || canonical(contextRoot) !== canonical(featureRoot)) {
		throw new WorktreeFlowError("BAD_FEATURE_CONTEXT", "功能区上下文与功能根目录不一致");
	}
	const context = {
		version: 1,
		projectName: id.projectName,
		feature: id.feature,
		featureRoot: contextRoot,
		createdAt
	};
	const instructions = normalizeSessionInstructions(source.sessionInstructions);
	if (instructions !== undefined) context.sessionInstructions = instructions;
	if (source.docsSnapshot !== undefined) {
		if (source.docsSnapshot === null || typeof source.docsSnapshot !== "object" || Array.isArray(source.docsSnapshot)) {
			throw new WorktreeFlowError("BAD_FEATURE_CONTEXT", "共享文档快照信息无效");
		}
		const docs = /** @type {Record<string, unknown>} */ (source.docsSnapshot);
		const sourcePath = safeText(docs.sourcePath, "docsSnapshot.sourcePath");
		const snapshotPath = safeText(docs.path, "docsSnapshot.path");
		const docsCreatedAt = safeText(docs.createdAt, "docsSnapshot.createdAt", 64);
		const state = docs.state === "copying" || docs.state === "ready" ? docs.state : undefined;
		const expectedPath = docsSnapshotPath(featureRoot);
		if (state === undefined
			|| !portableAbsolute(sourcePath)
			|| !portableAbsolute(snapshotPath)
			|| lexicalPath(snapshotPath) !== lexicalPath(expectedPath)
			|| !Number.isFinite(Date.parse(docsCreatedAt))
			|| !Number.isSafeInteger(docs.fileCount) || docs.fileCount < 0 || docs.fileCount > DOCS_FILE_LIMIT
			|| !Number.isSafeInteger(docs.bytes) || docs.bytes < 0 || docs.bytes > DOCS_BYTES_LIMIT) {
			throw new WorktreeFlowError("BAD_FEATURE_CONTEXT", "共享文档快照信息无效");
		}
		context.docsSnapshot = {
			state,
			sourcePath,
			path: expectedPath,
			createdAt: docsCreatedAt,
			fileCount: docs.fileCount,
			bytes: docs.bytes
		};
	}
	return context;
}

export async function readFeatureContext(projectName, feature, featureRoot) {
	const file = featureContextFile(projectName, feature);
	try {
		const stat = await fs.promises.stat(file);
		if (stat.size > CONTEXT_LIMIT) throw new WorktreeFlowError("BAD_FEATURE_CONTEXT", `功能区上下文过大：${file}`);
		const raw = JSON.parse(await fs.promises.readFile(file, "utf8"));
		return validateContext(raw, projectName, feature, featureRoot);
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) throw new WorktreeFlowError("BAD_FEATURE_CONTEXT", `功能区上下文不是合法 JSON：${file}`);
		throw error;
	}
}

export async function writeFeatureContext(context, featureRoot) {
	const next = validateContext({
		...context,
		version: 1,
		featureRoot,
		createdAt: context.createdAt ?? new Date().toISOString()
	}, context.projectName, context.feature, featureRoot);
	const file = featureContextFile(next.projectName, next.feature);
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await fs.promises.rename(tmp, file);
	} catch (error) {
		await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
	return next;
}

export async function deleteFeatureContext(projectName, feature) {
	const file = featureContextFile(projectName, feature);
	try {
		await fs.promises.rm(file);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

async function collectDocs(sourcePath, signal) {
	const entries = [];
	let fileCount = 0;
	let directoryCount = 0;
	let bytes = 0;
	async function walk(dir, relative, depth) {
		if (signal?.aborted) throw signal.reason ?? new WorktreeFlowError("ABORTED", "共享文档快照已取消");
		if (depth > DOCS_DEPTH_LIMIT) throw new WorktreeFlowError("DOCS_TOO_LARGE", `共享文档目录深度超过 ${DOCS_DEPTH_LIMIT} 层`);
		const directory = await fs.promises.opendir(dir);
		for await (const dirent of directory) {
			if (signal?.aborted) throw signal.reason ?? new WorktreeFlowError("ABORTED", "共享文档快照已取消");
			const source = path.join(dir, dirent.name);
			const childRelative = path.join(relative, dirent.name);
			const stat = await fs.promises.lstat(source);
			if (stat.isSymbolicLink()) {
				throw new WorktreeFlowError("DOCS_SYMLINK", `共享文档目录不允许符号链接：${source}`);
			}
			if (stat.isDirectory()) {
				directoryCount += 1;
				if (directoryCount > DOCS_DIR_LIMIT) throw new WorktreeFlowError("DOCS_TOO_LARGE", `共享文档目录超过 ${DOCS_DIR_LIMIT} 个子目录`);
				entries.push({ kind: "directory", source, relative: childRelative });
				await walk(source, childRelative, depth + 1);
			} else if (stat.isFile()) {
				fileCount += 1;
				bytes += stat.size;
				if (fileCount > DOCS_FILE_LIMIT || bytes > DOCS_BYTES_LIMIT) {
					throw new WorktreeFlowError("DOCS_TOO_LARGE", "共享文档快照超过 20,000 个文件或 100 MiB");
				}
				entries.push({
					kind: "file",
					source,
					relative: childRelative,
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeMs: stat.mtimeMs,
					ctimeMs: stat.ctimeMs
				});
			}
		}
	}
	await walk(sourcePath, "", 0);
	return { entries, fileCount, directoryCount, bytes };
}

export async function assertDocsDestinationParent(featureRoot) {
	const rootStat = await fs.promises.lstat(featureRoot).catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (rootStat !== undefined && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
		throw new WorktreeFlowError("BAD_LAYOUT", `功能根目录不是安全的普通目录：${featureRoot}`);
	}
	const parent = path.dirname(docsSnapshotPath(featureRoot));
	const parentStat = await fs.promises.lstat(parent).catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (parentStat !== undefined
		&& (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !isPathWithin(featureRoot, parent))) {
		throw new WorktreeFlowError("BAD_LAYOUT", `共享文档快照父目录不安全：${parent}`);
	}
	return parent;
}

async function validateDocsSource(sourcePath, featureRoot) {
	await assertDocsDestinationParent(featureRoot);
	const source = path.resolve(sourcePath);
	const stat = await fs.promises.lstat(source).catch((error) => {
		if (error.code === "ENOENT") throw new WorktreeFlowError("NO_DOCS", `共享文档目录不存在：${source}`);
		throw error;
	});
	if (stat.isSymbolicLink()) throw new WorktreeFlowError("DOCS_SYMLINK", `共享文档源目录不允许符号链接或目录联接：${source}`);
	if (!stat.isDirectory()) throw new WorktreeFlowError("BAD_DOCS", `共享文档路径不是目录：${source}`);
	const target = docsSnapshotPath(featureRoot);
	if (!isPathWithin(featureRoot, target)) throw new WorktreeFlowError("BAD_LAYOUT", `共享文档目标路径越界：${target}`);
	if (isPathWithin(source, target) || isPathWithin(target, source)) {
		throw new WorktreeFlowError("DOCS_OVERLAP", `共享文档源目录不能与功能区快照目录重叠：${source}`);
	}
	return { source, target };
}

/** Fully scan and bound the source before feature-root or Git side effects. */
export async function prepareDocsSnapshot(sourcePath, featureRoot, signal) {
	const validated = await validateDocsSource(sourcePath, featureRoot);
	return { ...validated, ...(await collectDocs(validated.source, signal)) };
}

async function removePlainTree(target, label) {
	const stat = await fs.promises.lstat(target).catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (stat === undefined) return false;
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new WorktreeFlowError("BAD_LAYOUT", `${label}不是安全的普通目录：${target}`);
	}
	// Atomically detach the exact directory entry before recursive deletion.
	// If an attacker swaps it for a junction between lstat and rename, the
	// junction itself moves; the second lstat rejects it before rm can traverse.
	const quarantine = `${target}.remove-${crypto.randomUUID()}`;
	await fs.promises.rename(target, quarantine);
	const moved = await fs.promises.lstat(quarantine);
	if (!moved.isDirectory() || moved.isSymbolicLink()) {
		await fs.promises.rename(quarantine, target).catch(() => undefined);
		throw new WorktreeFlowError("BAD_LAYOUT", `${label}在清理前发生类型变化：${target}`);
	}
	await fs.promises.rm(quarantine, { recursive: true, force: true });
	return true;
}

export async function assertDocsSnapshotTarget(featureRoot) {
	const rootStat = await fs.promises.lstat(featureRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new WorktreeFlowError("BAD_LAYOUT", `功能根目录不是安全的普通目录：${featureRoot}`);
	}
	const target = docsSnapshotPath(featureRoot);
	const targetStat = await fs.promises.lstat(target);
	const parent = path.dirname(target);
	const parentStat = await fs.promises.lstat(parent);
	if (!targetStat.isDirectory() || targetStat.isSymbolicLink()
		|| !parentStat.isDirectory() || parentStat.isSymbolicLink()
		|| !isPathWithin(featureRoot, parent)) {
		throw new WorktreeFlowError("BAD_LAYOUT", `共享文档快照目录不安全：${target}`);
	}
	return target;
}

/** Deeply validate a published snapshot before reuse or advertisement. */
export async function validateDocsSnapshot(context, featureRoot, signal) {
	const docs = context?.docsSnapshot;
	if (docs === undefined) return undefined;
	const target = await assertDocsSnapshotTarget(featureRoot);
	let fileCount = 0;
	let directoryCount = 0;
	let bytes = 0;
	async function walk(dir, depth) {
		if (signal?.aborted) throw signal.reason ?? new WorktreeFlowError("ABORTED", "共享文档快照校验已取消");
		if (depth > DOCS_DEPTH_LIMIT) throw new WorktreeFlowError("DOCS_CHANGED", `共享文档快照深度超过 ${DOCS_DEPTH_LIMIT} 层`);
		const directory = await fs.promises.opendir(dir);
		for await (const entry of directory) {
			if (signal?.aborted) throw signal.reason ?? new WorktreeFlowError("ABORTED", "共享文档快照校验已取消");
			const child = path.join(dir, entry.name);
			const stat = await fs.promises.lstat(child);
			if (stat.isSymbolicLink()) throw new WorktreeFlowError("DOCS_CHANGED", `共享文档快照包含符号链接或目录联接：${child}`);
			if (stat.isDirectory()) {
				directoryCount += 1;
				if (directoryCount > DOCS_DIR_LIMIT) throw new WorktreeFlowError("DOCS_CHANGED", "共享文档快照子目录数量超过上限");
				await walk(child, depth + 1);
			} else if (stat.isFile()) {
				fileCount += 1;
				bytes += stat.size;
				if (fileCount > DOCS_FILE_LIMIT || bytes > DOCS_BYTES_LIMIT) {
					throw new WorktreeFlowError("DOCS_CHANGED", "共享文档快照文件数量或容量超过上限");
				}
			} else {
				throw new WorktreeFlowError("DOCS_CHANGED", `共享文档快照包含不支持的文件类型：${child}`);
			}
		}
	}
	await walk(target, 0);
	if (fileCount !== docs.fileCount || bytes !== docs.bytes) {
		throw new WorktreeFlowError(
			"DOCS_CHANGED",
			`共享文档快照与创建记录不一致：文件 ${fileCount}/${docs.fileCount}，字节 ${bytes}/${docs.bytes}`
		);
	}
	return { ...docs, path: target, fileCount, bytes };
}

/**
 * Copy one immutable-at-creation snapshot into the feature sandbox. Existing
 * targets are reused only when their trusted context points at the same source.
 */
export async function createDocsSnapshot(sourcePath, featureRoot, options = {}) {
	const { source, target } = await validateDocsSource(sourcePath, featureRoot);
	const targetStat = await fs.promises.lstat(target).catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (targetStat !== undefined) {
		await assertDocsSnapshotTarget(featureRoot);
		if (targetStat.isDirectory() && !targetStat.isSymbolicLink()
			&& options.existing?.state === "ready"
			&& canonical(options.existing.sourcePath) === canonical(source)) return options.existing;
		throw new WorktreeFlowError("DOCS_CONFLICT", `共享文档快照目录已存在，拒绝覆盖：${target}`);
	}

	const collected = options.prepared !== undefined
		&& canonical(options.prepared.source) === canonical(source)
		&& canonical(options.prepared.target) === canonical(target)
		? options.prepared
		: await collectDocs(source, options.signal);
	const parent = path.dirname(target);
	try {
		await fs.promises.mkdir(parent);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const parentStat = await fs.promises.lstat(parent);
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !isPathWithin(featureRoot, parent)) {
		throw new WorktreeFlowError("BAD_LAYOUT", `共享文档快照父目录不安全：${parent}`);
	}
	const tmp = path.join(parent, `.docs-${crypto.randomUUID()}.tmp`);
	let actualBytes = 0;
	try {
		await fs.promises.mkdir(tmp);
		const tmpStat = await fs.promises.lstat(tmp);
		if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink() || !isPathWithin(featureRoot, tmp)) {
			throw new WorktreeFlowError("BAD_LAYOUT", `共享文档临时目录不安全：${tmp}`);
		}
		for (const entry of collected.entries) {
			if (options.signal?.aborted) throw options.signal.reason ?? new WorktreeFlowError("ABORTED", "共享文档快照已取消");
			const destination = path.join(tmp, entry.relative);
			if (entry.kind === "directory") await fs.promises.mkdir(destination, { recursive: true });
			else {
				const current = await fs.promises.lstat(entry.source);
				if (current.isSymbolicLink() || !current.isFile()
					|| current.dev !== entry.dev || current.ino !== entry.ino
					|| current.size !== entry.size || current.mtimeMs !== entry.mtimeMs || current.ctimeMs !== entry.ctimeMs) {
					throw new WorktreeFlowError("DOCS_CHANGED", `共享文档在预检后发生变化：${entry.source}`);
				}
				await fs.promises.mkdir(path.dirname(destination), { recursive: true });
				const noFollow = fs.constants.O_NOFOLLOW ?? 0;
				const input = await fs.promises.open(entry.source, fs.constants.O_RDONLY | noFollow);
				let output;
				try {
					const opened = await input.stat();
					if (!opened.isFile()
						|| opened.dev !== entry.dev || opened.ino !== entry.ino
						|| opened.size !== entry.size || opened.mtimeMs !== entry.mtimeMs || opened.ctimeMs !== entry.ctimeMs) {
						throw new WorktreeFlowError("DOCS_CHANGED", `共享文档在打开前发生变化：${entry.source}`);
					}
					output = await fs.promises.open(destination, "wx");
					const buffer = Buffer.allocUnsafe(64 << 10);
					let position = 0;
					for (;;) {
						if (options.signal?.aborted) throw options.signal.reason ?? new WorktreeFlowError("ABORTED", "共享文档快照已取消");
						const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
						if (bytesRead === 0) break;
						actualBytes += bytesRead;
						if (actualBytes > DOCS_BYTES_LIMIT) throw new WorktreeFlowError("DOCS_TOO_LARGE", "共享文档实际复制内容超过 100 MiB");
						let written = 0;
						while (written < bytesRead) {
							const result = await output.write(buffer, written, bytesRead - written, position + written);
							if (result.bytesWritten === 0) throw new WorktreeFlowError("DOCS_COPY_FAILED", `共享文档写入停滞：${entry.source}`);
							written += result.bytesWritten;
						}
						position += bytesRead;
					}
					const completed = await input.stat();
					if (position !== opened.size
						|| completed.dev !== opened.dev || completed.ino !== opened.ino
						|| completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs || completed.ctimeMs !== opened.ctimeMs) {
						throw new WorktreeFlowError("DOCS_CHANGED", `共享文档在复制期间发生变化：${entry.source}`);
					}
				} finally {
					if (output !== undefined) await output.close().catch(() => undefined);
					await input.close().catch(() => undefined);
				}
			}
		}
		await fs.promises.rename(tmp, target);
	} catch (error) {
		await removePlainTree(tmp, "共享文档临时目录").catch(() => undefined);
		throw error;
	}
	return {
		state: "ready",
		sourcePath: source,
		path: target,
		createdAt: new Date().toISOString(),
		fileCount: collected.fileCount,
		bytes: actualBytes
	};
}

export async function removeFeatureMeta(featureRoot) {
	const metaRoot = path.join(featureRoot, FEATURE_META_DIR);
	const metaStat = await fs.promises.lstat(metaRoot).catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (metaStat === undefined) return false;
	if (!metaStat.isDirectory() || metaStat.isSymbolicLink() || !isPathWithin(featureRoot, metaRoot)) {
		throw new WorktreeFlowError("BAD_LAYOUT", `功能区元数据目录不安全：${metaRoot}`);
	}
	await removePlainTree(path.join(metaRoot, DOCS_SNAPSHOT_DIR), "共享文档快照");
	const entries = await fs.promises.readdir(metaRoot, { withFileTypes: true });
	for (const entry of entries) {
		if (/^\.docs-[0-9a-f-]+\.tmp(?:\.remove-[0-9a-f-]+)?$/u.test(entry.name)
			|| /^docs\.remove-[0-9a-f-]+$/u.test(entry.name)) {
			await removePlainTree(path.join(metaRoot, entry.name), "共享文档临时目录");
		}
	}
	if ((await fs.promises.readdir(metaRoot)).length === 0) await fs.promises.rmdir(metaRoot);
	return true;
}

export async function removeDocsSnapshot(context, featureRoot) {
	const docs = context?.docsSnapshot;
	if (docs === undefined) return false;
	const expected = docsSnapshotPath(featureRoot);
	if (lexicalPath(docs.path) !== lexicalPath(expected)) {
		throw new WorktreeFlowError("BAD_LAYOUT", `共享文档快照路径无效：${docs.path}`);
	}
	return removeFeatureMeta(featureRoot);
}
