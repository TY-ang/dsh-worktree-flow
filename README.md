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
dsh plugin --profile web add github:TY-ang/dsh-worktree-flow
# pin a release:  dsh plugin --profile web add github:TY-ang/dsh-worktree-flow#v0.1.1
# the package declares dsh.bundle, so it joins the profile layer stack automatically
```

Restart `dsh web` afterwards.

This package is not published to the npm registry (`"private": true` stays in package.json) — install it from a local path or a git URL.

## Usage

Primary entry: the **Settings → Worktree Flow** page

- Two primary tabs only: **配置** (config) and **功能工作区** (feature workspaces)
- **Config**: set list + editor. Create a set with「+ 新建仓库组」(the name becomes part of feature directory names and is immutable); initial content is prefilled once from the "new-set template". Then bind components: a collapsed row shows just "name → path"; expand to edit — pick a directory with「选择…」and it is probed immediately (is it a git repo? what is the base branch?); picking a non-git directory offers an inline「初始化 git 仓库」button. Saving runs inline validation (path exists / is a git repo / base branch resolvable / worktree root writable). An optional shared-docs source supports project-wide documents that are intentionally untracked by Git.
- **自动发现** (auto-discover): anchored at a reference directory, scans its neighbouring git repositories for bulk binding (renameable component names, manual opt-in checkboxes, search + pagination); with nothing bound yet, pick a reference directory first.
- **新仓库组模板**: a collapsed card at the bottom of the config tab editing `$DSH_HOME/worktree-flow.json` — read ONCE when a set is created (worktree root, default base branch, component vocabulary); never affects existing sets.
- **Feature workspaces**: pick a set, then browse feature groups (branch / dirty / ahead-behind / unpushed / registration state / session count), archive and cleanup; only fully-configured sets (worktree root + all components bound) can be used for creation.
- **Project session instructions**: each set can hold shared project guidance (for example, SQL conventions or directory rules). Every new session under any of its features reads the latest set value and injects it alongside that feature's own guidance; existing features do not need to be recreated after an edit.
- **Feature session instructions**: the create wizard accepts branch/feature-specific guidance (for example, a branch-specific SQL directory). Afterwards it remains editable/clearable either from the feature card or from the **会话说明** area in the set/feature badge popover beside the conversation title, which also displays the project instructions. It is stored in a trusted per-feature record under `$DSH_HOME`, not in the workspace-writable manifest. Every new session created in that feature receives the latest value on the first step alongside the standard Worktree Flow identity note and current project instructions.
- **Shared-docs snapshots**: when a set has a source directory, feature creation preflights and copies it to `<feature-root>/.worktree-flow/docs`. Copying rejects symlinks and is capped at 20,000 files, 20,000 subdirectories, 64 levels, and 100 MiB. It is a creation-time snapshot (no automatic synchronization) and cleanup removes it with the feature.
- **Branch types**: a collapsed card on the config tab editing the global vocabulary `$DSH_HOME/worktree-flow/branch-types.json` — built-in Bugfix/功能/Hotfix/发布 on first install, fully editable; the create wizard composes the full branch name from type + topic (or「自定义」for a verbatim name).
- Worktree-root and component paths must be absolute; component paths support a leading `~`.
- After each component worktree is created, one read-only `git rev-parse --show-toplevel` verifies that the current DSH identity can access it. Git `dubious ownership` stops creation before registration. The plugin never runs `git config --global`, adds `safe.directory`, changes NTFS ownership, or deletes that worktree automatically; fix the DSH launch identity/owner and retry.
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
- need it back → `/worktree open <feature>` re-registers that feature (`sync` continues to skip archived features)
- finish --cleanup → deletes worktree directories after a guarded double-confirm; uncommitted/unpushed content is listed and requires force

So the sidebar only ever shows **active features**.

## Data files

| Data | Location |
|---|---|
| Set config (one self-contained file per set) | `$DSH_HOME/worktree-flow/sets/<name>.json` |
| New-set template (prefill-only, read once) | `$DSH_HOME/worktree-flow.json` |
| Branch-type vocabulary (global, editable) | `$DSH_HOME/worktree-flow/branch-types.json` |
| Trusted per-feature session context | `$DSH_HOME/worktree-flow/contexts/<set>/<feature>.json` |
| Feature manifest | `<feature-root>/.dsh-worktree.json` (read-only fallback: `.pi-workspace.json`, migrated by sync) |
| Shared project-docs snapshot | `<feature-root>/.worktree-flow/docs` |

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
