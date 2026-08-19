// @ts-check
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import {
	createDocsSnapshot,
	deleteFeatureContext,
	normalizeSessionInstructions,
	prepareDocsSnapshot,
	readFeatureContext,
	removeDocsSnapshot,
	validateDocsSnapshot,
	writeFeatureContext
} from "../lib/feature-context.js";

function useHome(t, home) {
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	t.after(() => {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	});
}

test("session instructions normalize newlines and reject unsafe or oversized text", () => {
	assert.equal(normalizeSessionInstructions("  SQL 在 backend/sql/x\r\n先读 docs。  "), "SQL 在 backend/sql/x\n先读 docs。");
	assert.equal(normalizeSessionInstructions("  "), undefined);
	assert.throws(() => normalizeSessionInstructions("bad\u0000text"), (error) => error.code === "BAD_INSTRUCTIONS");
	assert.throws(() => normalizeSessionInstructions("x".repeat(17 * 1024)), (error) => error.code === "BAD_INSTRUCTIONS");
});

test("trusted feature context stores instructions and a sandbox-local docs snapshot", async (t) => {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-context-"));
	t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
	useHome(t, path.join(scratch, "dsh-home"));
	const source = path.join(scratch, "main-tree-docs");
	const featureRoot = path.join(scratch, "worktrees", "demo", "selection-v2");
	await fs.promises.mkdir(path.join(source, "design"), { recursive: true });
	await fs.promises.mkdir(featureRoot, { recursive: true });
	await fs.promises.writeFile(path.join(source, "README.md"), "project docs\n");
	await fs.promises.writeFile(path.join(source, "design", "api.md"), "api design\n");

	const docsSnapshot = await createDocsSnapshot(source, featureRoot);
	assert.equal(docsSnapshot.fileCount, 2);
	assert.equal(await fs.promises.readFile(path.join(docsSnapshot.path, "design", "api.md"), "utf8"), "api design\n");
	const written = await writeFeatureContext({
		version: 1,
		projectName: "demo",
		feature: "selection-v2",
		sessionInstructions: "SQL 在 backend/sql/selection-v2。",
		docsSnapshot,
		createdAt: new Date().toISOString()
	}, featureRoot);
	assert.equal(written.sessionInstructions, "SQL 在 backend/sql/selection-v2。");

	const loaded = await readFeatureContext("demo", "selection-v2", featureRoot);
	assert.equal(loaded?.docsSnapshot?.path, docsSnapshot.path);
	assert.equal(loaded?.docsSnapshot?.fileCount, 2);
	await assert.rejects(
		() => readFeatureContext("demo", "selection-v2", path.join(scratch, "other-root")),
		(error) => error.code === "BAD_FEATURE_CONTEXT"
	);
	assert.equal(await removeDocsSnapshot(loaded, featureRoot), true);
	assert.equal(fs.existsSync(docsSnapshot.path), false);
	assert.equal(await deleteFeatureContext("demo", "selection-v2"), true);
	assert.equal(await readFeatureContext("demo", "selection-v2", featureRoot), undefined);
});

test("workspace docs mutation does not suppress trusted instructions", async (t) => {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-context-mutated-docs-"));
	t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
	useHome(t, path.join(scratch, "dsh-home"));
	const source = path.join(scratch, "source");
	const featureRoot = path.join(scratch, "feature");
	const outside = path.join(scratch, "outside");
	await fs.promises.mkdir(path.join(source, "nested"), { recursive: true });
	await fs.promises.mkdir(featureRoot, { recursive: true });
	await fs.promises.mkdir(outside, { recursive: true });
	await fs.promises.writeFile(path.join(source, "nested", "guide.md"), "guide\n");
	await fs.promises.writeFile(path.join(outside, "outside.md"), "outside\n");
	const docsSnapshot = await createDocsSnapshot(source, featureRoot);
	await writeFeatureContext({
		version: 1,
		projectName: "demo",
		feature: "mutated",
		createdAt: new Date().toISOString(),
		sessionInstructions: "可信说明仍应注入。",
		docsSnapshot
	}, featureRoot);
	await fs.promises.rm(path.join(docsSnapshot.path, "nested"), { recursive: true, force: true });
	try {
		await fs.promises.symlink(outside, path.join(docsSnapshot.path, "nested"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (error.code === "EPERM" || error.code === "EACCES") {
			t.skip("platform does not permit creating a nested test link");
			return;
		}
		throw error;
	}
	const loaded = await readFeatureContext("demo", "mutated", featureRoot);
	assert.equal(loaded?.sessionInstructions, "可信说明仍应注入。");
	await assert.rejects(
		() => validateDocsSnapshot(loaded, featureRoot),
		(error) => error.code === "DOCS_CHANGED"
	);
});

test("docs preflight rejects links before feature-root side effects", async (t) => {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-context-link-"));
	t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
	const source = path.join(scratch, "docs");
	const outside = path.join(scratch, "outside.md");
	const featureRoot = path.join(scratch, "feature");
	await fs.promises.mkdir(source, { recursive: true });
	await fs.promises.writeFile(outside, "outside");
	try {
		await fs.promises.symlink(outside, path.join(source, "linked.md"), "file");
	} catch (error) {
		if (error.code === "EPERM" || error.code === "EACCES") {
			t.skip("platform does not permit creating a test symlink");
			return;
		}
		throw error;
	}
	await assert.rejects(
		() => prepareDocsSnapshot(source, featureRoot),
		(error) => error.code === "DOCS_SYMLINK"
	);
	assert.equal(fs.existsSync(featureRoot), false);
});

test("docs preflight bounds empty-directory depth", async (t) => {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-context-depth-"));
	t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
	const source = path.join(scratch, "source");
	let current = source;
	for (let index = 0; index < 66; index += 1) {
		current = path.join(current, `d${index}`);
		await fs.promises.mkdir(current, { recursive: true });
	}
	await assert.rejects(
		() => prepareDocsSnapshot(source, path.join(scratch, "feature")),
		(error) => error.code === "DOCS_TOO_LARGE"
	);
});

test("docs destination refuses a symlink or junction ancestor", async (t) => {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-context-destination-link-"));
	t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
	const source = path.join(scratch, "source");
	const featureRoot = path.join(scratch, "feature");
	const outside = path.join(scratch, "outside");
	await fs.promises.mkdir(source, { recursive: true });
	await fs.promises.mkdir(featureRoot, { recursive: true });
	await fs.promises.mkdir(outside, { recursive: true });
	await fs.promises.writeFile(path.join(source, "a.md"), "a");
	try {
		await fs.promises.symlink(outside, path.join(featureRoot, ".worktree-flow"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (error.code === "EPERM" || error.code === "EACCES") {
			t.skip("platform does not permit creating a test directory link");
			return;
		}
		throw error;
	}
	await assert.rejects(
		() => prepareDocsSnapshot(source, featureRoot),
		(error) => error.code === "BAD_LAYOUT"
	);
	assert.equal(fs.existsSync(path.join(outside, "docs", "a.md")), false);
});

test("docs copy rejects a source file replaced after preflight", async (t) => {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-context-source-swap-"));
	t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
	const source = path.join(scratch, "source");
	const featureRoot = path.join(scratch, "feature");
	await fs.promises.mkdir(source, { recursive: true });
	await fs.promises.mkdir(featureRoot, { recursive: true });
	const file = path.join(source, "guide.md");
	await fs.promises.writeFile(file, "before");
	const prepared = await prepareDocsSnapshot(source, featureRoot);
	await fs.promises.rm(file);
	await fs.promises.writeFile(file, "after!");
	await assert.rejects(
		() => createDocsSnapshot(source, featureRoot, { prepared }),
		(error) => error.code === "DOCS_CHANGED"
	);
});

test("docs copy rejects a source ancestor replaced by a junction after preflight", async (t) => {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-context-source-ancestor-"));
	t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
	const source = path.join(scratch, "source");
	const nested = path.join(source, "nested");
	const original = path.join(scratch, "original-nested");
	const outside = path.join(scratch, "outside");
	const featureRoot = path.join(scratch, "feature");
	await fs.promises.mkdir(nested, { recursive: true });
	await fs.promises.mkdir(outside, { recursive: true });
	await fs.promises.mkdir(featureRoot, { recursive: true });
	await fs.promises.writeFile(path.join(nested, "guide.md"), "inside\n");
	await fs.promises.writeFile(path.join(outside, "guide.md"), "outside\n");
	const prepared = await prepareDocsSnapshot(source, featureRoot);
	await fs.promises.rename(nested, original);
	try {
		await fs.promises.symlink(outside, nested, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (error.code === "EPERM" || error.code === "EACCES") {
			t.skip("platform does not permit creating a test source junction");
			return;
		}
		throw error;
	}
	await assert.rejects(
		() => createDocsSnapshot(source, featureRoot, { prepared }),
		(error) => error.code === "DOCS_CHANGED"
	);
	assert.equal(fs.existsSync(path.join(featureRoot, ".worktree-flow", "docs", "nested", "guide.md")), false);
});

test("docs cleanup refuses a swapped symlink or junction target", async (t) => {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-context-cleanup-link-"));
	t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
	const featureRoot = path.join(scratch, "feature");
	const metaRoot = path.join(featureRoot, ".worktree-flow");
	const outside = path.join(scratch, "outside");
	await fs.promises.mkdir(metaRoot, { recursive: true });
	await fs.promises.mkdir(outside, { recursive: true });
	await fs.promises.writeFile(path.join(outside, "keep.md"), "keep");
	try {
		await fs.promises.symlink(outside, path.join(metaRoot, "docs"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (error.code === "EPERM" || error.code === "EACCES") {
			t.skip("platform does not permit creating a test directory link");
			return;
		}
		throw error;
	}
	await assert.rejects(
		() => removeDocsSnapshot({ docsSnapshot: { path: path.join(metaRoot, "docs") } }, featureRoot),
		(error) => error.code === "BAD_LAYOUT"
	);
	assert.equal(await fs.promises.readFile(path.join(outside, "keep.md"), "utf8"), "keep");
});

test("docs snapshot refuses to overwrite an untrusted existing target", async (t) => {
	const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-wf-context-conflict-"));
	t.after(() => fs.promises.rm(scratch, { recursive: true, force: true }));
	const source = path.join(scratch, "docs");
	const featureRoot = path.join(scratch, "feature");
	await fs.promises.mkdir(source, { recursive: true });
	await fs.promises.mkdir(path.join(featureRoot, ".worktree-flow", "docs"), { recursive: true });
	await fs.promises.writeFile(path.join(source, "a.md"), "a");
	await assert.rejects(
		() => createDocsSnapshot(source, featureRoot),
		(error) => error.code === "DOCS_CONFLICT"
	);
});
