// @ts-check
/** Unit tests for core.js — pure helpers. Run: node --test test/ */
import test from "node:test";
import path from "node:path";
import { strict as assert } from "node:assert";
import {
	WorktreeFlowError,
	canonical,
	deriveFeatureFromBranch,
	featurePaths,
	featureTitle,
	componentTitle,
	isPathWithin,
	normalizeBranchName,
	normalizeComponentName,
	parseNaturalIntent,
	slugifyFeature
} from "../lib/core.js";

test("slugifyFeature: spaces/underscores/case collapse to kebab", () => {
	assert.equal(slugifyFeature("Selection V2"), "selection-v2");
	assert.equal(slugifyFeature("  selection_v2  "), "selection-v2");
	assert.equal(slugifyFeature("feat--x"), "feat-x");
	assert.equal(slugifyFeature("-lead-trail-"), "lead-trail");
});

test("slugifyFeature: non-ascii drops out, empty when nothing survives", () => {
	assert.equal(slugifyFeature("评审功能"), "");
	assert.equal(slugifyFeature("评审 review 功能"), "review");
});

test("deriveFeatureFromBranch: last path segment wins, no silent fallback", () => {
	assert.equal(deriveFeatureFromBranch("feature/selection-v2"), "selection-v2");
	assert.equal(deriveFeatureFromBranch("feat/ui/selection_v2"), "selection-v2");
	assert.equal(deriveFeatureFromBranch("selection-v2"), "selection-v2");
	assert.equal(deriveFeatureFromBranch("hotfix/修复"), "", "non-ascii topic must error, not degrade to 'hotfix'");
	assert.equal(deriveFeatureFromBranch("修复"), "");
});

test("slugifyFeature: capped at 64 chars", () => {
	const long = "a".repeat(100);
	assert.equal(slugifyFeature(long).length, 64);
	assert.ok(!slugifyFeature(`${"b".repeat(63)}-`).endsWith("-"));
});

test("normalizeComponentName: valid tokens pass, bad ones throw BAD_COMPONENT", () => {
	assert.equal(normalizeComponentName("Backend"), "backend");
	assert.equal(normalizeComponentName("xcs_web-1"), "xcs_web-1");
	assert.throws(() => normalizeComponentName("has space"), (e) => e instanceof WorktreeFlowError && e.code === "BAD_COMPONENT");
	assert.throws(() => normalizeComponentName("-lead"), (e) => e.code === "BAD_COMPONENT");
	assert.throws(() => normalizeComponentName("a/b"), (e) => e.code === "BAD_COMPONENT");
});

test("normalizeBranchName: rejects git-forbidden shapes", () => {
	assert.equal(normalizeBranchName("feature/selection-v2"), "feature/selection-v2");
	assert.throws(() => normalizeBranchName("feature/../x"), (e) => e.code === "BAD_BRANCH");
	assert.throws(() => normalizeBranchName("bad name"), (e) => e.code === "BAD_BRANCH");
	assert.throws(() => normalizeBranchName("trailing/"), (e) => e.code === "BAD_BRANCH");
	for (const invalid of [".foo", "foo.", "foo.lock", "foo@{bar}", "foo//bar", "@", "feature/.hidden"]) {
		assert.throws(() => normalizeBranchName(invalid), (e) => e.code === "BAD_BRANCH", invalid);
	}
	assert.throws(() => normalizeBranchName(""), (e) => e.code === "BAD_BRANCH");
});

test("featurePaths/title conventions", () => {
	const paths = featurePaths({ worktreeRoot: "D:/wt", projectName: "test" }, "selection-v2");
	assert.equal(paths.featureRoot, path.join("D:/wt", "test", "selection-v2"));
	assert.equal(paths.componentPath("backend"), path.join("D:/wt", "test", "selection-v2", "backend"));
	assert.equal(featureTitle("test", "selection-v2"), "test/selection-v2");
	assert.equal(componentTitle("test", "selection-v2", "backend"), "test/selection-v2/backend");
});

test("isPathWithin: containment with canonical compare", () => {
	assert.ok(isPathWithin("D:/wt", "D:/wt/test/review"));
	assert.ok(isPathWithin("D:/wt", "D:/wt"));
	assert.ok(!isPathWithin("D:/wt", "D:/other"));
	assert.ok(!isPathWithin("D:/wt", "D:/wt2/sibling"));
	if (process.platform === "win32") {
		assert.ok(isPathWithin("d:/wt", "D:/WT/test"), "win32 compare is case-insensitive");
	}
});

test("canonical: nonexistent path falls back to lexical resolve", () => {
	assert.equal(canonical("D:/definitely-not-here-xyz"), path.resolve("D:/definitely-not-here-xyz").toLowerCase());
});

test("parseNaturalIntent: keyword pre-check + ascii feature extraction", () => {
	const parsed = parseNaturalIntent("做一个 selection-v3，前后端都要", ["backend", "frontend", "xcsweb"]);
	assert.equal(parsed.feature, "selection-v3");
	assert.deepEqual(parsed.components.sort(), ["backend", "frontend"]);
	const none = parseNaturalIntent("随便写点中文", ["backend"]);
	assert.equal(none.feature, "");
	assert.deepEqual(none.components, []);
});
