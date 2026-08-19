// @ts-check
/**
 * dsh-worktree-flow service: the single business-logic surface. Commands,
 * the settings page (via HTTP), and tests all call into WorktreeFlowService —
 * no rules live in the adapters.
 *
 * The domain object is the named workspace SET (see config.js): a group of
 * component repositories bound together, identified by name, stored
 * centrally. No anchor repository, no per-repo config file.
 *
 * Responsibilities:
 * - set CRUD + cwd→set resolution by pure path matching (cwd inside a bound
 *   component or inside a feature tree of the set);
 * - create feature workspaces (one git worktree per component + manifest +
 *   feature-root workspace registration);
 * - list/status with per-component git state and registration state;
 * - sync: adopt on-disk feature workspaces into the registry and repair
 *   manifest/registry drift;
 * - finish: archive (default: also unregister) and cleanup (guarded);
 * - first-run helpers: template prefill, component probing, git init.
 *
 * @module dsh-worktree-flow/service
 */
import fs from "node:fs";
import path from "node:path";
import {
	WorktreeFlowError,
	canonical,
	componentTitle,
	deriveFeatureFromBranch,
	featurePaths,
	featureTitle,
	isPathWithin,
	normalizeBranchName,
	normalizeComponentName,
	normalizeSetName,
	slugifyFeature
} from "./core.js";
import { configProblems, configRevision, expandHome, listSets, loadSet, readConfigTemplate, saveSet } from "./config.js";
import { LEGACY_MANIFEST_NAME, MANIFEST_NAME, readManifest, scanManifests, writeManifest } from "./manifest.js";
import { findManifestForCwd } from "./context-note.js";
import { registerFeature, registerWorkspace, registrationState, unregisterWorkspace } from "./registry.js";
import {
	branchExists,
	componentGitStatus,
	createLinkedWorktree,
	git,
	listGitWorktrees,
	mainRepoRootOf,
	removeWorktree,
	repoRootOf,
	resolveBaseRef
} from "./workspace.js";

/** How long one component git op may run before the command reports failure. */
const COMPONENT_TIMEOUT_MS = 60_000;

function deriveManifestStatus(components) {
	const states = Object.values(components).map((component) => component.state);
	if (states.some((state) => state === "pending")) return "creating";
	const succeeded = states.filter((state) => state === "created" || state === "existing").length;
	if (states.length > 0 && succeeded === states.length) return "ready";
	return succeeded > 0 ? "partial" : "failed";
}

export class WorktreeFlowService {
	/**
	 * @param {object} ctx - cordis ctx carrying `subprocess`; `workspaceRegistry`
	 *   is fetched per call with `ctx.get` (optional).
	 */
	constructor(ctx) {
		this.ctx = ctx;
		this.featureLocks = new Map();
	}

	async withFeatureLock(key, task) {
		const previous = this.featureLocks.get(key) ?? Promise.resolve();
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		const tail = previous.catch(() => undefined).then(() => gate);
		this.featureLocks.set(key, tail);
		await previous.catch(() => undefined);
		try {
			return await task();
		} finally {
			release();
			if (this.featureLocks.get(key) === tail) this.featureLocks.delete(key);
		}
	}

	featureSlug(feature) {
		const slug = slugifyFeature(feature);
		if (slug === "") throw new WorktreeFlowError("BAD_FEATURE", `功能标识无效：${feature}`);
		return slug;
	}

	// ------------------------------------------------------------- set CRUD

	/**
	 * List every set, shaped for pickers.
	 * @returns {Promise<Array<{name: string, label?: string, worktreeRoot: string, componentCount: number, ready: boolean}>>}
	 */
	async listSets() {
		return (await listSets()).map((config) => ({
			name: config.name,
			label: config.label,
			worktreeRoot: config.worktreeRoot,
			componentCount: Object.keys(config.repositories).length,
			// "配置完成" = 标量齐全 + 至少一个组件 + 每个组件都已绑定目录。
			ready: configProblems(config).length === 0
				&& Object.values(config.repositories).every((repo) => typeof repo.path === "string" && repo.path !== "")
		}));
	}

	/**
	 * Startup pass: retitle every ALREADY-registered feature root (and its
	 * registered component dirs) to the current title convention. Never
	 * registers unregistered dirs — an explicit 下架 stays 下架.
	 */
	async retitleRegistered(options = {}) {
		for (const config of await listSets()) {
			if (options.signal?.aborted) return;
			if (config.worktreeRoot === "") continue;
			const manifestErrors = [];
			const manifests = await scanManifests(config.worktreeRoot, config.name, { errors: manifestErrors }).catch(() => []);
			for (const loaded of manifests) {
				if (options.signal?.aborted) return;
				await this.withFeatureLock(`${config.name}/${loaded.manifest.feature}`, async () => {
					if (options.signal?.aborted) return;
					const current = await readManifest(loaded.featureRoot, {
						projectName: config.name,
						feature: loaded.manifest.feature
					});
					if (current === undefined) return;
					const manifest = current.manifest;
					const rootState = await registrationState(this.ctx, loaded.featureRoot).catch(() => ({ state: /** @type {const} */ ("unavailable") }));
					if (rootState.state === "registered" && rootState.title !== featureTitle(manifest.projectName, manifest.feature)) {
						if (options.signal?.aborted) return;
						await registerFeature(this.ctx, loaded.featureRoot, manifest.projectName, manifest.feature).catch(() => undefined);
					}
					for (const component of Object.values(manifest.components)) {
						if (options.signal?.aborted) return;
						if (component.state === "failed" || component.state === "pending") continue;
						const wanted = componentTitle(manifest.projectName, manifest.feature, component.name);
						const state = await registrationState(this.ctx, component.path).catch(() => ({ state: /** @type {const} */ ("unavailable") }));
						if (state.state === "registered" && state.title !== wanted) {
							await registerWorkspace(this.ctx, component.path, wanted).catch(() => undefined);
						}
					}
				});
			}
		}
	}

	/**
	 * Load one set by name or throw NO_SET.
	 * @param {string} name
	 * @returns {Promise<import("./config.js").SetConfig>}
	 */
	async getSet(name) {
		const config = await loadSet(name);
		if (config === undefined) {
			throw new WorktreeFlowError("NO_SET", `仓库组不存在：${name}。到 Settings → Worktree Flow 新建。`);
		}
		return config;
	}

	/**
	 * Create or overwrite a set config. Returns the file written.
	 * @param {import("./config.js").SetConfig} config
	 */
	async saveSetConfig(config, expectedRevision) {
		const name = normalizeSetName(config.name);
		return this.withFeatureLock(`config:${name}`, async () => {
			const current = await loadSet(name);
			if (expectedRevision !== undefined) {
				const actual = current === undefined ? null : configRevision(current);
				if (expectedRevision !== actual) {
					throw new WorktreeFlowError("CONFIG_CONFLICT", "仓库组配置已被其他页面修改，请刷新后重试。");
				}
			}
			const file = await saveSet({ ...config, name });
			const saved = await this.getSet(name);
			return { file, revision: configRevision(saved) };
		});
	}

	// ------------------------------------------------------- cwd resolution

	/**
	 * Resolve the set a cwd belongs to by pure path matching — no git calls:
	 * cwd inside a set's feature trees (<worktreeRoot>/<name>/…) or inside any
	 * explicitly bound component path. Returns null when nothing claims it.
	 * @param {string} cwd
	 * @returns {Promise<{config: import("./config.js").SetConfig, component?: string} | null>}
	 */
	async resolveForCwd(cwd) {
		const target = path.resolve(cwd);
		for (const config of await listSets()) {
			if (config.worktreeRoot.trim() !== "" && isPathWithin(path.join(config.worktreeRoot, config.name), target)) {
				return { config };
			}
			for (const [component, repo] of Object.entries(config.repositories)) {
				if (typeof repo.path === "string" && repo.path !== "" && isPathWithin(repo.path, target)) {
					return { config, component };
				}
			}
		}
		return null;
	}

	/**
	 * resolveForCwd that throws NO_SET with guidance (command surface).
	 * @param {string} cwd
	 */
	async resolveCwd(cwd) {
		const resolved = await this.resolveForCwd(cwd);
		if (resolved === null) {
			throw new WorktreeFlowError(
				"NO_SET",
				`当前目录不属于任何仓库组：${cwd}\n请在已绑定的组件仓库（或功能工作区）里使用，或到 Settings → Worktree Flow 新建仓库组。`
			);
		}
		return resolved;
	}

	// --------------------------------------------------------- create flow

	/**
	 * Build the creation plan without touching disk: per-component source
	 * repo, branch, base, target path, and pre-flight conflicts.
	 * @param {string} setName
	 * @param {import("./core.js").CreateIntent} intent
	 * @param {AbortSignal} [signal]
	 */
	async previewCreate(setName, intent, signal) {
		const config = await this.getSet(setName);
		const problems = configProblems(config);
		if (problems.length > 0) {
			throw new WorktreeFlowError("BAD_CONFIG", `配置不完整：\n- ${problems.join("\n- ")}`);
		}

		const branchInput = typeof intent.branch === "string" ? intent.branch.trim() : "";
		if (branchInput === "") {
			throw new WorktreeFlowError("BAD_BRANCH", "请填写完整分支名（例如 feature/selection-v2）。");
		}
		const branch = normalizeBranchName(branchInput);

		// 功能标识：显式给出时归一化；省略时从分支名最后一段派生。
		const featureInput = typeof intent.feature === "string" ? intent.feature.trim() : "";
		const feature = featureInput !== "" ? slugifyFeature(featureInput) : deriveFeatureFromBranch(branch);
		if (feature === "") {
			throw new WorktreeFlowError(
				"BAD_FEATURE",
				`无法生成有效功能标识：「${featureInput !== "" ? featureInput : branch}」\n分支名最后一段需要包含英文字母/数字（如 feature/selection-v2）。`
			);
		}

		const requestedComponents = intent.components.length > 0
			? intent.components
			: Object.keys(config.repositories);
		const components = [...new Set(requestedComponents.map(normalizeComponentName))];
		if (components.length !== requestedComponents.length) {
			throw new WorktreeFlowError("BAD_COMPONENT", "组件列表包含规范化后重复的名称");
		}
		if (components.length === 0) {
			throw new WorktreeFlowError("NO_COMPONENTS", "没有可用组件：请在仓库组里绑定组件仓库，或显式指定组件。");
		}
		for (const component of components) {
			const repo = config.repositories[component];
			if (repo === undefined) {
				throw new WorktreeFlowError(
					"UNKNOWN_COMPONENT",
					`组件未配置仓库映射：${component}\n已配置：${Object.keys(config.repositories).join(", ") || "(无)"}`
				);
			}
			if (typeof repo.path !== "string" || repo.path === "") {
				throw new WorktreeFlowError("UNBOUND_COMPONENT", `组件未绑定仓库目录：${component}（到配置页绑定后再创建）`);
			}
		}

		const paths = featurePaths({ worktreeRoot: config.worktreeRoot, projectName: config.name }, feature);
		if (!isPathWithin(config.worktreeRoot, paths.featureRoot)) {
			throw new WorktreeFlowError("BAD_LAYOUT", `功能根目录不在 worktreeRoot 内：${paths.featureRoot}`);
		}

		const plan = [];
		for (const component of components) {
			const repo = config.repositories[component];
			const repoPath = /** @type {string} */ (repo.path);
			// intent.baseBranch 直接来自 HTTP body：虽然 argv 无 shell 当前不
			// 可注入，仍走同一套分支名校验做纵深防御。
			const baseBranch = normalizeBranchName(intent.baseBranch ?? repo.defaultBaseBranch ?? config.defaultBaseBranch);
			const targetPath = paths.componentPath(component);
			if (canonical(targetPath) === canonical(paths.featureRoot) || !isPathWithin(paths.featureRoot, targetPath)) {
				throw new WorktreeFlowError("BAD_LAYOUT", `组件目标路径不在功能根目录内：${targetPath}`);
			}
			/** @type {string | undefined} */
			let note;
			if (fs.existsSync(targetPath)) {
				// Reuse is only legal when git already owns this exact pair.
				const worktrees = await listGitWorktrees(this.ctx, repoPath, signal).catch(() => []);
				const match = worktrees.find((entry) => canonical(entry.path) === canonical(targetPath));
				note = match === undefined
					? `冲突：目录已存在且不是 ${component} 仓库的 worktree`
					: match.branch === branch
						? "将复用（已是同分支 worktree）"
						: `冲突：已是 worktree 但分支为 ${match.branch ?? "detached"}`;
			} else if (await branchExists(this.ctx, repoPath, branch, signal)) {
				note = `分支 ${branch} 已存在，直接 checkout`;
			} else {
				note = `将基于 ${baseBranch} 新建分支 ${branch}`;
			}
			plan.push({
				component,
				repository: repoPath,
				label: repo.label ?? component,
				componentLabel: repo.label,
				branch,
				baseBranch,
				targetPath,
				note,
				conflict: note?.startsWith("冲突") === true
			});
		}

		return {
			feature,
			branch,
			featureRoot: paths.featureRoot,
			title: `${config.name}/${feature}`,
			projectName: config.name,
			setLabel: config.label,
			plan
		};
	}

	/**
	 * Create a feature workspace: git worktree per component, manifest at the
	 * feature root, then register the feature root as a DSH workspace.
	 * Partial failures keep what succeeded and record per-component errors;
	 * re-running is idempotent (existing pairs are reused).
	 * @param {string} setName
	 * @param {import("./core.js").CreateIntent} intent
	 * @param {{signal?: AbortSignal}} [options]
	 */
	async createFeature(setName, intent, options = {}) {
		const initial = await this.previewCreate(setName, intent, options.signal);
		if (intent.dryRun === true) return { ...initial, dryRun: true, results: [], status: "planned" };
		const key = `${initial.projectName}/${initial.feature}`;
		return this.withFeatureLock(key, async () => {
			const preview = await this.previewCreate(setName, intent, options.signal);
			return this.createFeatureUnlocked(preview, intent, options);
		});
	}

	async createFeatureUnlocked(preview, intent, options) {
		const conflicts = preview.plan.filter((row) => row.conflict);
		if (conflicts.length > 0) {
			throw new WorktreeFlowError(
				"CONFLICT",
				`创建前检查发现冲突，未做任何改动：\n${conflicts.map((row) => `- ${row.component}: ${row.note}`).join("\n")}`
			);
		}
		await fs.promises.mkdir(preview.featureRoot, { recursive: true });
		const existing = await readManifest(preview.featureRoot, {
			projectName: preview.projectName,
			feature: preview.feature
		});
		const now = new Date().toISOString();
		const planned = {};
		for (const row of preview.plan) {
			planned[row.component] = {
				name: row.component,
				repository: row.component,
				...(row.componentLabel !== undefined ? { label: row.componentLabel } : {}),
				sourcePath: row.repository,
				branch: row.branch,
				baseBranch: row.baseBranch,
				path: row.targetPath,
				state: "pending"
			};
		}
		const manifest = {
			version: 1,
			projectName: preview.projectName,
			feature: preview.feature,
			root: preview.featureRoot,
			sourceCwd: "",
			createdAt: existing?.manifest.createdAt ?? now,
			updatedAt: now,
			status: "creating",
			components: { ...existing?.manifest.components, ...planned }
		};
		// Persist intent before the first git side effect so an interrupted create
		// remains discoverable and recoverable instead of becoming an orphan.
		await writeManifest(preview.featureRoot, manifest);

		const results = [];
		for (const row of preview.plan) {
			if (options.signal?.aborted) throw options.signal.reason ?? new WorktreeFlowError("ABORTED", "创建已取消");
			const deadline = AbortSignal.timeout(COMPONENT_TIMEOUT_MS);
			const signal = options.signal !== undefined ? AbortSignal.any([options.signal, deadline]) : deadline;
			try {
				const outcome = await createLinkedWorktree(this.ctx, {
					repoPath: row.repository,
					targetPath: row.targetPath,
					branch: row.branch,
					baseBranch: row.baseBranch,
					signal
				});
				manifest.components[row.component] = { ...planned[row.component], state: outcome.state };
				results.push({ component: row.component, ok: true, state: outcome.state, path: row.targetPath });
			} catch (error) {
				if (options.signal?.aborted) throw options.signal.reason ?? error;
				const message = error instanceof Error ? error.message : String(error);
				manifest.components[row.component] = { ...planned[row.component], state: "failed", error: message };
				results.push({ component: row.component, ok: false, error: message });
			}
			manifest.status = deriveManifestStatus(manifest.components);
			await writeManifest(preview.featureRoot, manifest);
		}

		manifest.status = deriveManifestStatus(manifest.components);
		await writeManifest(preview.featureRoot, manifest);
		const succeeded = results.filter((row) => row.ok).length;
		let registration;
		if (succeeded > 0) {
			registration = await registerFeature(this.ctx, preview.featureRoot, preview.projectName, preview.feature)
				.catch(() => ({ state: "unavailable" }));
			if (intent.registerComponents === true) {
				for (const row of results.filter((entry) => entry.ok)) {
					await registerWorkspace(this.ctx, row.path, componentTitle(preview.projectName, preview.feature, row.component))
						.catch(() => undefined);
				}
			}
		}
		return { ...preview, dryRun: false, results, status: manifest.status, manifest, registration };
	}

	/**
	 * Enrich one manifest with live git + registration state.
	 * @param {import("./manifest.js").FeatureManifest} manifest
	 * @param {{withGit?: boolean, signal?: AbortSignal}} [options]
	 */
	async describeFeature(manifest, options = {}) {
		const registration = await registrationState(this.ctx, manifest.root);
		const components = {};
		for (const [componentName, component] of Object.entries(manifest.components)) {
			const gitStatus = options.withGit === false
				? { present: fs.existsSync(component.path) }
				: await componentGitStatus(this.ctx, {
					path: component.path,
					expectedBranch: component.branch,
					baseBranch: component.baseBranch,
					signal: options.signal
				}).catch(() => ({ present: fs.existsSync(component.path) }));
			const componentRegistration = await registrationState(this.ctx, component.path).catch(() => ({ state: "unregistered" }));
			components[componentName] = { ...component, git: gitStatus, registration: componentRegistration };
		}
		return { ...manifest, registration, components };
	}

	/**
	 * Reverse lookup for the conversation UI: which feature workspace (if any)
	 * owns this cwd, enriched with live git + registration state.
	 * @param {string} cwd
	 * @param {{signal?: AbortSignal}} [options]
	 */
	async locate(cwd, options = {}) {
		const manifest = await findManifestForCwd(cwd);
		if (manifest === null) return { found: false };
		return { found: true, set: manifest.projectName, feature: await this.describeFeature(manifest, options) };
	}

	/**
	 * List all feature workspaces of a set, enriched with git + registration
	 * state.
	 * @param {string} setName
	 * @param {{signal?: AbortSignal, withGit?: boolean}} [options]
	 */
	async listFeatures(setName, options = {}) {
		const config = await this.getSet(setName);
		const manifestErrors = [];
		const found = await scanManifests(config.worktreeRoot, config.name, { errors: manifestErrors });
		const features = [];
		for (const entry of found) {
			features.push({
				...(await this.describeFeature(entry.manifest, options)),
				legacyManifest: entry.legacy
			});
		}
		return { config, features, manifestErrors };
	}

	/**
	 * Sync: adopt every on-disk feature workspace of this set into the DSH
	 * workspace registry, migrate legacy manifests to the new file name, and
	 * report orphans (directories under <root>/<set> without a manifest).
	 * @param {string} setName
	 * @param {{register?: boolean, migrate?: boolean, signal?: AbortSignal}} [options]
	 */
	async sync(setName, options = {}) {
		const config = await this.getSet(setName);
		const register = options.register !== false;
		const migrate = options.migrate !== false;
		const manifestErrors = [];
		const found = await scanManifests(config.worktreeRoot, config.name, { errors: manifestErrors });
		const projectBase = path.join(config.worktreeRoot, config.name);

		const actions = manifestErrors.map((entry) => ({
			feature: path.basename(entry.featureRoot),
			action: "invalid-manifest",
			detail: entry.error
		}));
		for (const foundEntry of found) {
			if (options.signal?.aborted) throw options.signal.reason ?? new WorktreeFlowError("ABORTED", "同步已取消");
			const featureRoot = foundEntry.featureRoot;
			await this.withFeatureLock(`${config.name}/${foundEntry.manifest.feature}`, async () => {
				const current = await readManifest(featureRoot, {
					projectName: config.name,
					feature: foundEntry.manifest.feature
				});
				if (current === undefined) return;
				const manifest = current.manifest;
				if (manifest.archived === true || manifest.status === "archived") {
					actions.push({ feature: manifest.feature, action: "skip-archived", detail: featureRoot });
					return;
				}
				if (migrate && current.legacy) {
					await writeManifest(featureRoot, manifest);
					actions.push({ feature: manifest.feature, action: "migrated", detail: `.pi-workspace.json → .dsh-worktree.json` });
				}
				if (register) {
					const outcome = await registerFeature(this.ctx, featureRoot, manifest.projectName, manifest.feature);
					actions.push({ feature: manifest.feature, action: outcome.state, detail: featureRoot });
				}
			});
		}

		// Orphan scan: directories without any manifest.
		const orphans = [];
		let dirents = [];
		try {
			dirents = await fs.promises.readdir(projectBase, { withFileTypes: true });
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const manifested = new Set([
			...found.map((entry) => canonical(entry.featureRoot)),
			...manifestErrors.map((entry) => canonical(entry.featureRoot))
		]);
		for (const dirent of dirents) {
			if (!dirent.isDirectory()) continue;
			const dir = path.join(projectBase, dirent.name);
			if (!manifested.has(canonical(dir))) orphans.push(dir);
		}

		return { projectBase, actions, orphans };
	}

	/**
	 * Archive a feature workspace: mark the manifest archived and (by default)
	 * unregister the workspace record — the sidebar shows active features only.
	 * Files, branches and sessions are untouched.
	 * @param {string} setName
	 * @param {string} feature
	 * @param {{keepRegistered?: boolean, signal?: AbortSignal}} [options]
	 */
	async loadFeature(setName, feature) {
		const config = await this.getSet(setName);
		const slug = this.featureSlug(feature);
		const paths = featurePaths({ worktreeRoot: config.worktreeRoot, projectName: config.name }, slug);
		const loaded = await readManifest(paths.featureRoot, { projectName: config.name, feature: slug });
		if (loaded === undefined) throw new WorktreeFlowError("NO_FEATURE", `找不到功能工作区：${feature}（${paths.featureRoot} 无清单）`);
		return { config, slug, paths, loaded };
	}

	async registerFeatureWorkspace(setName, feature) {
		const initial = await this.loadFeature(setName, feature);
		return this.withFeatureLock(`${initial.config.name}/${initial.slug}`, async () => {
			const record = await this.loadFeature(setName, feature);
			return registerFeature(this.ctx, record.paths.featureRoot, record.config.name, record.slug);
		});
	}

	async unregisterFeatureWorkspace(setName, feature) {
		const initial = await this.loadFeature(setName, feature);
		return this.withFeatureLock(`${initial.config.name}/${initial.slug}`, async () => {
			const record = await this.loadFeature(setName, feature);
			return unregisterWorkspace(this.ctx, record.paths.featureRoot);
		});
	}

	async archiveFeature(setName, feature, options = {}) {
		const initial = await this.loadFeature(setName, feature);
		return this.withFeatureLock(`${initial.config.name}/${initial.slug}`, async () => {
			const { paths, loaded } = await this.loadFeature(setName, feature);
			const manifest = { ...loaded.manifest, archived: true, status: "archived" };
			await writeManifest(paths.featureRoot, manifest);
			let unregistered = { state: "skipped" };
			const componentUnregistered = [];
			if (options.keepRegistered !== true) {
				for (const component of Object.values(manifest.components)) {
					const outcome = await unregisterWorkspace(this.ctx, component.path).catch(() => ({ state: "unavailable" }));
					componentUnregistered.push({ component: component.name, state: outcome.state });
				}
				unregistered = await unregisterWorkspace(this.ctx, paths.featureRoot);
			}
			return { feature: manifest.feature, featureRoot: paths.featureRoot, unregistered: unregistered.state, componentUnregistered };
		});
	}

	cleanupBlockers(component, gitStatus) {
		const blockers = [];
		if (gitStatus.readError !== undefined) blockers.push(`git 状态读取失败：${gitStatus.readError}`);
		if ((gitStatus.changed ?? 0) > 0) blockers.push(`${gitStatus.changed} 个未提交变更`);
		if ((gitStatus.unpushed ?? 0) > 0) blockers.push(`${gitStatus.unpushed} 个未推送提交`);
		if (gitStatus.branchMismatch === true) blockers.push(`分支漂移：实际 ${gitStatus.branch} ≠ 期望 ${component.branch}`);
		return blockers;
	}

	async planCleanup(setName, feature, options = {}) {
		const { paths, loaded } = await this.loadFeature(setName, feature);
		const manifest = loaded.manifest;
		const registration = await registrationState(this.ctx, paths.featureRoot);
		const blockers = [];
		const fatalBlockers = [];
		if (registration.state === "registered" && (registration.sessionCount ?? 0) > 0) {
			blockers.push(`工作区下仍有 ${registration.sessionCount} 个会话（清理后它们归入 Ungrouped）`);
		}

		const components = [];
		for (const [componentName, component] of Object.entries(manifest.components)) {
			if ((component.state === "failed" || component.state === "pending") && fs.existsSync(component.path)) {
				const componentBlockers = ["创建未完成后残留目录，内容归属无法确认"];
				components.push({ component: componentName, path: component.path, ok: false, residual: true, blockers: componentBlockers });
				for (const blocker of componentBlockers) blockers.push(`${componentName}: ${blocker}`);
				continue;
			}
			if (component.state === "failed" || component.state === "pending") {
				components.push({ component: componentName, path: component.path, ok: true, note: "创建未完成且目录不存在，跳过" });
				continue;
			}
			const gitStatus = await componentGitStatus(this.ctx, {
				path: component.path,
				expectedBranch: component.branch,
				baseBranch: component.baseBranch,
				signal: options.signal
			}).catch((error) => ({ present: fs.existsSync(component.path), readError: error instanceof Error ? error.message : String(error) }));
			if (!gitStatus.present) {
				components.push({ component: componentName, path: component.path, ok: true, note: "目录已不存在，跳过" });
				continue;
			}
			const componentBlockers = this.cleanupBlockers(component, gitStatus);
			if (gitStatus.readError !== undefined) fatalBlockers.push(`${componentName}: git 状态读取失败：${gitStatus.readError}`);
			components.push({ component: componentName, path: component.path, ok: componentBlockers.length === 0, blockers: componentBlockers, git: gitStatus });
			for (const blocker of componentBlockers) blockers.push(`${componentName}: ${blocker}`);
		}
		return { feature: manifest.feature, featureRoot: paths.featureRoot, manifest, blockers, fatalBlockers, components };
	}

	async cleanupFeature(setName, feature, options = {}) {
		const initial = await this.loadFeature(setName, feature);
		return this.withFeatureLock(`${initial.config.name}/${initial.slug}`, async () => {
			const plan = await this.planCleanup(setName, feature, options);
			if (plan.fatalBlockers.length > 0) {
				throw new WorktreeFlowError("UNSAFE_STATE", `无法确认 Git 安全状态，已拒绝清理：\n- ${plan.fatalBlockers.join("\n- ")}`);
			}
			if (plan.blockers.length > 0 && options.force !== true) {
				throw new WorktreeFlowError("BLOCKED", `清理被阻止：\n- ${plan.blockers.join("\n- ")}`);
			}
			for (const row of plan.components) {
				const expected = path.join(plan.featureRoot, row.component);
				if (canonical(row.path) !== canonical(expected) || !isPathWithin(plan.featureRoot, row.path)) {
					throw new WorktreeFlowError("BAD_LAYOUT", `组件路径不在预期位置，已拒绝清理：${row.path}`);
				}
			}

			const removed = [];
			const failed = [];
			for (const row of plan.components) {
				if (!fs.existsSync(row.path)) {
					await unregisterWorkspace(this.ctx, row.path).catch(() => undefined);
					continue;
				}
				const component = plan.manifest.components[row.component];
				try {
					if (component.state === "failed" || component.state === "pending") {
						if (options.force !== true) throw new WorktreeFlowError("BLOCKED", "残留目录需要 --force 才能删除");
						await fs.promises.rm(row.path, { recursive: true, force: true });
					} else {
						// Shrink the plan→delete TOCTOU window: re-read immediately under
						// the feature lock and fail closed on every unknown field. Git's
						// own remove guard remains authoritative for external dirty writes.
						const fresh = await componentGitStatus(this.ctx, {
							path: component.path,
							expectedBranch: component.branch,
							baseBranch: component.baseBranch,
							signal: options.signal
						});
						if (fresh.readError !== undefined) throw new WorktreeFlowError("UNSAFE_STATE", fresh.readError);
						const freshBlockers = this.cleanupBlockers(component, fresh);
						if (freshBlockers.length > 0 && options.force !== true) throw new WorktreeFlowError("BLOCKED", freshBlockers.join("；"));
						await removeWorktree(this.ctx, {
							repoPath: component.sourcePath,
							targetPath: row.path,
							force: options.force === true,
							signal: options.signal
						});
					}
					removed.push(row.component);
					await unregisterWorkspace(this.ctx, row.path).catch(() => undefined);
				} catch (error) {
					if (options.signal?.aborted) throw options.signal.reason ?? error;
					failed.push(`${row.component}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			let unregistered = { state: "skipped" };
			let rootRemoved = false;
			if (failed.length > 0) {
				const partialManifest = { ...plan.manifest, status: "partial", components: { ...plan.manifest.components } };
				for (const componentName of removed) {
					partialManifest.components[componentName] = {
						...partialManifest.components[componentName],
						state: "failed",
						error: "清理已移除该组件；其他组件清理失败"
					};
				}
				await writeManifest(plan.featureRoot, partialManifest).catch((error) => {
					failed.push(`manifest: ${error instanceof Error ? error.message : String(error)}`);
				});
			}
			if (failed.length === 0) {
				unregistered = await unregisterWorkspace(this.ctx, plan.featureRoot);
				try {
					const leftovers = await fs.promises.readdir(plan.featureRoot);
					const allowed = new Set([MANIFEST_NAME, LEGACY_MANIFEST_NAME]);
					const onlyManifest = leftovers.every((entry) => allowed.has(entry));
					if (leftovers.length === 0 || onlyManifest) {
						await fs.promises.rm(plan.featureRoot, { recursive: true, force: true });
						rootRemoved = true;
					}
				} catch (error) {
					if (error.code === "ENOENT") rootRemoved = true;
					else throw error;
				}
			}
			return { feature: plan.feature, featureRoot: plan.featureRoot, removed, failed, unregistered: unregistered.state, rootRemoved };
		});
	}

	// ------------------------------------------------------- first-run aids

	/**
	 * Prefill values for a NEW set: the new-set template
	 * ($DSH_HOME/worktree-flow.json) supplies worktreeRoot, defaultBaseBranch
	 * and the component vocabulary (label/base only — paths bind per set).
	 * This is the ONLY reader of the template. No directory probing: a set is
	 * named first, repos are bound afterwards. Never writes.
	 */
	async prefillSet() {
		const template = await readConfigTemplate().catch(() => undefined);
		/** @type {Record<string, {label?: string, defaultBaseBranch?: string}>} */
		const repositories = {};
		for (const [name, entry] of Object.entries(template?.repositories ?? {})) {
			repositories[name] = {
				...(entry.label !== undefined ? { label: entry.label } : {}),
				...(entry.defaultBaseBranch !== undefined ? { defaultBaseBranch: entry.defaultBaseBranch } : {})
			};
		}
		return {
			worktreeRoot: template !== undefined ? template.worktreeRoot : "",
			defaultBaseBranch: template !== undefined && template.defaultBaseBranch.trim() !== "" ? template.defaultBaseBranch.trim() : "master",
			repositories
		};
	}

	/**
	 * Probe one directory as a component candidate: does it exist, is it (or
	 * inside) a git repo, and what is its default branch. Used by the binding
	 * row right after the user picks/types a path — feedback before save.
	 * @param {string} dir
	 * @param {AbortSignal} [signal]
	 */
	async probeComponent(dir, signal) {
		const target = path.resolve(/** @type {string} */ (expandHome(dir)));
		if (!fs.existsSync(target)) {
			throw new WorktreeFlowError("NO_SUCH_DIR", `目录不存在：${target}`);
		}
		const toplevel = await repoRootOf(this.ctx, target, signal);
		if (toplevel === undefined) return { path: target, isRepo: false };
		const repoRoot = (await mainRepoRootOf(this.ctx, target, signal)) ?? toplevel;
		let defaultBaseBranch = "master";
		const symref = await git(this.ctx, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot, signal);
		if (symref.exitCode === 0 && symref.stdout !== "") {
			defaultBaseBranch = symref.stdout.replace(/^origin\//u, "");
		} else {
			const current = await git(this.ctx, ["branch", "--show-current"], repoRoot, signal);
			if (current.exitCode === 0 && current.stdout !== "") defaultBaseBranch = current.stdout;
		}
		return { path: repoRoot, isRepo: true, defaultBaseBranch };
	}

	/**
	 * Initialize a bare-bones git repository in a directory the user wants to
	 * bind (`git init -b master`, so the built-in default base branch resolves
	 * immediately). Idempotent: already-inside-a-repo is a no-op.
	 * @param {string} cwd
	 * @param {AbortSignal} [signal]
	 */
	async gitInit(cwd, signal) {
		// 与 probeComponent 一致接受 ~/ 写法。
		const dir = path.resolve(/** @type {string} */ (expandHome(cwd)));
		const toplevel = await repoRootOf(this.ctx, dir, signal);
		if (toplevel !== undefined) return { repoRoot: toplevel, already: true };
		const result = await git(this.ctx, ["init", "-b", "master"], dir, signal);
		if (result.exitCode !== 0) {
			throw new WorktreeFlowError("GIT_INIT_FAILED", `git init 失败：${result.stderr !== "" ? result.stderr : result.stdout}`);
		}
		return { repoRoot: dir, already: false };
	}

	/**
	 * Validate a set config against reality: worktreeRoot writable, every
	 * bound component path exists and is a git repo, every base branch
	 * resolvable. Powers the settings page's inline validation.
	 * @param {string} setName
	 * @param {AbortSignal} [signal]
	 */
	async validateConfig(setName, signal) {
		const config = await this.getSet(setName);
		const problems = configProblems(config);

		/** @type {{path: string, exists: boolean, writable: boolean, note?: string}} */
		const worktreeRoot = { path: config.worktreeRoot, exists: false, writable: false };
		if (config.worktreeRoot.trim() !== "") {
			if (fs.existsSync(config.worktreeRoot)) {
				worktreeRoot.exists = true;
				try {
					await fs.promises.access(config.worktreeRoot, fs.constants.W_OK);
					worktreeRoot.writable = true;
				} catch {
					worktreeRoot.note = "目录存在但不可写";
				}
			} else {
				// Will be created on first use — check the nearest existing ancestor.
				let ancestor = path.dirname(config.worktreeRoot);
				while (!fs.existsSync(ancestor)) {
					const parent = path.dirname(ancestor);
					if (parent === ancestor) break;
					ancestor = parent;
				}
				try {
					await fs.promises.access(ancestor, fs.constants.W_OK);
					worktreeRoot.writable = true;
					worktreeRoot.note = "目录不存在，首次创建功能工作区时自动创建";
				} catch {
					worktreeRoot.note = `父目录不可写：${ancestor}`;
				}
			}
		}

		const components = [];
		for (const [name, repo] of Object.entries(config.repositories)) {
			const baseBranch = repo.defaultBaseBranch ?? config.defaultBaseBranch;
			/** @type {{name: string, label: string, path?: string, baseBranch: string, exists: boolean, isRepo: boolean, baseOk: boolean, issues: string[]}} */
			const row = { name, label: repo.label ?? name, path: repo.path, baseBranch, exists: false, isRepo: false, baseOk: false, issues: [] };
			const repoPath = typeof repo.path === "string" ? repo.path : "";
			if (repoPath === "") {
				row.issues.push("未绑定仓库目录");
			} else if (!fs.existsSync(repoPath)) {
				row.issues.push(`目录不存在：${repoPath}`);
			} else {
				row.exists = true;
				const toplevel = await repoRootOf(this.ctx, repoPath, signal).catch(() => undefined);
				row.isRepo = toplevel !== undefined;
				if (!row.isRepo) {
					row.issues.push("不是 git 仓库");
				} else {
					const baseRef = await resolveBaseRef(this.ctx, repoPath, baseBranch, signal).catch(() => undefined);
					row.baseOk = baseRef !== undefined;
					if (!row.baseOk) row.issues.push(`基准分支不存在（本地与 origin 都没有）：${baseBranch}`);
				}
			}
			components.push(row);
		}

		const ok = problems.length === 0
			&& worktreeRoot.path.trim() !== "" && worktreeRoot.writable
			&& components.length > 0
			&& components.every((row) => row.issues.length === 0);
		return { ok, problems, worktreeRoot, components };
	}

	/**
	 * Scan a directory's neighbours for git repositories that could be bound
	 * as components. The reference directory itself need not be a repo — this
	 * is a plain sibling scan used by the「自动发现」dialog.
	 * @param {string} cwd - the reference directory; its parent is scanned.
	 * @param {AbortSignal} [signal]
	 */
	async scanSiblingRepos(cwd, signal) {
		const dir = path.resolve(/** @type {string} */ (expandHome(cwd)));
		if (!fs.existsSync(dir)) {
			throw new WorktreeFlowError("NO_SUCH_DIR", `目录不存在：${dir}`);
		}
		const parent = path.dirname(dir);
		const prefix = `${path.basename(dir)}-`;
		const repos = [];
		let dirents = [];
		try {
			dirents = await fs.promises.readdir(parent, { withFileTypes: true });
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		for (const dirent of dirents) {
			if (!dirent.isDirectory()) continue;
			const sibling = path.join(parent, dirent.name);
			if (canonical(sibling) === canonical(dir)) continue;
			// Cheap membership test: .git exists as a dir (clone) or file (worktree).
			if (!fs.existsSync(path.join(sibling, ".git"))) continue;
			repos.push({
				name: dirent.name,
				path: sibling,
				suggestedComponent: dirent.name.startsWith(prefix) && dirent.name.length > prefix.length
					? dirent.name.slice(prefix.length)
					: undefined
			});
		}
		return { parent, repos };
	}
}
