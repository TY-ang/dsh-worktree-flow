// @ts-check
/**
 * Integration test: real git in scratch repos, fake ctx.subprocess backed by
 * node:child_process (same pattern as dsh-worktree's smoke test), in-memory
 * workspaceRegistry. Exercises the service end to end against the named-set
 * model: sets live in $DSH_HOME/worktree-flow/sets, cwd resolution is pure
 * path matching.
 *
 * Run: node test/integration.test.mjs
 */
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { WorktreeFlowService } from "../lib/service.js";
import { componentGitStatus, parseWorktreeList } from "../lib/workspace.js";
import { LEGACY_MANIFEST_NAME, MANIFEST_NAME, readManifest } from "../lib/manifest.js";
import { writeConfigTemplate } from "../lib/config.js";

/** Minimal SubprocessRuntime-shaped fake: spawns real git, collects output. */
function fakeSubprocess() {
	return {
		spawn(spec) {
			const child = spawn(spec.argv[0], spec.argv.slice(1), {
				cwd: spec.cwd,
				env: { ...process.env },
				stdio: ["ignore", "pipe", "pipe"]
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			const done = new Promise((resolve, reject) => {
				child.on("error", (error) => reject(new Error(`spawn ${spec.argv.join(" ")} in ${spec.cwd}: ${error.message}`, { cause: error })));
				child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
			});
			return {
				done,
				collected: {
					stdout: { readFrom: () => ({ text: stdout }) },
					stderr: { readFrom: () => ({ text: stderr }) }
				}
			};
		}
	};
}

/** In-memory workspace registry with host semantics (dedupe by path). */
function fakeRegistry() {
	const workspaces = new Map();
	let seq = 0;
	return {
		async create(dir, title) {
			for (const workspace of workspaces.values()) {
				if (workspace.path === dir) return workspace;
			}
			seq += 1;
			const workspace = {
				id: `ws-${seq}`,
				path: dir,
				title: title ?? dir,
				sessionIds: [],
				async setTitle(next) { workspace.title = next; },
				async status() { return fs.existsSync(dir) ? "ok" : "missing-dir"; }
			};
			workspaces.set(workspace.id, workspace);
			return workspace;
		},
		async resolveByPath(dir) {
			for (const workspace of workspaces.values()) if (workspace.path === dir) return workspace;
			return undefined;
		},
		async delete(id) { return workspaces.delete(id); },
		list() { return [...workspaces.values()]; }
	};
}

function fakeCtx(registry) {
	const subprocess = fakeSubprocess();
	return {
		subprocess,
		get(name) {
			if (name === "workspaceRegistry") return registry;
			return undefined;
		}
	};
}

async function run(cwd, argv) {
	return new Promise((resolve, reject) => {
		const child = spawn("git", argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => reject(new Error(`spawn git ${argv.join(" ")} in ${cwd}: ${error.message}`, { cause: error })));
		child.on("close", (exitCode) => {
			if (exitCode === 0) resolve(stdout.trim());
			else reject(new Error(`git ${argv.join(" ")} failed (${exitCode}): ${stderr.trim()}`));
		});
	});
}

async function initRepo(dir) {
	await fs.promises.mkdir(dir, { recursive: true });
	await run(dir, ["init", "-b", "master"]);
	await fs.promises.writeFile(path.join(dir, "README.md"), `repo ${path.basename(dir)}\n`);
	await run(dir, ["add", "README.md"]);
	await run(dir, ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "init"]);
}

const SET = "demo";

async function setup(t) {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-it-"));
	const previousDshHome = process.env.DSH_HOME;
	process.env.DSH_HOME = path.join(scratch, "dsh-home");
	await fs.promises.mkdir(process.env.DSH_HOME, { recursive: true });
	t.after(async () => {
		if (previousDshHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousDshHome;
		await fs.promises.rm(scratch, { recursive: true, force: true });
	});
	const backendRepo = path.join(scratch, "repos", "backend");
	const frontendRepo = path.join(scratch, "repos", "frontend");
	await initRepo(backendRepo);
	await initRepo(frontendRepo);
	const worktreeRoot = path.join(scratch, "wt");
	const registry = fakeRegistry();
	const ctx = fakeCtx(registry);
	const service = new WorktreeFlowService(ctx);
	await service.saveSetConfig({
		name: SET,
		worktreeRoot,
		defaultBaseBranch: "master",
		repositories: {
			backend: { label: "后端", path: backendRepo },
			frontend: { path: frontendRepo, defaultBaseBranch: "master" }
		}
	});
	return { scratch, backendRepo, frontendRepo, worktreeRoot, registry, ctx, service };
}

test("parseWorktreeList parses porcelain blocks", () => {
	const parsed = parseWorktreeList([
		"worktree D:/repos/backend",
		"HEAD 1111111111111111111111111111111111111111",
		"branch refs/heads/master",
		"",
		"worktree D:/wt/demo/review/backend",
		"HEAD 2222222222222222222222222222222222222222",
		"branch refs/heads/feature/review",
		"",
		"worktree D:/wt/detached",
		"HEAD 3333333333333333333333333333333333333333",
		"detached",
		""
	].join("\n"));
	assert.equal(parsed.length, 3);
	assert.equal(parsed[0].branch, "master");
	assert.equal(parsed[1].branch, "feature/review");
	assert.equal(parsed[2].branch, undefined);
});

test("componentGitStatus reports non-zero safety reads instead of failing open", async (t) => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-status-"));
	t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
	const ctx = {
		subprocess: {
			spawn() {
				return {
					done: Promise.resolve({ exitCode: 128, signal: undefined }),
					collected: {
						stdout: { readFrom: () => ({ text: "" }) },
						stderr: { readFrom: () => ({ text: "simulated git failure" }) }
					}
				};
			}
		}
	};
	const status = await componentGitStatus(ctx, { path: dir, expectedBranch: "feature/x", baseBranch: "master" });
	assert.equal(status.present, true);
	assert.match(status.readError ?? "", /无法读取当前分支|无法读取工作区状态/u);
});

test("getSet/listSets/resolveForCwd: the set model surface", async (t) => {
	const { scratch, backendRepo, worktreeRoot, service } = await setup(t);

	const listed = await service.listSets();
	assert.deepEqual(listed.map((row) => row.name), [SET]);
	assert.equal(listed[0].componentCount, 2);
	assert.equal(listed[0].ready, true, "fully bound set is ready");

	await assert.rejects(() => service.getSet("nope"), (error) => error.code === "NO_SET");

	// cwd inside a bound component → resolved with component name
	const inComponent = await service.resolveForCwd(path.join(backendRepo, "src", "deep"));
	assert.equal(inComponent?.config.name, SET);
	assert.equal(inComponent?.component, "backend");

	// cwd inside the set's feature trees → resolved (no component)
	const inFeature = await service.resolveForCwd(path.join(worktreeRoot, SET, "whatever"));
	assert.equal(inFeature?.config.name, SET);
	assert.equal(inFeature?.component, undefined);

	// unrelated cwd → null; resolveCwd throws NO_SET with guidance
	assert.equal(await service.resolveForCwd(path.join(scratch, "elsewhere")), null);
	await assert.rejects(() => service.resolveCwd(path.join(scratch, "elsewhere")), (error) => error.code === "NO_SET");
});

test("create requires a complete explicit branch name", async (t) => {
	const { service } = await setup(t);
	await assert.rejects(
		() => service.previewCreate(SET, { feature: "selection-v2", components: [] }),
		(error) => error.code === "BAD_BRANCH" && error.message.includes("完整分支名")
	);
});

test("feature slug derives from the branch when omitted", async (t) => {
	const { service } = await setup(t);
	const preview = await service.previewCreate(SET, { feature: "", components: ["backend"], branch: "feature/topic-x" });
	assert.equal(preview.feature, "topic-x");
	assert.equal(preview.title, "demo/topic-x");
	assert.ok(preview.featureRoot.endsWith(path.join(SET, "topic-x")), preview.featureRoot);

	// a non-ascii-only branch topic has no derivable slug
	await assert.rejects(
		() => service.previewCreate(SET, { feature: "", components: ["backend"], branch: "feature/修复" }),
		(error) => error.code === "BAD_FEATURE"
	);
});

test("unbound component refuses with UNBOUND_COMPONENT", async (t) => {
	const { backendRepo, service } = await setup(t);
	await service.saveSetConfig({
		name: SET,
		worktreeRoot: path.join(path.dirname(backendRepo), "unused"),
		defaultBaseBranch: "master",
		repositories: { backend: { path: backendRepo }, ghost: { label: "幽灵" } }
	});
	await assert.rejects(
		() => service.previewCreate(SET, { feature: "x1", components: [], branch: "feature/x1" }),
		(error) => error.code === "UNBOUND_COMPONENT" && error.message.includes("ghost")
	);
	// explicitly selected unknown component → UNKNOWN_COMPONENT
	await assert.rejects(
		() => service.previewCreate(SET, { feature: "x1", components: ["nope"], branch: "feature/x1" }),
		(error) => error.code === "UNKNOWN_COMPONENT"
	);
});

test("create → list → sync → archive → cleanup (full lifecycle, real git)", async (t) => {
	const { scratch, backendRepo, worktreeRoot, registry, service } = await setup(t);

	// preview: pure plan
	const preview = await service.previewCreate(SET, { feature: "Selection V2", components: [], branch: "feature/selection-v2" });
	assert.equal(preview.feature, "selection-v2");
	assert.equal(preview.branch, "feature/selection-v2");
	assert.equal(preview.title, "demo/selection-v2");
	assert.equal(preview.projectName, SET);
	assert.deepEqual(preview.plan.map((row) => row.component).sort(), ["backend", "frontend"]);
	assert.ok(preview.plan.every((row) => !row.conflict), JSON.stringify(preview.plan, null, 2));
	assert.ok(preview.plan.every((row) => row.note?.includes("新建分支")));

	// dry-run: no disk changes
	const dry = await service.createFeature(SET, { feature: "selection-v2", components: [], branch: "feature/selection-v2", dryRun: true });
	assert.equal(dry.status, "planned");
	assert.ok(!fs.existsSync(preview.featureRoot), "dry-run must not create the feature root");

	// real create
	const created = await service.createFeature(SET, { feature: "selection-v2", components: [], branch: "feature/selection-v2" });
	assert.equal(created.status, "ready");
	assert.equal(created.results.length, 2);
	for (const row of created.plan) {
		assert.ok(fs.existsSync(row.targetPath), `${row.component} worktree exists`);
		assert.equal(await run(row.targetPath, ["branch", "--show-current"]), "feature/selection-v2", `${row.component} on feature branch`);
	}
	assert.equal(created.registration?.state, "registered");
	assert.equal(registry.list().length, 1);
	assert.equal(registry.list()[0].title, "demo/selection-v2");
	assert.equal(registry.list()[0].path, preview.featureRoot);
	const manifest = await readManifest(preview.featureRoot);
	assert.equal(manifest?.manifest.status, "ready");
	assert.equal(manifest?.manifest.projectName, SET, "manifest carries the set name");
	assert.equal(Object.keys(manifest?.manifest.components ?? {}).length, 2);

	// idempotent re-create: reuse existing worktrees
	const again = await service.createFeature(SET, { feature: "selection-v2", components: [], branch: "feature/selection-v2" });
	assert.ok(again.results.every((row) => row.ok && row.state === "existing"), JSON.stringify(again.results));

	// cwd resolution reaches the set from inside a feature tree
	const resolved = await service.resolveForCwd(path.join(preview.featureRoot, "backend"));
	assert.equal(resolved?.config.name, SET);

	// list with live git state
	const listed = await service.listFeatures(SET);
	assert.equal(listed.features.length, 1);
	const feature = listed.features[0];
	assert.equal(feature.registration.state, "registered");
	assert.equal(feature.components.backend.git.present, true);
	assert.equal(feature.components.backend.git.branchMismatch, false);
	assert.equal(feature.components.backend.git.changed, 0);

	// make a commit in the backend worktree → ahead/unpushed surface
	const backendPath = feature.components.backend.path;
	await fs.promises.writeFile(path.join(backendPath, "change.txt"), "x\n");
	await run(backendPath, ["add", "change.txt"]);
	await run(backendPath, ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "work"]);
	const listed2 = await service.listFeatures(SET);
	assert.equal(listed2.features[0].components.backend.git.ahead, 1);
	assert.equal(listed2.features[0].components.backend.git.unpushed, 1);

	// cleanup blocked by unpushed commits
	const plan = await service.planCleanup(SET, "selection-v2");
	assert.ok(plan.blockers.some((blocker) => blocker.includes("未推送")), JSON.stringify(plan.blockers));
	await assert.rejects(
		() => service.cleanupFeature(SET, "selection-v2"),
		(error) => error.code === "BLOCKED"
	);

	// forced cleanup removes worktrees, unregisters, removes the root
	const cleaned = await service.cleanupFeature(SET, "selection-v2", { force: true });
	assert.deepEqual(cleaned.removed.sort(), ["backend", "frontend"]);
	assert.equal(cleaned.unregistered, "unregistered");
	assert.equal(cleaned.rootRemoved, true);
	assert.ok(!fs.existsSync(preview.featureRoot));
	assert.equal(registry.list().length, 0);

	// worktrees are really gone from git's view
	const remaining = await run(backendRepo, ["worktree", "list", "--porcelain"]);
	assert.ok(!remaining.includes("selection-v2"), remaining);
});

test("cleanup preserves unknown manifest-prefixed files and releases component registrations", async (t) => {
	const { registry, service } = await setup(t);
	const created = await service.createFeature(SET, {
		feature: "cleanup-guard",
		components: ["backend"],
		branch: "feature/cleanup-guard",
		registerComponents: true
	});
	assert.equal(registry.list().length, 2, "feature root + component are registered");
	const note = path.join(created.featureRoot, ".dsh-worktree-notes");
	await fs.promises.writeFile(note, "keep me\n");

	const cleaned = await service.cleanupFeature(SET, "cleanup-guard");
	assert.equal(cleaned.failed.length, 0);
	assert.equal(cleaned.rootRemoved, false, "unknown prefixed file prevents recursive root deletion");
	assert.ok(fs.existsSync(note), "user file is preserved");
	assert.equal(registry.list().length, 0, "root and component registrations are released");
});

test("invalid configured component names cannot escape the feature root", async (t) => {
	const { service, worktreeRoot } = await setup(t);
	await assert.rejects(
		() => service.saveSetConfig({
			name: SET,
			worktreeRoot,
			defaultBaseBranch: "master",
			repositories: { "../../escape": { path: worktreeRoot } }
		}),
		(error) => error.code === "BAD_COMPONENT"
	);
});

test("one invalid manifest is isolated instead of breaking the whole set", async (t) => {
	const { worktreeRoot, service } = await setup(t);
	await service.createFeature(SET, { feature: "healthy", components: ["backend"], branch: "feature/healthy" });
	const badRoot = path.join(worktreeRoot, SET, "bad");
	await fs.promises.mkdir(badRoot, { recursive: true });
	await fs.promises.writeFile(path.join(badRoot, MANIFEST_NAME), JSON.stringify({
		version: 1,
		projectName: SET,
		feature: "bad",
		root: worktreeRoot,
		sourceCwd: "",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "ready",
		components: {}
	}));
	const listed = await service.listFeatures(SET, { withGit: false });
	assert.deepEqual(listed.features.map((entry) => entry.feature), ["healthy"]);
	assert.equal(listed.manifestErrors.length, 1);
	const synced = await service.sync(SET);
	assert.ok(synced.actions.some((action) => action.action === "invalid-manifest" && action.feature === "bad"));
	assert.ok(!synced.orphans.includes(badRoot), "invalid manifest is diagnosed, not mislabeled as an orphan");
});

test("sync adopts legacy manifests (migrate + register) and reports orphans", async (t) => {
	const { backendRepo, worktreeRoot, registry, service } = await setup(t);

	// a legacy feature: manifest only under the Pi-era name
	const legacyRoot = path.join(worktreeRoot, SET, "review");
	const legacyBackend = path.join(legacyRoot, "backend");
	await fs.promises.mkdir(legacyBackend, { recursive: true });
	await run(backendRepo, ["worktree", "add", "-b", "feature/review", legacyBackend, "master"]);
	await fs.promises.writeFile(
		path.join(legacyRoot, LEGACY_MANIFEST_NAME),
		JSON.stringify({
			version: 1,
			projectName: SET,
			feature: "review",
			root: legacyRoot,
			sourceCwd: "",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			status: "ready",
			components: {
				backend: {
					name: "backend",
					repository: "backend",
					sourcePath: backendRepo,
					branch: "feature/review",
					baseBranch: "master",
					path: legacyBackend,
					state: "created"
				}
			}
		})
	);
	// an orphan dir with no manifest
	await fs.promises.mkdir(path.join(worktreeRoot, SET, "orphan"));

	const syncResult = await service.sync(SET);
	const reviewActions = syncResult.actions.filter((action) => action.feature === "review").map((action) => action.action);
	assert.ok(reviewActions.includes("migrated"), JSON.stringify(syncResult.actions));
	assert.ok(reviewActions.includes("registered"), JSON.stringify(syncResult.actions));
	assert.ok(syncResult.orphans.some((orphan) => orphan.endsWith("orphan")), JSON.stringify(syncResult.orphans));
	assert.equal(registry.list()[0]?.title, "demo/review");
	// migration wrote the new manifest; legacy file stays as-is
	assert.ok(fs.existsSync(path.join(legacyRoot, MANIFEST_NAME)));
	assert.ok(fs.existsSync(path.join(legacyRoot, LEGACY_MANIFEST_NAME)));

	// archived features are skipped by sync
	const archivedRoot = path.join(worktreeRoot, SET, "done");
	await fs.promises.mkdir(archivedRoot, { recursive: true });
	await fs.promises.writeFile(
		path.join(archivedRoot, MANIFEST_NAME),
		JSON.stringify({
			version: 1, projectName: SET, feature: "done", root: archivedRoot, sourceCwd: "",
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			status: "archived", archived: true, components: {}
		})
	);
	const again = await service.sync(SET);
	assert.ok(again.actions.some((action) => action.feature === "done" && action.action === "skip-archived"));
});

test("archive unregisters by default; keepRegistered preserves", async (t) => {
	const { registry, service } = await setup(t);

	await service.createFeature(SET, { feature: "v1", components: ["backend"], branch: "feature/v1" });
	assert.equal(registry.list().length, 1);

	const archived = await service.archiveFeature(SET, "v1");
	assert.equal(archived.unregistered, "unregistered");
	assert.equal(registry.list().length, 0);

	await service.createFeature(SET, { feature: "v2", components: ["backend"], branch: "feature/v2" });
	const kept = await service.archiveFeature(SET, "v2", { keepRegistered: true });
	assert.equal(kept.unregistered, "skipped");
	assert.equal(registry.list().length, 1, "still registered");
});

test("conflicts refuse before touching disk", async (t) => {
	const { scratch, service } = await setup(t);

	// occupy the frontend target with a foreign directory
	const foreign = path.join(scratch, "wt", SET, "clash", "frontend");
	await fs.promises.mkdir(foreign, { recursive: true });

	await assert.rejects(
		() => service.createFeature(SET, { feature: "clash", components: ["backend", "frontend"], branch: "feature/clash" }),
		(error) => error.code === "CONFLICT" && error.message.includes("frontend")
	);
	assert.ok(!fs.existsSync(path.join(scratch, "wt", SET, "clash", "backend")), "no partial creation");
});

test("concurrent creates of one feature serialize and preserve one valid manifest", async (t) => {
	const { service } = await setup(t);
	const intent = { feature: "concurrent", components: ["backend"], branch: "feature/concurrent" };
	const [first, second] = await Promise.all([
		service.createFeature(SET, intent),
		service.createFeature(SET, intent)
	]);
	assert.equal(first.status, "ready");
	assert.equal(second.status, "ready");
	assert.deepEqual([first.results[0].state, second.results[0].state].sort(), ["created", "existing"]);
	const loaded = await readManifest(first.featureRoot, { projectName: SET, feature: "concurrent" });
	assert.equal(loaded?.manifest.status, "ready");
	assert.deepEqual(Object.keys(loaded?.manifest.components ?? {}), ["backend"]);
});

test("partial failure is recorded and retriable", async (t) => {
	const { scratch, backendRepo, service } = await setup(t);

	// point the frontend repo at a path that is not a git repo
	const broken = path.join(scratch, "not-a-repo");
	await fs.promises.mkdir(broken, { recursive: true });
	await service.saveSetConfig({
		name: SET,
		worktreeRoot: path.join(scratch, "wt"),
		defaultBaseBranch: "master",
		repositories: { backend: { path: backendRepo }, frontend: { path: broken } }
	});

	const result = await service.createFeature(SET, { feature: "partial", components: [], branch: "feature/partial" });
	assert.equal(result.status, "partial");
	assert.equal(result.results.find((row) => row.component === "backend")?.ok, true);
	assert.equal(result.results.find((row) => row.component === "frontend")?.ok, false);
	// manifest records the failure; feature root still registered (backend usable)
	const manifest = await readManifest(result.featureRoot);
	assert.equal(manifest?.manifest.status, "partial");
	assert.equal(manifest?.manifest.components.frontend.state, "failed");
	assert.equal(result.registration?.state, "registered");

	// Retrying only the healthy subset must derive status from the merged
	// manifest, not incorrectly report ready from this invocation alone.
	const retried = await service.createFeature(SET, { feature: "partial", components: ["backend"], branch: "feature/partial" });
	assert.equal(retried.status, "partial");
	assert.equal(retried.manifest.components.frontend.state, "failed");
});

test("validateConfig: healthy config passes, broken pieces surface inline", async (t) => {
	const { scratch, backendRepo, frontendRepo, service } = await setup(t);

	const healthy = await service.validateConfig(SET);
	assert.equal(healthy.ok, true, JSON.stringify(healthy, null, 2));
	assert.equal(healthy.worktreeRoot.exists, false, "wt root not created yet");
	assert.equal(healthy.worktreeRoot.writable, true, "creatable under a writable ancestor");
	assert.ok(healthy.worktreeRoot.note?.includes("自动创建"));
	for (const row of healthy.components) {
		assert.equal(row.exists, true, row.name);
		assert.equal(row.isRepo, true, row.name);
		assert.equal(row.baseOk, true, row.name);
		assert.deepEqual(row.issues, [], row.name);
	}

	// missing dir + missing base branch + unbound component all surface as issues
	const missing = path.join(scratch, "gone");
	await service.saveSetConfig({
		name: SET,
		worktreeRoot: path.join(scratch, "wt"),
		defaultBaseBranch: "master",
		repositories: {
			backend: { path: backendRepo },
			gone: { path: missing },
			badbase: { path: frontendRepo, defaultBaseBranch: "no-such-branch" },
			unbound: { label: "未绑定" }
		}
	});
	const broken = await service.validateConfig(SET);
	assert.equal(broken.ok, false);
	const byName = new Map(broken.components.map((row) => [row.name, row]));
	assert.ok(byName.get("gone")?.issues.some((issue) => issue.includes("目录不存在")), JSON.stringify(byName.get("gone")));
	assert.ok(byName.get("badbase")?.issues.some((issue) => issue.includes("基准分支不存在")), JSON.stringify(byName.get("badbase")));
	assert.ok(byName.get("unbound")?.issues.some((issue) => issue.includes("未绑定仓库目录")), JSON.stringify(byName.get("unbound")));
	assert.deepEqual(byName.get("backend")?.issues, []);
});

test("prefillSet is template-only: no probing, paths stripped", async (t) => {
	const { scratch, service } = await setup(t);

	// No template: empty defaults.
	const plain = await service.prefillSet();
	assert.equal(plain.worktreeRoot, "");
	assert.equal(plain.defaultBaseBranch, "master");
	assert.deepEqual(plain.repositories, {});

	// Template supplies habits; paths in the template are stripped (vocabulary only).
	await writeConfigTemplate({
		worktreeRoot: path.join(scratch, "template-wt"),
		defaultBaseBranch: "main",
		repositories: {
			backend: { label: "后端" },
			frontend: { label: "前端", defaultBaseBranch: "dev", path: "D:/should-be-stripped" }
		}
	});
	const prefill = await service.prefillSet();
	assert.equal(prefill.worktreeRoot, path.join(scratch, "template-wt"));
	assert.equal(prefill.defaultBaseBranch, "main");
	assert.equal(prefill.repositories.backend.label, "后端");
	assert.equal(prefill.repositories.backend.path, undefined, "vocabulary only");
	assert.equal(prefill.repositories.frontend.defaultBaseBranch, "dev");
});

test("probeComponent: repo / worktree / non-repo / missing", async (t) => {
	const { scratch, backendRepo, service } = await setup(t);

	// main clone: isRepo + probed default branch (current branch, no origin)
	const probed = await service.probeComponent(backendRepo);
	assert.equal(probed.isRepo, true);
	assert.equal(probed.path, backendRepo);
	assert.equal(probed.defaultBaseBranch, "master");

	// a linked worktree resolves to the MAIN clone root
	const linked = path.join(scratch, "linked-wt");
	await run(backendRepo, ["worktree", "add", "-b", "topic", linked, "master"]);
	const fromLinked = await service.probeComponent(linked);
	assert.equal(fromLinked.isRepo, true);
	assert.equal(fromLinked.path, backendRepo, "linked worktree → main clone");

	// non-repo directory
	const plain = path.join(scratch, "plain");
	await fs.promises.mkdir(plain, { recursive: true });
	const notRepo = await service.probeComponent(plain);
	assert.equal(notRepo.isRepo, false);

	// missing directory
	await assert.rejects(
		() => service.probeComponent(path.join(scratch, "nope")),
		(error) => error.code === "NO_SUCH_DIR"
	);
});

test("gitInit initializes a picked non-git directory; probe then sees a repo", async (t) => {
	const { scratch, service } = await setup(t);
	const plain = path.join(scratch, "plain-dir");
	await fs.promises.mkdir(plain, { recursive: true });

	const initialized = await service.gitInit(plain);
	assert.equal(initialized.already, false);
	assert.equal(initialized.repoRoot, plain);
	const probed = await service.probeComponent(plain);
	assert.equal(probed.isRepo, true);
	assert.equal(probed.defaultBaseBranch, "master", "init -b master");

	// Idempotent: re-init inside the new repo is a no-op.
	const again = await service.gitInit(plain);
	assert.equal(again.already, true);
});

test("scanSiblingRepos lists neighbouring git repos; reference need not be a repo", async (t) => {
	const { scratch, backendRepo, service } = await setup(t);
	// a sibling matching the <ref>-<component> shape: backend-api
	const apiRepo = path.join(scratch, "repos", "backend-api");
	await initRepo(apiRepo);
	// a non-repo sibling directory is ignored
	const docs = path.join(scratch, "repos", "docs");
	await fs.promises.mkdir(docs, { recursive: true });

	const scan = await service.scanSiblingRepos(backendRepo);
	assert.equal(scan.parent, path.join(scratch, "repos"));
	const names = scan.repos.map((repo) => repo.name).sort();
	assert.deepEqual(names, ["backend-api", "frontend"]);
	assert.ok(!scan.repos.some((repo) => repo.path === backendRepo), "reference excluded");
	assert.equal(scan.repos.find((repo) => repo.name === "backend-api")?.suggestedComponent, "api");
	assert.equal(scan.repos.find((repo) => repo.name === "frontend")?.suggestedComponent, undefined);

	// relaxed: scanning from a NON-repo sibling works too (plain sibling scan)
	const fromDocs = await service.scanSiblingRepos(docs);
	assert.ok(fromDocs.repos.length >= 3);
	assert.ok(!fromDocs.repos.some((repo) => repo.path === docs));

	// missing reference dir errors
	await assert.rejects(
		() => service.scanSiblingRepos(path.join(scratch, "repos", "nope")),
		(error) => error.code === "NO_SUCH_DIR"
	);
});
