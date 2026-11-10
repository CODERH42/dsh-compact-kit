/**
 * 提醒线怎么算 —— 这是整个插件唯一"有观点"的地方，单独放一个文件。
 *
 * 核心：**用绝对 token 余量算，不用百分比拍**。
 *
 *   0.8 线  = min(窗口 × 0.8, 窗口 − 输出预留)     ← 原版 compaction-basic 的自动压缩线
 *   落盘余量 = max(下限, P90(单步输出) × reserveSteps)
 *   提醒点  = 0.8 线 − 落盘余量                    ← 必须在自动压缩之前留够"存东西"的空间
 *   最终夹在 [窗口 × 0.55, 窗口 × 0.79]
 *
 * 由这个算法自然得到两个性质（正是需求要的）：
 *   ① 小窗口模型：绝对余量占比较大 ⇒ 比例更低（早提醒），存盘空间才够；
 *   ② 但钳位在 0.55 保证它不会因为余量估得大就无限提前。
 *
 * 冷启动（样本不足）时给保守默认 0.62 并标注"推测"——不把一个拍脑袋的数字
 * 伪装成测量结果。
 */

export const HARD_COMPACT_RATIO = 0.8;
export const MIN_REMIND_RATIO = 0.55;
export const MAX_REMIND_RATIO = 0.79;
export const COLD_START_RATIO = 0.62;

/**
 * 从 agent 解析出"当前路由到的模型窗口"。
 *
 * 取法与官方 compaction-basic 一致：
 *   session.requestHeader()?.config {provider, model} → ctx.llm.resolveModelInfo()
 * 拿不到就返回 undefined，**不猜一个窗口**（猜错了线就是错的，宁可这次不提醒）。
 */
export function createWindowResolver(ctx) {
	const cache = new Map();

	return async function resolveWindow(agent, signal) {
		const header = agent.session?.requestHeader?.();
		const headerConfig = header?.config ?? {};
		const provider = headerConfig.provider ?? agent.options?.provider;
		const model = headerConfig.model ?? agent.options?.model;
		if (
			typeof provider !== "string" ||
			typeof model !== "string" ||
			provider.length === 0 ||
			model.length === 0
		) {
			return undefined;
		}

		const key = `${provider}/${model}`;
		const hit = cache.get(key);
		if (hit !== undefined) return hit;

		const llm = ctx.get("llm");
		if (llm === undefined || typeof llm.resolveModelInfo !== "function") return undefined;

		let info;
		try {
			info = await llm.resolveModelInfo(provider, model, signal);
		} catch {
			return undefined;
		}

		const contextWindow = info?.context?.contextWindow;
		if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;

		// 输出预留（provider 从同一个窗口里扣），有 envelope cap 用 cap，否则用适配器默认。
		const envelopeCap =
			Number.isFinite(headerConfig.maxTokens) && headerConfig.maxTokens > 0
				? headerConfig.maxTokens
				: undefined;
		const adapterCap =
			Number.isFinite(info?.defaultMaxTokens) && info.defaultMaxTokens > 0
				? info.defaultMaxTokens
				: 0;

		const entry = { contextWindow, reserved: envelopeCap ?? adapterCap };
		cache.set(key, entry);
		return entry;
	};
}

/**
 * 算一条提醒线。
 *
 * @param win - resolveWindow 的返回值。
 * @param config - 归一化后的配置。
 * @param stats - 统计存储。
 * @returns {{ target: number, limit: number, reason: string, ratio: number }}
 */
export function computeLine(win, config, stats) {
	const window = win.contextWindow;

	// 输出预留只在"不离谱"时生效。
	// 为什么要有这个保护：envelope 里的 maxTokens 是"单次输出上限"，未必是
	// provider 真的从窗口里扣掉的预留。实测数据里就看到过 reserved 接近窗口，
	// 导致 `窗口 − 预留` 塌成 1，自动压缩线变成 1 这种荒谬值。
	// 判据：预留给输出留不下半个窗口，就认为它不可信，退回 0.8 窗口。
	const budget = window - win.reserved;
	const limit = Math.floor(
		budget >= window * 0.5 ? Math.min(window * HARD_COMPACT_RATIO, budget) : window * HARD_COMPACT_RATIO
	);

	// 用户显式给了比例：听用户的（只做合法化，不覆盖他的决定）。
	if (config.remindRatio !== "auto") {
		// 但绝不允许提醒线高过压缩线——那样提醒永远慢于压缩，等于没提醒。
		const target = Math.min(Math.max(1, Math.floor(window * config.remindRatio)), Math.max(1, limit - 1));
		return {
			target,
			limit,
			ratio: config.remindRatio,
			reason: `配置 ${config.remindRatio}`,
		};
	}

	const sampleCount = stats.count;
	if (sampleCount < config.minSamples) {
		const target = Math.min(
			Math.max(1, Math.floor(window * COLD_START_RATIO)),
			Math.max(1, limit - 1)
		);
		return {
			target,
			limit,
			ratio: COLD_START_RATIO,
			reason: `推测 ${COLD_START_RATIO}（样本 ${sampleCount}/${config.minSamples}，还不足）`,
		};
	}

	const peak = stats.p90();
	// 三选一取最大，缺一不可：
	//   ① 固定下限（窗口很小的模型也有个基本余量）
	//   ② 实测峰值 × 落盘步数（"一次落盘要烧多少"的直接估计）
	//   ③ 窗口 × minReserveRatio（兜底，防 P90 被一堆短步稀释到没有意义——
	//      实测踩过：1M 窗口下 P90 只有 1679，四步算出 6716 余量，
	//      提醒线离压缩线只剩 6716，等于提醒完立刻就被压掉）
	const fromPeak = peak * config.reserveSteps;
	const fromWindow = window * config.minReserveRatio;
	const reserve = Math.max(config.minReserveTokens, fromPeak, fromWindow);
	// 报告必须说清"是哪一个在起作用"，否则数字对不上会被当成算错。
	const source =
		reserve === fromWindow
			? `窗口 ${(config.minReserveRatio * 100).toFixed(1)}% 兜底`
			: reserve === fromPeak
				? `P90 ${peak} × ${config.reserveSteps} 步`
				: `固定下限`;
	const raw = limit - reserve;
	const low = window * MIN_REMIND_RATIO;
	const high = window * MAX_REMIND_RATIO;
	const target = Math.min(
		Math.max(1, Math.floor(Math.max(low, Math.min(high, raw)))),
		Math.max(1, limit - 1)
	);
	return {
		target,
		limit,
		ratio: target / window,
		reason: `实测 ${source} = ${Math.round(reserve)} 余量`,
	};
}
