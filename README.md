# dsh-worktree-flow

English | [中文](README.zh.md)

A **multi-repo feature workspace** plugin for DSH (DeepSeek Harness): one feature/version = one directory holding a git worktree per component repository, all on one shared feature branch — and the feature root is registered as a **DSH workspace**, so you pick it in the sidebar/new-session workspace picker and the session sandbox lands exactly on that feature scope.

The core concept is the **set**: bind several repositories together under a name, stored centrally (`$DSH_HOME/worktree-flow/sets/<name>.json`). No anchor repository, no config files inside any repo.

## What it solves

Your workflow: one district per feature, writing frontend + backend + API in a single session. The pain: forget to declare directories/branches in the prompt and the agent writes in the wrong place.

Three layers make "wrong branch" physically impossible:

1. **Sandbox**: the session can only write inside the feature root — the main checkout and other features are physically out of reach;
2. **Pre-created branches**: every component worktree is checked out on the feature branch at creation time, so writes land on the right branch by default;
3. **Identity note**: when a session lives in a feature workspace, its first step auto-injects a one-shot layout/branch/constraint note — no path declarations needed in your prompts.

## Install

```powershell
dsh plugin --profile web add <this-repo-path>
# the package declares dsh.bundle, so it joins the profile layer stack automatically
```

Restart `dsh web` afterwards.

This package is not published to the npm registry (`"private": true` stays in package.json) — install it from a local path or a git URL.

## Usage

Primary entry: the **Settings → Worktree Flow** page

- Two primary tabs only: **配置** (config) and **功能工作区** (feature workspaces)
- **Config**: set list + editor. Create a set with「+ 新建仓库组」(the name becomes part of feature directory names and is immutable); initial content is prefilled once from the "new-set template". Then bind components: a collapsed row shows just "name → path"; expand to edit — pick a directory with「选择…」and it is probed immediately (is it a git repo? what is the base branch?); picking a non-git directory offers an inline「初始化 git 仓库」button. Saving runs inline validation (path exists / is a git repo / base branch resolvable / worktree root writable), and a dry-run create preview sits at the bottom.
- **自动发现** (auto-discover): anchored at a reference directory, scans its neighbouring git repositories for bulk binding (renameable component names, manual opt-in checkboxes, search + pagination); with nothing bound yet, pick a reference directory first.
- **新仓库组模板**: a collapsed card at the bottom of the config tab editing `$DSH_HOME/worktree-flow.json` — read ONCE when a set is created (worktree root, default base branch, component vocabulary); never affects existing sets.
- **Feature workspaces**: pick a set, then browse feature groups (branch / dirty / ahead-behind / unpushed / registration state / session count), archive and cleanup; only fully-configured sets (worktree root + all components bound) can be used for creation.
- **Branch types**: a collapsed card on the config tab editing the global vocabulary `$DSH_HOME/worktree-flow/branch-types.json` — built-in Bugfix/功能/Hotfix/发布 on first install, fully editable; the create wizard composes the full branch name from type + topic (or「自定义」for a verbatim name).
- Component paths support a leading `~`.
- The sidebar「新增工作区」flow offers「功能工作区」: pick the target set, and the creation wizard lists all of its components.

Commands (fallback, scriptable; the set is inferred from the session cwd by path matching, `--set <name>` overrides):

```
/worktree status [feature]
/worktree create [name] --branch <full-branch> [--components a,b] [--base ref] [--set name] [--dry-run] [--register-components]
/worktree sync                    # adopt existing features + migrate .pi-era manifests + report orphans
/worktree open <feature>          # ensure registered, print the path
/worktree finish <feature> [--cleanup] [--force] [--keep-registered]
/worktree config show [--set name]
```

## Lifecycle and the sidebar

- create → registered (the sidebar shows `set/feature`)
- finish (archive) → unlisted by default (**only the registry record is removed** — files/branches/session history stay; sessions fall back to Ungrouped)
- need it back → `/worktree sync` re-registers in seconds
- finish --cleanup → deletes worktree directories after a guarded double-confirm; uncommitted/unpushed content is listed and requires force

So the sidebar only ever shows **active features**.

## Data files

| Data | Location |
|---|---|
| Set config (one self-contained file per set) | `$DSH_HOME/worktree-flow/sets/<name>.json` |
| New-set template (prefill-only, read once) | `$DSH_HOME/worktree-flow.json` |
| Branch-type vocabulary (global, editable) | `$DSH_HOME/worktree-flow/branch-types.json` |
| Feature manifest | `<feature-root>/.dsh-worktree.json` (read-only fallback: `.pi-workspace.json`, migrated by sync) |

Feature layout: `<worktreeRoot>/<set>/<feature>/<component>`.

## Non-goals (by design)

- No mid-session cwd switching (DSH session cwd is immutable — switching features = a new session under another workspace)
- No automatic commit/push/merge/branch deletion
- No changes to DSH's native "add workspace" flow
- No task dispatch / dashboard
- Non-git directories cannot be components — feature workspaces are built on git worktree; picking a non-git directory offers one-click `git init`

## Development

```powershell
npm test   # unit + real-git integration + plugin load + client bundle simulation
```

No build step: the client bundle is hand-written in the lazy-CJS handoff format (`window.__ModuleLoader__.load`), same as dsh-codex-oauth.

## License

MIT
