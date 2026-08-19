// @ts-check
/**
 * dsh-worktree-flow commands: the /worktree family as a thin adapter over
 * WorktreeFlowService. No business rules here — parse flags, call the
 * service, render text.
 *
 * The domain object is the named SET. Commands resolve the set from the
 * session cwd by path matching (inside a bound component or a feature tree);
 * `--set <名字>` overrides.
 *
 * @module dsh-worktree-flow/commands
 */
import { WorktreeFlowError, slugifyFeature } from "./core.js";

const USAGE = [
	"worktree-flow — 多仓库功能工作区",
	"",
	"/worktree status [功能]                       功能工作区总览（分支/dirty/领先落后/登记状态）",
	"/worktree create [名称] --branch <完整分支> [选项] 创建功能工作区（每个绑定仓库一棵 worktree + 登记为 DSH 工作区；名称省略时从分支名派生）",
	"    --components a,b      组件（默认：仓库组里的全部）",
	"    --branch <完整分支>   必填，例如 feature/selection-v2",
	"    --base <基准>         基准分支（默认仓库组的 defaultBaseBranch）",
	"    --set <仓库组名>      不按 cwd 推断，直接指定仓库组",
	"    --dry-run             只预览计划，不动磁盘",
	"    --register-components 同时把各组件目录登记为独立工作区",
	"/worktree sync                                同步：已有功能补登记 + 旧清单迁移 + 孤儿目录报告",
	"/worktree open <功能>                          确保已登记，返回路径（开会话在侧边栏/新建会话选择器里选它）",
	"/worktree finish <功能> [--cleanup] [--force] [--keep-registered]",
	"                                              默认归档（并从侧边栏下架）；--cleanup 删除 worktree 目录",
	"/worktree config show                         查看当前仓库组配置",
	"",
	"日常主入口在 Settings → Worktree Flow 页面；命令为备用。"
].join("\n");

/** Split raw input into tokens + flags (--k v | --k=v | --bool). */
function parseArgs(input) {
	const tokens = input.split(/\s+/u).filter(Boolean);
	/** @type {string[]} */
	const positional = [];
	/** @type {Record<string, string | true>} */
	const flags = {};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq > 2) {
				flags[token.slice(2, eq)] = token.slice(eq + 1);
			} else {
				const key = token.slice(2);
				const next = tokens[index + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[key] = next;
					index += 1;
				} else {
					flags[key] = true;
				}
			}
		} else {
			positional.push(token);
		}
	}
	return { positional, flags };
}

function flagBool(flags, name) {
	return flags[name] === true || flags[name] === "true";
}

function flagList(flags, name) {
	const value = flags[name];
	if (value === undefined || value === true) return [];
	return value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
}

function flagString(flags, name) {
	const value = flags[name];
	return value === undefined || value === true ? undefined : value;
}

function renderGitStatus(git) {
	if (git.present !== true) return "缺失";
	if (git.readError !== undefined) return `⚠状态未知：${git.readError}`;
	const parts = [];
	if (git.branch !== undefined) parts.push(git.branch);
	if (git.branchMismatch === true) parts.push("⚠分支漂移");
	if ((git.changed ?? 0) > 0) parts.push(`${git.changed} 未提交`);
	if ((git.ahead ?? 0) > 0) parts.push(`领先 ${git.ahead}`);
	if ((git.behind ?? 0) > 0) parts.push(`落后 ${git.behind}`);
	if ((git.unpushed ?? 0) > 0) parts.push(`未推送 ${git.unpushed}`);
	return parts.length > 0 ? parts.join("，") : "干净";
}

function renderFeature(feature) {
	const lines = [];
	const reg = feature.registration.state === "registered" ? `已登记(${feature.registration.sessionCount ?? 0}会话)` : feature.registration.state === "unregistered" ? "未登记" : "登记不可用";
	lines.push(`${feature.archived === true ? "🗄 " : ""}${feature.projectName}/${feature.feature}  [${feature.status}]  ${reg}`);
	lines.push(`  根目录：${feature.root}`);
	for (const component of Object.values(feature.components)) {
		const state = component.state === "failed" ? `失败：${component.error ?? ""}` : renderGitStatus(component.git);
		lines.push(`  ${component.name.padEnd(10)} ${state}`);
		lines.push(`             ${component.path}`);
	}
	if (feature.legacyManifest === true) lines.push("  （清单为旧版 .pi-workspace.json，sync 可迁移）");
	return lines.join("\n");
}

/**
 * Register the /worktree command family.
 * @param {object} ctx - plugin ctx (uses nested inject for `commands`).
 * @param {import("./service.js").WorktreeFlowService} service
 */
export function registerCommands(ctx, service) {
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "worktree",
			description: "多仓库功能工作区：create | status | sync | open | finish | config",
			input: { hint: "create <名称> --branch <完整分支> | status [功能] | sync | open <功能> | finish <功能> | config show" },
			handler: async (invocation) => {
				try {
					return await dispatch(service, invocation);
				} catch (error) {
					if (error instanceof WorktreeFlowError) {
						return { kind: "error", text: error.message };
					}
					return {
						kind: "error",
						text: `worktree-flow 内部错误：${error instanceof Error ? error.message : String(error)}`
					};
				}
			}
		});
	});
}

async function dispatch(service, invocation) {
	const cwd = invocation.agent?.session?.header?.cwd ?? process.cwd();
	const input = invocation.rawInput.trim();
	if (input === "" || input === "help") return { kind: "success", text: USAGE };
	const { positional, flags } = parseArgs(input);
	const verb = positional[0];
	const signal = invocation.signal;

	// Resolve the set once: --set wins, otherwise path-match the session cwd.
	const explicit = flagString(flags, "set");
	const setName = explicit ?? (await service.resolveCwd(cwd)).config.name;

	switch (verb) {
		case "status": {
			const { features, config } = await service.listFeatures(setName, { signal });
			const featureArg = positional.slice(1).join(" ");
			if (featureArg !== "") {
				const feature = features.find((entry) => entry.feature === slugifyFeature(featureArg));
				if (feature === undefined) return { kind: "error", text: `找不到功能工作区：${featureArg}` };
				return { kind: "success", text: renderFeature(feature) };
			}
			if (features.length === 0) {
				return {
					kind: "success",
					text: `仓库组 ${config.name} 还没有功能工作区（根目录 ${config.worktreeRoot}）。\n用 /worktree create <名称> 创建，或 /worktree sync 接入磁盘上已有的。`
				};
			}
			return { kind: "success", text: features.map(renderFeature).join("\n\n") };
		}

		case "create": {
			// 功能名可以带空格：动词后的所有位置参数都是名字；省略时从分支名
			// 最后一段派生（feature/selection-v2 → selection-v2）。
			const featureName = positional.slice(1).join(" ");
			const branch = flagString(flags, "branch");
			if (branch === undefined || branch.trim() === "") return { kind: "error", text: "请使用 --branch 填写完整分支名，例如：/worktree create --branch feature/selection-v2" };
			const intent = {
				feature: featureName,
				components: flagList(flags, "components"),
				branch,
				baseBranch: flagString(flags, "base"),
				dryRun: flagBool(flags, "dry-run"),
				registerComponents: flagBool(flags, "register-components")
			};
			const result = await service.createFeature(setName, intent, { signal });
			if (result.dryRun === true) {
				const lines = [`预览：${result.title}（分支 ${result.branch}）`, `根目录：${result.featureRoot}`, ""];
				for (const row of result.plan) {
					lines.push(`  ${row.component.padEnd(10)} ← ${row.repository}`);
					lines.push(`             → ${row.targetPath}（${row.note}）`);
				}
				lines.push("", "确认后去掉 --dry-run 执行。");
				return { kind: "success", text: lines.join("\n") };
			}
			const lines = [`功能工作区 ${result.title}：${result.status}`, `根目录：${result.featureRoot}`];
			for (const row of result.results) {
				lines.push(row.ok
					? `  ✓ ${row.component}  ${row.state === "existing" ? "（复用已有）" : ""}`
					: `  ✗ ${row.component}  ${row.error}`);
			}
			if (result.registration?.state === "registered" || result.registration?.state === "retitled") {
				lines.push("", `已登记为 DSH 工作区「${result.title}」——侧边栏/新建会话的工作区选择器里选它开会话。`);
			} else if (result.registration?.state === "unavailable") {
				lines.push("", "（workspaceRegistry 不可用，未登记；目录已建好，可稍后 /worktree sync 补登记）");
			}
			return { kind: result.status === "failed" ? "error" : "success", text: lines.join("\n") };
		}

		case "sync": {
			const result = await service.sync(setName, {
				register: !flagBool(flags, "no-register"),
				migrate: !flagBool(flags, "no-migrate"),
				signal
			});
			const lines = [`同步完成（${result.projectBase}）：`];
			for (const action of result.actions) {
				const label = { registered: "已登记", retitled: "已登记(修正标题)", exists: "已登记", migrated: "清单已迁移", "skip-archived": "已归档跳过", "invalid-manifest": "清单无效（已隔离）", "ownership-blocked": "所有权异常（未登记）", "git-blocked": "Git 不可用（未登记）", unavailable: "登记不可用" }[action.action] ?? action.action;
				lines.push(`  ${action.feature}: ${label}`);
			}
			if (result.orphans.length > 0) {
				lines.push("", "孤儿目录（无清单，未处理）：");
				for (const orphan of result.orphans) lines.push(`  ${orphan}`);
			}
			if (result.actions.length === 0 && result.orphans.length === 0) lines.push("  没有需要同步的内容。");
			return { kind: "success", text: lines.join("\n") };
		}

		case "open": {
			const featureName = positional.slice(1).join(" ");
			if (featureName === "") return { kind: "error", text: "用法：/worktree open <功能>" };
			const { features } = await service.listFeatures(setName, { signal, withGit: false });
			const feature = features.find((entry) => entry.feature === slugifyFeature(featureName));
			if (feature === undefined) return { kind: "error", text: `找不到功能工作区：${featureName}` };
			if (feature.registration.state !== "registered") {
				const outcome = await service.registerFeatureWorkspace(setName, feature.feature);
				if (!["registered", "retitled", "exists"].includes(outcome.state)) {
					return { kind: "error", text: `工作区登记失败：${outcome.state}` };
				}
			}
			return {
				kind: "success",
				text: [
					`功能工作区「${feature.projectName}/${feature.feature}」已就绪：`,
					`  ${feature.root}`,
					"",
					"开会话：侧边栏工作区列表或新建会话的工作区选择器里选它（会话创建时绑定，创建后不可切换）。"
				].join("\n")
			};
		}

		case "finish": {
			const featureName = positional.slice(1).join(" ");
			if (featureName === "") return { kind: "error", text: "用法：/worktree finish <功能> [--cleanup] [--force] [--keep-registered]" };
			if (flagBool(flags, "cleanup")) {
				const plan = await service.planCleanup(setName, featureName, { signal });
				const result = await service.cleanupFeature(setName, featureName, { force: flagBool(flags, "force"), signal });
				const lines = [`清理完成：${result.feature}`];
				if (result.removed.length > 0) lines.push(`  已移除 worktree：${result.removed.join(", ")}`);
				if (result.failed.length > 0) lines.push(`  失败：${result.failed.join("；")}`);
				lines.push(`  工作区登记：${result.unregistered === "unregistered" ? "已注销" : result.unregistered}`);
				lines.push(`  功能根目录：${result.rootRemoved ? "已删除" : "保留（含其他文件）"}`);
				if (plan.blockers.length > 0) lines.push("", "（使用了 --force 忽略以下阻止项）", ...plan.blockers.map((blocker) => `  - ${blocker}`));
				lines.push("", "分支未删除，需要时手动：git branch -D <分支>");
				return { kind: result.failed.length > 0 ? "error" : "success", text: lines.join("\n") };
			}
			const archived = await service.archiveFeature(setName, featureName, {
				keepRegistered: flagBool(flags, "keep-registered"),
				signal
			});
			return {
				kind: "success",
				text: [
					`已归档：${archived.feature}（${archived.featureRoot}）`,
					archived.unregistered === "unregistered"
						? "已从侧边栏下架（文件与分支保留；其历史会话归入 Ungrouped）。"
						: archived.unregistered === "skipped"
							? "保留侧边栏登记。"
							: `登记状态：${archived.unregistered}`,
					"需要回看用 /worktree open <功能> 恢复登记；要删目录用 /worktree finish <功能> --cleanup。"
				].join("\n")
			};
		}

		case "config": {
			const sub = positional[1] ?? "show";
			if (sub === "show") {
				const config = await service.getSet(setName);
				const lines = [
					`仓库组：${config.name}${config.label !== undefined ? `（${config.label}）` : ""}`,
					`worktreeRoot：${config.worktreeRoot || "(未设置)"}`,
					`defaultBaseBranch：${config.defaultBaseBranch}`,
					"repositories："
				];
				for (const [name, repo] of Object.entries(config.repositories)) {
					lines.push(`  ${name}${repo.label !== undefined ? `（${repo.label}）` : ""} → ${repo.path ?? "(未绑定)"}${repo.defaultBaseBranch !== undefined ? `  [基准 ${repo.defaultBaseBranch}]` : ""}`);
				}
				return { kind: "success", text: lines.join("\n") };
			}
			return { kind: "error", text: `未知 config 子命令：${sub}（show）` };
		}

		default:
			return { kind: "error", text: `未知子命令：${verb}\n\n${USAGE}` };
	}
}
