/**
 * /idle-compact —— 在 Web 输入框里查看和调整配置。
 *
 * 为什么先做命令而不是图形面板：
 *   DSH 的每个配置页都是"插件自带一个 client 包"（package.json 的 `dshClient`
 *   声明 + 构建产物），没有通用自动渲染。做面板要动构建链，而 pnpm 在 dsh 进程
 *   里不可用。命令是同一个能力的轻量形态：**在 Web 界面上、随时可改、改完立刻
 *   生效**，不用构建、不用重启。
 *
 * 命令注册用 ctx.get("commands") 而不是 inject：
 *   和 compaction 同理 —— inject 是硬门禁，写进去会让"拿不到命令服务"时整个
 *   插件都不启动，把提醒也一起拖死。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeConfig } from "./config.js";
import { computeLine } from "./threshold.js";

const USAGE = [
	"用法：",
	"  /idle-compact                       查看当前设置与提醒线",
	"  /idle-compact set remind false      关掉水位提醒",
	"  /idle-compact set proactive false   关掉主动压缩",
	"  /idle-compact set remindRatio 0.65  手动指定提醒比例（0.3–0.95），或 set remindRatio auto 用统计推荐值",
	"  /idle-compact set reserveSteps 4    一次落盘大概要几步",
	"  /idle-compact reset                 删掉配置文件、恢复内置默认",
].join("\n");

const BOOL_KEYS = new Set(["remind", "proactive"]);
const NUMBER_KEYS = new Set(["reserveSteps", "minSamples", "minReserveTokens"]);

/** 读原始配置文件（保留用户手写的未知键），读坏了返回空对象。 */
function readRaw(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeRaw(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** 把用户输入的一个键值对写进配置，返回人话结果。 */
function applySetting(path, key, rawValue) {
	const next = readRaw(path);

	if (BOOL_KEYS.has(key)) {
		const value = rawValue === "true" || rawValue === "on" || rawValue === "1"
			? true
			: rawValue === "false" || rawValue === "off" || rawValue === "0"
				? false
				: undefined;
		if (value === undefined) return { ok: false, text: `${key} 只接受 true / false` };
		next[key] = value;
	} else if (key === "remindRatio") {
		if (rawValue === "auto") {
			next.remindRatio = "auto";
		} else {
			const ratio = Number(rawValue);
			if (!Number.isFinite(ratio) || ratio < 0.3 || ratio > 0.95) {
				return { ok: false, text: "remindRatio 取 0.3–0.95 之间的小数，或 auto" };
			}
			next.remindRatio = ratio;
		}
	} else if (key === "minReserveRatio") {
		const ratio = Number(rawValue);
		if (!Number.isFinite(ratio) || ratio < 0 || ratio > 0.5) {
			return { ok: false, text: "minReserveRatio 取 0–0.5 之间的小数（默认 0.05）" };
		}
		next.minReserveRatio = ratio;
	} else if (NUMBER_KEYS.has(key)) {
		const number = Number(rawValue);
		if (!Number.isFinite(number) || number < 0) {
			return { ok: false, text: `${key} 需要一个非负数字` };
		}
		next[key] = Math.round(number);
	} else {
		return {
			ok: false,
			text: `不认识的键「${key}」。可改：remind / proactive / remindRatio / reserveSteps / minSamples / minReserveTokens`,
		};
	}

	writeRaw(path, next);
	return { ok: true, text: `已写 ${key} = ${JSON.stringify(next[key])}。立刻生效，不用重启。` };
}

/** 组装当前状态报告。 */
async function describe(ctx, loader, stats, resolveWindow, agent) {
	const config = loader.refresh();
	const cached = normalizeConfig(undefined, {}); // 仅用于拿默认值做对照

	const lines = ["dsh-compact-kit 当前设置："];
	const mark = (value) => (value ? "开" : "关");
	lines.push(`  remind（水位提醒）    : ${mark(config.remind)}`);
	lines.push(`  proactive（主动压缩） : ${mark(config.proactive)}`);
	lines.push(
		`  remindRatio（提醒比例）: ${
			config.remindRatio === "auto" ? "auto（用统计推荐值）" : config.remindRatio
		}`
	);
	lines.push(`  reserveSteps（落盘步数）: ${config.reserveSteps}`);
	lines.push(`  minSamples（切换实测的样本数）: ${config.minSamples}`);

	// 当前会话的实况
	try {
		const meter = ctx.get("tokenMeter");
		const win = await resolveWindow(agent, undefined);
		if (meter !== undefined && meter !== null && win !== undefined) {
			const total = meter.measure(agent.session).totalTokens;
			const line = computeLine(win, config, stats);
			lines.push("");
			lines.push("当前会话：");
			lines.push(`  水位 ${total} / 窗口 ${win.contextWindow} tokens`);
			lines.push(`  提醒线 ${line.target}（${line.reason}）`);
			lines.push(`  自动压缩线 ${line.limit}`);
			lines.push(`  已采样本 ${stats.count} 个（P90 ${stats.p90()} tokens/步）`);
		} else {
			lines.push("");
			lines.push("当前会话：水位或窗口读不到（缺少 tokenMeter / llm 服务）。");
		}
	} catch (error) {
		lines.push("");
		lines.push(`当前会话：读取失败（${error instanceof Error ? error.message : String(error)}）。`);
	}

	lines.push("");
	lines.push(`配置文件：${loader.path}`);
	lines.push(
		loader.loadedFrom === "配置文件"
			? "  （已从文件读取）"
			: `  （文件不存在，当前用内置默认；改任何一项会自动创建它）`
	);
	if (loader.lastError !== undefined) {
		lines.push(`  ⚠ 文件内容有错，仍用上一份配置：${loader.lastError.message}`);
	}
	lines.push("");
	lines.push(USAGE);
	return lines.join("\n");
}

export function registerCommands(ctx, loader, stats, resolveWindow) {
	const commands = ctx.get("commands");
	if (commands === undefined || commands === null || typeof commands.register !== "function") {
		return undefined;
	}

	const handler = async (invocation) => {
		try {
			const raw = String(invocation?.rawInput ?? "").trim();
			const parts = raw.length === 0 ? [] : raw.split(/\s+/);

			if (parts.length === 0 || parts[0] === "show") {
				const text = await describe(ctx, loader, stats, resolveWindow, invocation.agent);
				return { kind: "success", text };
			}

			if (parts[0] === "reset") {
				try {
					rmSync(loader.path, { force: true });
					loader.refresh();
					return {
						kind: "success",
						text: "已删除配置文件，恢复内置默认（remind/proactive 都开，remindRatio=auto）。",
					};
				} catch (error) {
					return {
						kind: "error",
						text: `删除配置文件失败：${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}

			if (parts[0] === "set" && parts.length >= 3) {
				const result = applySetting(loader.path, parts[1], parts.slice(2).join(" "));
				if (result.ok) loader.refresh();
				return { kind: result.ok ? "success" : "error", text: result.text };
			}

			return { kind: "error", text: USAGE };
		} catch (error) {
			return {
				kind: "error",
				text: `执行失败：${error instanceof Error ? error.message : String(error)}`,
			};
		}
	};

	try {
		return commands.register({
			definitionId: "dsh-compact-kit/settings",
			name: "idle-compact",
			description: "查看/调整上下文压缩的提醒与主动压缩设置",
			handler,
		});
	} catch (error) {
		ctx.logger?.warn?.(
			`idle-compact: 命令注册失败（${error instanceof Error ? error.message : String(error)}）`
		);
		return undefined;
	}
}
