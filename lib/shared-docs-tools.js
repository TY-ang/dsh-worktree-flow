// @ts-check
/**
 * Model tools for editing one set's live shared-docs directory without opening
 * the whole host filesystem to a feature session. Paths are always relative to
 * the configured sharedDocsPath. Existing path components reject links, while
 * the DSH filesystem service provides canonical containment, stale guards,
 * cancellation, atomic publication, and a per-call sandbox rooted at that one
 * configured directory.
 *
 * @module dsh-worktree-flow/shared-docs-tools
 */
import fs from "node:fs";
import path from "node:path";
import { WorktreeFlowError, isPathWithin } from "./core.js";
import { findManifestForCwd } from "./context-note.js";
import { loadSet } from "./config.js";

const DOC_TEXT_LIMIT = 4 << 20;

function textResult(value) {
	return [{ type: "text", text: JSON.stringify(value) }];
}

function requireString(value, name, allowEmpty = false) {
	if (typeof value !== "string" || (!allowEmpty && value === "")) {
		throw new WorktreeFlowError("BAD_INPUT", `${name} 必须是${allowEmpty ? "" : "非空"}文本`);
	}
	return value;
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? new WorktreeFlowError("ABORTED", "共享 docs 操作已取消");
}

async function sharedDocsRoot(exec) {
	throwIfAborted(exec?.signal);
	const cwd = exec?.agent?.session?.header?.cwd;
	if (typeof cwd !== "string" || cwd === "") {
		throw new WorktreeFlowError("NO_FEATURE", "共享 docs 工具只能在功能工作区会话中使用");
	}
	const manifest = await findManifestForCwd(cwd);
	if (manifest === null) throw new WorktreeFlowError("NO_FEATURE", "当前会话不属于 Worktree Flow 功能工作区");
	const config = await loadSet(manifest.projectName);
	const configuredRoot = config?.sharedDocsPath;
	if (configuredRoot === undefined) throw new WorktreeFlowError("NO_DOCS", `仓库组 ${manifest.projectName} 未配置共享 docs 原始目录`);
	const stat = await fs.promises.lstat(configuredRoot).catch((error) => {
		if (error.code === "ENOENT") throw new WorktreeFlowError("NO_DOCS", `共享 docs 原始目录不存在：${configuredRoot}`);
		throw error;
	});
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new WorktreeFlowError("BAD_DOCS", `共享 docs 原始路径不是安全的普通目录：${configuredRoot}`);
	}
	const root = await fs.promises.realpath(configuredRoot);
	return { root, set: manifest.projectName, feature: manifest.feature };
}

async function resolveDocsFile(root, relativePath, allowMissing) {
	const relative = requireString(relativePath, "path");
	if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
		throw new WorktreeFlowError("BAD_DOCS_PATH", "共享 docs 工具只接受相对路径");
	}
	const target = path.resolve(root, relative);
	if (target === root || !isPathWithin(root, target)) {
		throw new WorktreeFlowError("BAD_DOCS_PATH", `共享 docs 路径越界：${relative}`);
	}
	const segments = path.relative(root, target).split(path.sep).filter(Boolean);
	let current = root;
	for (let index = 0; index < segments.length; index += 1) {
		current = path.join(current, segments[index]);
		const last = index === segments.length - 1;
		const stat = await fs.promises.lstat(current).catch((error) => {
			if (error.code === "ENOENT" && last && allowMissing) return undefined;
			throw error;
		});
		if (stat === undefined) continue;
		if (stat.isSymbolicLink()) throw new WorktreeFlowError("BAD_DOCS_PATH", `共享 docs 路径包含符号链接或目录联接：${current}`);
		if (!last && !stat.isDirectory()) throw new WorktreeFlowError("BAD_DOCS_PATH", `共享 docs 路径父级不是目录：${current}`);
		if (last && !stat.isFile()) throw new WorktreeFlowError("BAD_DOCS_PATH", `共享 docs 目标不是普通文件：${current}`);
		if (last && stat.nlink > 1) throw new WorktreeFlowError("BAD_DOCS_PATH", `共享 docs 工具拒绝修改硬链接文件：${current}`);
	}
	const realParent = await fs.promises.realpath(path.dirname(target));
	if (!isPathWithin(root, realParent)) throw new WorktreeFlowError("BAD_DOCS_PATH", `共享 docs 目标父级越界：${relative}`);
	return target;
}

async function confinedTarget(fileSystem, root, targetPath, signal) {
	throwIfAborted(signal);
	const [rootTarget, target] = await Promise.all([
		fileSystem.resolve(root, { signal }),
		fileSystem.resolve(targetPath, { signal })
	]);
	if (!fileSystem.contains(rootTarget, target)) {
		throw new WorktreeFlowError("BAD_DOCS_PATH", `共享 docs 目标越界：${targetPath}`);
	}
	return target;
}

function sandboxPolicy(root, exec) {
	const sessionId = exec?.agent?.session?.id;
	return {
		mode: "workspace-write",
		workspaceRoot: root,
		...(sessionId !== undefined ? { sessionId } : {})
	};
}

function docsWriteTool(fileSystem) {
	return {
		name: "worktree_docs_write",
		description: "Create or fully replace a UTF-8 file in the current Worktree Flow set's shared docs source. The parent directory must already exist. The path is relative to the configured sharedDocsPath; this tool is the scoped write path when that source is outside the session workspace.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string", description: "File path relative to the configured shared docs root." },
				content: { type: "string", description: "Complete UTF-8 file content." }
			},
			required: ["path", "content"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string" },
					bytes: { type: "number" },
					created: { type: "boolean" }
				},
				required: ["path", "bytes", "created"]
			},
			render: (_args, value) => textResult(value)
		},
		async execute(args, exec) {
			const content = requireString(args?.content, "content", true);
			const bytes = Buffer.byteLength(content, "utf8");
			if (bytes > DOC_TEXT_LIMIT) throw new WorktreeFlowError("DOCS_TOO_LARGE", `共享 docs 文本不能超过 ${DOC_TEXT_LIMIT} bytes`);
			const { root } = await sharedDocsRoot(exec);
			const targetPath = await resolveDocsFile(root, args?.path, true);
			const target = await confinedTarget(fileSystem, root, targetPath, exec?.signal);
			const before = await fileSystem.stat(target, exec?.signal);
			if (before !== undefined && before.type !== "file") throw new WorktreeFlowError("BAD_DOCS_PATH", `共享 docs 目标不是普通文件：${targetPath}`);
			const intent = before === undefined
				? { kind: "createIfAbsent" }
				: { kind: "replaceIfVersion", version: before.version };
			const outcome = await fileSystem.writeText(target, content, intent, exec?.signal, sandboxPolicy(root, exec));
			return { path: targetPath, bytes, created: outcome.operation === "create" };
		}
	};
}

function docsEditTool(fileSystem) {
	return {
		name: "worktree_docs_edit",
		description: "Atomically edit an existing UTF-8 file in the current Worktree Flow set's shared docs source by literal replacement. The path is relative to the configured sharedDocsPath.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string", description: "File path relative to the configured shared docs root." },
				old_string: { type: "string", description: "Literal text to replace." },
				new_string: { type: "string", description: "Literal replacement text; empty deletes the match." },
				replace_all: { type: "boolean", description: "Replace every match. Defaults to false." }
			},
			required: ["path", "old_string", "new_string"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string" },
					replacements: { type: "number" },
					bytes: { type: "number" }
				},
				required: ["path", "replacements", "bytes"]
			},
			render: (_args, value) => textResult(value)
		},
		async execute(args, exec) {
			const oldString = requireString(args?.old_string, "old_string");
			const newString = requireString(args?.new_string, "new_string", true);
			if (args?.replace_all !== undefined && typeof args.replace_all !== "boolean") {
				throw new WorktreeFlowError("BAD_INPUT", "replace_all 必须是布尔值");
			}
			const { root } = await sharedDocsRoot(exec);
			const targetPath = await resolveDocsFile(root, args?.path, false);
			const target = await confinedTarget(fileSystem, root, targetPath, exec?.signal);
			const info = await fileSystem.stat(target, exec?.signal);
			if (info === undefined || info.type !== "file") throw new WorktreeFlowError("BAD_DOCS_PATH", `共享 docs 目标不是普通文件：${targetPath}`);
			if ((info.size ?? 0) > DOC_TEXT_LIMIT) throw new WorktreeFlowError("DOCS_TOO_LARGE", `共享 docs 文本超过 ${DOC_TEXT_LIMIT} bytes：${targetPath}`);
			const before = await fileSystem.readText(target, exec?.signal);
			const replacements = before.split(oldString).length - 1;
			if (replacements === 0) throw new WorktreeFlowError("DOCS_EDIT_MISS", "old_string 在共享 docs 文件中不存在");
			if (args?.replace_all !== true && replacements !== 1) {
				throw new WorktreeFlowError("DOCS_EDIT_AMBIGUOUS", `old_string 出现 ${replacements} 次；请提供更具体的文本或设置 replace_all`);
			}
			const after = args?.replace_all === true
				? before.split(oldString).join(newString)
				: before.replace(oldString, newString);
			const bytes = Buffer.byteLength(after, "utf8");
			if (bytes > DOC_TEXT_LIMIT) throw new WorktreeFlowError("DOCS_TOO_LARGE", `编辑后共享 docs 文本超过 ${DOC_TEXT_LIMIT} bytes`);
			await fileSystem.editText(target, {
				oldString,
				newString,
				replaceAll: args?.replace_all === true
			}, { version: info.version }, exec?.signal, sandboxPolicy(root, exec));
			return { path: targetPath, replacements: args?.replace_all === true ? replacements : 1, bytes };
		}
	};
}

export function registerSharedDocsTools(ctx) {
	ctx.inject(["tools", "fs"], (toolCtx) => {
		toolCtx.tools.register(docsWriteTool(toolCtx.fs));
		toolCtx.tools.register(docsEditTool(toolCtx.fs));
	});
}
