/**
 * proactive —— 「我要压」这一半：模型主动预约一次压缩，压完自动唤醒它接着做。
 *
 * 与旧版 dsh-compact-later 的区别只有一处，但那一处是致命的：
 *   旧版挂在宿主平面，却去 `agent.ctx.get("compaction")` 找服务 —— 压缩服务住在
 *   preset 的 `isolate: {compaction: true}` 组里，agent.ctx 在组外，够不到，
 *   于是永远返回 no-compaction-service（一个只会说 scheduled 的假按钮）。
 *   本版由 bundle 补丁在宿主平面**自挂一个 compaction-basic 实例**（auto: false），
 *   与本插件同处一个 isolate 组，所以 `ctx.get("compaction")` 拿到的是同 realm 的真服务。
 *   它靠 `llm/tokenMeter/sessions`（都在宿主平面）干活，能对任意 agent 调用。
 *
 * 时序（读码确认，这是"为什么不能在回合中间压"的根因）：
 *   `compactNow` 第一行是 `signal.throwIfAborted()`（传 undefined 必抛），
 *   随后是 `agent.runMaintenance(...)`；runMaintenance 在 agent 正跑时**同步抛错**，
 *   被包成 `ManualCompactionError("busy")`。
 *   ⇒ 回合中间按不动这个按钮，不是权限问题，是时序问题。
 *   ⇒ 所以本插件只**登记意图**，把执行挂到 `agent.whenIdle()` 之后。
 *
 * 为什么要 followup（2026-11-10 实测补上的一半）：
 *   压缩是**回合之外**的维护动作（日志里 `compaction/start` 与 `compaction/end`
 *   的 turn 都是 null）。压完 agent 就停在那儿，**不会自己再开一轮**。
 *   ⇒ 所以"压完能接着往下走"必须有人叫醒它：压完后用 `agent.followup(...)`
 *      起一个新回合，并把压缩前写下的意图一起带回去。
 *   两条保护：
 *     a. 唤醒消息的 source 声明成我们自己的 kind（`idle-compact`），不冒充用户。
 *     b. 如果已经有人在叫醒它（agent 在跑，或 inbox 里已有排队消息），就不插话。
 */

import { randomUUID } from "node:crypto";
import { computeLine } from "./threshold.js";

const TOOL_LATER = "compact_later";
const TOOL_STATUS = "compact_status";

/** 把一段字面量包成模型可见的文本块。 */
function text(value) {
	return [{ type: "text", text: value }];
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从异常里取 ManualCompactionError 的 code。 */
function describeError(error) {
	if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return error instanceof Error ? error.message : String(error);
}

export function registerProactive(ctx, getConfig, stats, resolveWindow) {
	/** 每个 agent 上一次的结果（进程内；重启即失，会话日志里的 compaction/* 才是正本）。 */
	const lastOutcome = new Map();
	/** agentId → 已登记但还没执行的预约。 */
	const pending = new Set();
	/** 在途操作，用于退出时收尾。 */
	const inFlight = new Set();

	function track(promise) {
		inFlight.add(promise);
		const retire = () => inFlight.delete(promise);
		promise.then(retire, retire);
	}

	/**
	 * 真正执行压缩。**只应在 agent 空闲之后调用**。
	 *
	 * 服务用 ctx.get 运行时取，而不是 `ctx.compaction`：
	 *   inject 是硬门禁，把 compaction 写进 inject 会让"提醒"也一起陪葬。
	 */
	async function runCompact(agent) {
		const compaction = ctx.get("compaction");
		if (compaction === undefined || compaction === null) {
			const line = "压缩服务不可用（这个 profile 没有挂压缩引擎），未做任何改动。";
			lastOutcome.set(agent.id, line);
			return { ok: false, line };
		}

		const controller = new AbortController();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				const result = await compaction.compactNow(agent, controller.signal);
				if (result === null) {
					const line = "没有可安全压缩的历史，未做任何改动。";
					lastOutcome.set(agent.id, line);
					return { ok: false, line };
				}
				const line =
					`已压缩 ${result.shadowedSeqs.length} 条历史（约 ${result.shadowedTokenCount} tokens），` +
					`摘要事件 Seq ${result.summarySeq}。`;
				lastOutcome.set(agent.id, line);
				return { ok: true, line };
			} catch (error) {
				const code = describeError(error);
				// busy = 刚空闲又被下一轮抢走。等一会儿再试，仍失败就记账。
				if (code === "busy" && attempt < 2) {
					await sleep(4000);
					continue;
				}
				const line = `压缩未完成（${code}）。`;
				lastOutcome.set(agent.id, line);
				return { ok: false, line };
			}
		}
		return { ok: false, line: "压缩未完成（未知原因）。" };
	}

	function measureTokens(agent) {
		try {
			const meter = ctx.get("tokenMeter");
			if (meter === undefined || meter === null) return undefined;
			return meter.measure(agent.session).totalTokens;
		} catch {
			return undefined;
		}
	}

	function buildWakeupText(reason, before, after, info) {
		const waterline =
			before === undefined || after === undefined ? "" : `水位 ${before} → ${after} tokens。\n`;
		return [
			"[idle-compact] 你预约的上下文压缩已经完成：",
			waterline,
			info.line,
			"\n\n压缩前写下的意图：",
			reason,
			"\n\n接着把这件事做完——从压缩后的上下文往下走，不必复述压缩过程，也不要从头重来。",
			"如果它其实在压缩前就已经收尾了，就只回一句「已就绪」，然后停下；**不要自己发明新的工作**。",
		].join("");
	}

	/**
	 * 压完之后把 agent 叫醒。不叫醒的后果是实测过的：压完 agent 静止，用户不开口它就不动。
	 * 但"叫醒"必须让位给"已经有人的叫醒"。
	 */
	function resumeAfterCompact(agent, reason, before, info) {
		const queued = (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0);
		if (agent.status === "running" || queued > 0) {
			lastOutcome.set(
				agent.id,
				`${info.line} 压完后 agent 已经在跑（有人先叫醒了它），没有再插话。`
			);
			return;
		}
		const after = measureTokens(agent);
		try {
			agent.followup({
				id: randomUUID(),
				role: "user",
				source: { kind: "idle-compact" },
				content: [{ type: "text", text: buildWakeupText(reason, before, after, info) }],
			});
			lastOutcome.set(agent.id, `${info.line} 已唤醒 agent 继续（followup）。`);
		} catch (error) {
			lastOutcome.set(agent.id, `${info.line} 唤醒失败（${describeError(error)}）。`);
		}
	}

	const laterTool = {
		name: TOOL_LATER,
		description: [
			"预约一次上下文压缩：把较早的历史折叠成一段摘要，只保留最近的内容。",
			"调用后**立刻返回**，不会打断当前回合 —— 压缩在本轮结束、你空闲下来之后自动执行，",
			"执行完会**自动把你叫醒**，并把这里写的 reason 原样带回给你，你可以接着往下做（resume: false 可关掉唤醒）。",
			"什么时候用：一个话题或一个阶段刚做完、准备换到下一件事去做的时候；",
			"或者收到 compact-guard 的水位提醒、该落盘的已经落完了的时候。",
			"什么时候**不**用：话题还没讲完、还有没落盘的约定或结论时不要压（压缩不可逆，丢掉的内容只能从摘要里找回）。",
			"一次往返里最多预约一次；结果用 " + TOOL_STATUS + " 查，或看会话日志里的 compaction/* 事件。",
		].join(""),
		parameters: {
			type: "object",
			properties: {
				reason: {
					type: "string",
					description:
						"为什么要压、压完要接着做什么（可选但强烈建议写具体：这句话会在压缩完成后被原样带回给你，是你醒来时唯一的「我刚才在干什么」的锚）。",
				},
				resume: {
					type: "boolean",
					description:
						"压缩完成后是否自动唤醒你继续手上的事（默认 true）。只想腾地方、并不打算接着干什么时设为 false。",
				},
			},
			required: [],
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						description: "scheduled / already-scheduled / unavailable",
					},
					detail: { type: "string", description: "人话补充" },
				},
				required: ["status"],
			},
			render: (_args, value) =>
				text(`${value.status}${value.detail === undefined ? "" : "：" + value.detail}`),
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === undefined) {
				return { status: "unavailable", detail: "这次调用没有 agent 上下文" };
			}
			if (!getConfig().proactive) {
				return { status: "unavailable", detail: "主动压缩已关闭（proactive: false）" };
			}
			const compaction = ctx.get("compaction");
			if (compaction === undefined || compaction === null) {
				return {
					status: "unavailable",
					detail: "压缩服务不可用：这个 profile 没有挂压缩引擎，或引擎尚未就绪",
				};
			}
			if (pending.has(agent.id)) {
				return { status: "already-scheduled", detail: "这一轮已经预约过一次了" };
			}
			pending.add(agent.id);
			const reason =
				typeof args?.reason === "string" && args.reason.length > 0 ? args.reason : "（未说明）";
			const resume = args?.resume !== false;
			// 关键一步：不在回合中间压，挂到「本轮结束、真正空闲」之后。
			track(
				agent.whenIdle().then(
					async () => {
						try {
							const before = measureTokens(agent);
							// 水位没到提醒线就别压。两个理由：
							//   1. 上一次自动压缩可能刚做完，此时再压是纯浪费；
							//   2. 更糟的是同一批内容会被折第二遍（摘要叠摘要，信息掉一层）。
							// 2026-11-11 实测踩到：自动压缩 705,188 → 289,761 之后，
							// 紧接着 compact_later 又压到 168,005 —— 那一次完全是多余的。
							const win = await resolveWindow(agent, undefined);
							if (before !== undefined && win !== undefined) {
								const line = computeLine(win, getConfig(), stats);
								if (before < line.target) {
									lastOutcome.set(
										agent.id,
										`跳过：水位 ${before} 未到提醒线 ${line.target}（可能刚被自动压缩过）。`
									);
									return;
								}
							}
							const info = await runCompact(agent);
							if (info.ok && resume) {
								resumeAfterCompact(agent, reason, before, info);
							}
						} finally {
							pending.delete(agent.id);
						}
					},
					() => {
						lastOutcome.set(agent.id, "预约被取消（agent 没有进入空闲状态）。");
						pending.delete(agent.id);
					}
				)
			);
			return {
				status: "scheduled",
				detail:
					`已预约（${reason}）：本轮结束后、空闲时执行` +
					(resume ? "，压完会自动唤醒你接着做" : "，压完不唤醒"),
			};
		},
	};

	const statusTool = {
		name: TOOL_STATUS,
		description: [
			"查看当前会话的上下文占用、提醒线、以及上一次由 " + TOOL_LATER + " 预约的压缩结果。",
			"用来判断「现在该不该压」——不必凭感觉。",
		].join(""),
		parameters: {
			type: "object",
			properties: {},
			required: [],
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					result: { type: "string", description: "水位、提醒线与上一次压缩结果" },
					pending: { type: "string", description: "是否有尚未执行的预约" },
				},
				required: ["result"],
			},
			render: (_args, value) =>
				text(`${value.result}${value.pending === undefined ? "" : "\n" + value.pending}`),
		},
		async execute(_args, exec) {
			const agent = exec.agent;
			if (agent === undefined) return { result: "这次调用没有 agent 上下文。" };

			let head = "";
			try {
				const meter = ctx.get("tokenMeter");
				if (meter !== undefined && meter !== null) {
					const measured = meter.measure(agent.session);
					head = `当前上下文约 ${measured.totalTokens} tokens（${measured.nodes.length} 个节点）。\n`;
					// 顺手把线也报出来，让调用它的人/模型能直接判断。
					const win = await resolveWindow(agent, undefined);
					if (win !== undefined) {
						const line = computeLine(win, getConfig(), stats);
						head +=
							`窗口 ${win.contextWindow}；提醒线 ${line.target}（${line.reason}）；` +
							`自动压缩线 ${line.limit}。\n`;
						head += `已采样本 ${stats.count} 个（P90 ${stats.p90()} tokens/步）。\n`;
					}
				}
			} catch (error) {
				head = `（水位读取失败：${describeError(error)}）\n`;
			}

			const outcome = lastOutcome.get(agent.id) ?? "本进程内还没有预约过压缩。";
			const pendingNote = pending.has(agent.id) ? "有一个预约正在等待本轮结束。" : undefined;
			return {
				result: head + outcome,
				...(pendingNote === undefined ? {} : { pending: pendingNote }),
			};
		},
	};

	ctx.effect(function* () {
		yield async () => {
			await Promise.allSettled(inFlight);
		};
		yield ctx.tools.register(laterTool);
		yield ctx.tools.register(statusTool);
	}, "idle-compact proactive");
}
