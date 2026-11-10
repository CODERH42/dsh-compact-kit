/**
 * dsh-compact-kit —— 上下文压缩的「时机」一半。
 *
 * 原版 compaction-basic 只在两种情况下动手：数 token 数到窗口 ×0.8，
 * 或者撞上 CONTEXT_WINDOW_EXCEEDED 兜底。它不知道"这一段还有没落盘的东西"，
 * 也不给 agent 任何话事权。本插件补的就是这一块，**怎么压一行都不改**。
 *
 * 两个开关，可以各自关掉（配置见 ~/.dsh/dsh-compact-kit.json，改完立刻生效）：
 *   remind    —— 水位提醒：快到线时提醒模型先落盘（lib/guard.js）
 *   proactive —— 主动压缩：模型自己预约一次压缩，压完自动唤醒（lib/proactive.js）
 *
 * 两条工程纪律（都是踩出来的，别改）：
 *   1. **不 import 任何 `@deepseek-ai/dsh-*` 包**。profile 的 node_modules 里没有它们，
 *      按绝对路径挂的插件会 ERR_MODULE_NOT_FOUND，整个 profile 起不来。
 *   2. **`inject` 里不写 `compaction`**。inject 是硬门禁（`cannot get property
 *      "compaction" without inject`）：一旦压缩服务缺失，整个插件都不启动，
 *      提醒功能会跟着陪葬，两个开关就都成了假的。所以改用 `ctx.get("compaction")`
 *      运行时取，缺了就降级成 unavailable，提醒照常工作。
 */

import { createConfigLoader } from "./lib/config.js";
import { createStats } from "./lib/stats.js";
import { createWindowResolver } from "./lib/threshold.js";
import { registerGuard } from "./lib/guard.js";
import { registerProactive } from "./lib/proactive.js";
import { registerCommands } from "./lib/commands.js";

export const name = "idle-compact";
export const inject = ["tools"];

/** patch 里的 config：新版 cordis 走 apply 的第二参，老版走 ctx.config，两个都试。 */
function patchConfigOf(ctx, given) {
	if (given !== null && typeof given === "object") return given;
	try {
		const fallback = ctx.config;
		return fallback !== null && typeof fallback === "object" ? fallback : {};
	} catch {
		return {};
	}
}

export function apply(ctx, given) {
	const loader = createConfigLoader(patchConfigOf(ctx, given));
	const getConfig = () => loader.refresh();
	const initial = getConfig();
	const stats = createStats(initial.statsPath);
	const resolveWindow = createWindowResolver(ctx);

	// 启动痕迹：交接单第 0 步的判据就是「这一行有没有出现」，别删。
	console.error(
		`[idle-compact] loaded; remind=${initial.remind} proactive=${initial.proactive} ` +
			`config=${loader.path} (${loader.loadedFrom})`
	);

	// 两个能力始终注册，开关在运行时读配置 —— 这样改配置文件立刻生效，不用重启。
	registerGuard(ctx, getConfig, stats, resolveWindow);
	registerProactive(ctx, getConfig, stats, resolveWindow);
	// /idle-compact：在 Web 输入框里查看与调整设置（拿不到 commands 服务就静默跳过）。
	const disposeCommand = registerCommands(ctx, loader, stats, resolveWindow);

	ctx.effect(function* () {
		yield async () => {
			// 退出前把攒着的统计刷盘。
			stats.save();
		};
		if (typeof disposeCommand === "function") yield disposeCommand;
	}, "idle-compact lifecycle");
}
