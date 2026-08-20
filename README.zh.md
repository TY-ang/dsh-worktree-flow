# dsh-worktree-flow

[English](README.md) | 中文

DSH（DeepSeek Harness）的**多仓库功能工作区**插件：一个功能/版本 = 一个目录，里面每个组件仓库各一个 git worktree，全部在同一条功能分支上——功能根目录会被登记为 **DSH 工作区**，新建会话时在侧边栏/工作区选择器里选它，会话沙箱正好锁在这个功能范围里。

核心概念是**仓库组（set）**：将同一功能涉及的多个仓库绑定为一组、起个名字，集中存放（`$DSH_HOME/worktree-flow/sets/<名字>.json`）。不依附任何"主仓库"，仓库里也不留任何配置文件。

## 解决什么问题

你的工作模式：一个功能建一个"区"，一个会话里同时写前后端和 API。痛点是：提示词里忘声明目录/分支，就写错地方。

这个插件用三层把"写错分支"堵死：

1. **沙箱**：会话只能写功能根目录之内——主工作树和其他功能物理上写不进去；
2. **预建分支**：每个组件 worktree 创建时就 checkout 在功能分支上，写文件天然落在正确分支；
3. **身份提示**：会话落在功能工作区里时，第一步自动注入一次布局/分支/约束说明——不用你在提示词里声明任何路径。

## 安装

```powershell
dsh plugin --profile web add github:TY-ang/dsh-worktree-flow
# 锁定版本：  dsh plugin --profile web add github:TY-ang/dsh-worktree-flow#v0.1.2
# 包声明了 dsh.bundle，会自动进入 profile 层级栈
```

装完重启 `dsh web`。

本包不发布到 npm registry（package.json 保持 `"private": true`），以本地路径或 git 地址安装。

## 使用

主入口：**Settings → Worktree Flow** 页面

- 一级只保留 **配置** 和 **功能工作区** 两个 Tab
- **配置**：仓库组列表 + 编辑器。点「+ 新建仓库组」起名（名字会拼进功能工作区目录名，创建后不可改），初始内容按「新仓库组模板」预填一次；然后绑定组件：组件行默认只显示「名字 → 路径」一行，点开才编辑——路径点「选择…」挑选后立即探测（是不是 git 仓库、基准分支是什么），选到非 git 目录时行内给「初始化 git 仓库」按钮；保存后自动行内验证（仓库存在/git 仓库/基准分支/根目录可写）。可选的「共享 docs 源目录」用于仓库组级、未跟踪 Git 的项目文档
- **自动发现**：以一个参照目录为锚，扫描它旁边的 git 仓库批量绑定（组件名可改、手动勾选、支持搜索分页）；还没绑定任何组件时先选一个参照目录
- **新仓库组模板**：配置页底部的折叠卡片，编辑 `$DSH_HOME/worktree-flow.json`——只在新建仓库组时作为预填值读取一次（工作区根目录、默认基准分支、组件词汇表），不影响已有仓库组
- **功能工作区**：选择仓库组后查看功能组列表（分支/dirty/领先落后/未推送/登记状态/会话数）、归档和清理；只有配置完成的仓库组（根目录 + 组件全部绑定）才能用于创建
- **项目会话说明**：每个仓库组可配置项目通用提示（例如统一 SQL 规范、目录约定）。每个功能区的新会话都会读取仓库组配置中的最新值，并与该功能区自己的说明一起注入；修改项目说明不需要重建功能区
- **功能区会话说明**：创建向导可填写本功能/分支专用提示（例如分支特有的 SQL 目录差异），创建后也可在「功能工作区」展开对应功能区，或直接点功能区会话标题旁的仓库组/功能区徽章，在弹窗的「会话说明」区域继续编辑或清空；该弹窗还会同时展示项目会话说明。文本存入 `$DSH_HOME` 下的可信功能上下文，不从工作区内可写清单读取；以后从该功能区新建的每个会话，首步都会与标准 Worktree Flow 身份说明及当前项目说明一起收到最新内容
- **共享 docs 快照**：如果仓库组配置了源目录，创建功能区时会预检并复制到 `<功能根>/.worktree-flow/docs`。复制拒绝符号链接，限制为 20,000 个文件、20,000 个子目录、64 层深度和 100 MiB，源目录后续变化不会自动同步；清理功能区时快照随之删除
- **分支类型**：配置页底部的折叠卡片，编辑全局词汇表 `$DSH_HOME/worktree-flow/branch-types.json`——首装内置 Bugfix/功能/Hotfix/发布，可增删改；创建向导里选类型 + 填主题自动拼出完整分支名（也可选「自定义」直接写全名）
- 工作区根目录和组件路径必须是绝对路径；组件路径支持 `~` 开头的写法
- 每个组件 worktree 创建后会用一次只读 `git rev-parse --show-toplevel` 验证当前 DSH 身份可以访问；遇到 Git `dubious ownership` 时立即停止且不登记功能区。插件不会自动执行 `git config --global`、添加 `safe.directory`、修改 NTFS 所有者或删除该 worktree；修正 DSH 启动身份/目录所有者后可直接重试
- 侧边栏「新增工作区」选择「功能工作区」时会先选目标仓库组，创建向导列出该仓库组的全部组件

命令（备用，脚本化可用；按会话 cwd 路径匹配推断仓库组，`--set <名字>` 可覆盖）：

```
/worktree status [功能]
/worktree create [名称] --branch <完整分支> [--components a,b] [--base 基准] [--set 仓库组] [--dry-run] [--register-components]
/worktree sync                    # 补登记已有功能 + 迁移 .pi 旧清单 + 报告孤儿目录
/worktree open <功能>             # 确保已登记，返回路径
/worktree finish <功能> [--cleanup] [--force] [--keep-registered]
/worktree config show [--set 仓库组]
```

## 生命周期与侧边栏

- 创建 → 登记（侧边栏出现 `仓库组/功能`）
- finish 归档 → 默认下架（**只删登记记录**，文件/分支/会话历史都在，会话归入 Ungrouped）
- 需要回看 → `/worktree open <功能>` 恢复该功能的登记（`sync` 会继续跳过已归档功能）
- finish --cleanup → 二次确认后删除 worktree 目录并注销登记；有未提交/未推送内容会列出来，需勾选强制

所以侧边栏只显示**活跃功能**，不会越积越多。

## 数据文件

| 数据 | 位置 |
|---|---|
| 仓库组配置（每仓库组一份，自包含） | `$DSH_HOME/worktree-flow/sets/<名字>.json` |
| 新仓库组模板（仅新建时预填一次） | `$DSH_HOME/worktree-flow.json` |
| 分支类型词汇表（全局，可编辑） | `$DSH_HOME/worktree-flow/branch-types.json` |
| 功能区可信会话上下文 | `$DSH_HOME/worktree-flow/contexts/<仓库组>/<功能>.json` |
| 功能清单 | `<功能根>/.dsh-worktree.json`（只读兜底：`.pi-workspace.json`，sync 时迁移） |
| 项目共享文档快照 | `<功能根>/.worktree-flow/docs` |

功能工作区布局：`<worktreeRoot>/<仓库组名>/<功能>/<组件>`。

## 不做的事（by design）

- 不做会话中途切换 cwd（DSH 的会话 cwd 不可变——换功能 = 在另一个工作区下新开一个会话）
- 不自动 commit/push/merge/删分支
- 不改 DSH 原生"添加工作区"流程
- 不做任务派发/仪表盘
- 非 git 目录不能当组件——功能工作区基于 git worktree；选到非 git 目录时提供一键 `git init`

## 开发

```powershell
npm test   # 单元 + 真实 git 集成 + 插件加载 + 客户端 bundle 模拟
```

无构建步骤：客户端 bundle 是手写的 lazy-CJS handoff 格式（`window.__ModuleLoader__.load`），与 dsh-codex-oauth 同款。

## License

MIT
