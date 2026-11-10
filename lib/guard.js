/**
 * guard —— 上下文水位提醒。
 *
 * 它做什么：每步之前量一次水位，越过提醒线就往**下一步**插一条提醒，
 * 让模型在自动压缩真的发生之前，把"压成摘要就会死"的东西先落到摘要之外。
 *
 * 它不做什么：
 *   - **不压缩**。一行压缩代码都没有，只读 tokenMeter / llm（都是宿主平面服务）。
 *   - **不依赖 compaction 服务**。所以引擎挂不上时，它照样工作。
 *
 * 时序（读码确认，很关键）：
 *   `ReactLoopAgent.preStep()` 里 `inbox.claim()` 在 `agent/pre-step` 事件**之前**执行，
 *   所以这里 `agent.inject()` 的消息不会插入当前步，而会在**下一步**被领取——
 *   正好是"提醒完，下一步就开始落盘"。
 *
 * 去重：同一个 turn 只提醒一次。否则每步都响，比不提醒更烦。
 */

import { randomUUID } from "node:crypto";
import { computeLine } from "./threshold.js";

export function registerGuard(ctx, getConfig, stats, resolveWindow) {
	/** agentId → 已经提醒过的 turn。 */
	const reminded = new Map();

	// ── 采集：每步的 outputTokens（含思考）─────────────────────────
	const offSample = ctx.on("session/event", (_session, event) => {
		if (event?.type !== "assistant/message") return;
		const usage = event.data?.usage;
		if (usage === undefined || usage === null) return;
		stats.push(usage.outputTokens ?? 0);
	});

	// ── 提醒：每步之前量一次 ─────────────────────────────────────
	async function maybeRemind(payload) {
		const config = getConfig();
		if (!config.remind) return;
		const agent = payload.agent;
		if (agent === undefined || typeof agent.inject !== "function") return;

		const turn = payload.turn;
		if (reminded.get(agent.id) === turn) return;

		const meter = ctx.get("tokenMeter");
		if (meter === undefined || typeof meter.measure !== "function") return;

		const win = await resolveWindow(agent, payload.signal);
		if (win === undefined) return; // 不知道窗口就不提醒，绝不猜

		let total;
		try {
			total = meter.measure(agent.session).totalTokens;
		} catch {
			return;
		}
		if (!Number.isFinite(total)) return;

		const line = computeLine(win, config, stats);
		if (total < line.target) return;

		reminded.set(agent.id, turn);

		const percent = ((total / win.contextWindow) * 100).toFixed(1);
		const text = [
			`[compact-guard] 上下文水位 ${total} / ${win.contextWindow} tokens（${percent}%）。`,
			`提醒线 ${line.target}（${line.reason}），自动压缩线 ${line.limit}。`,
			"先把这一段里「压成摘要就会死」的东西落到摘要之外：文件、日记、记忆、待办、issue —— 任何压缩后还能取回来的地方。",
			"落完调 compact_later 预约压缩；确实没有东西可落，就直接预约。",
			"别为了腾地方丢掉还没写下来的东西：压缩不可逆，摘要留得住结构化的部分，留不住逐字的原话和一次性的约定。",
		].join("\n");

		try {
			// inject = 插到下一步、不唤醒（agent 已经在跑，不需要唤醒）。
			agent.inject({
				id: randomUUID(),
				role: "user",
				source: { kind: "compact-guard" },
				content: [{ type: "text", text }],
			});
		} catch (error) {
			// 插不进去就把标记撤回来，下一步还能再试。
			reminded.delete(agent.id);
			ctx.logger?.warn?.(
				`compact-guard: 提醒插入失败（${error instanceof Error ? error.message : String(error)}）`
			);
		}
	}

	const offStep = ctx.on("agent/pre-step", async (payload, next) => {
		try {
			await maybeRemind(payload);
		} catch (error) {
			// 提醒失败绝不能挡住这一步。
			ctx.logger?.warn?.(
				`compact-guard: 提醒计算失败（${error instanceof Error ? error.message : String(error)}）`
			);
		}
		return next();
	});

	return () => {
		if (typeof offSample === "function") offSample();
		if (typeof offStep === "function") offStep();
	};
}
