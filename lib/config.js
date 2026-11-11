/**
 * 配置：内置默认 + 用户配置文件（热读）。
 *
 * 为什么配置放**独立文件**（~/.dsh/dsh-compact-kit.json）而不是只放 cordis patch：
 *   1. 用户改一个数字不该需要懂 cordis 语法，也不该需要重启；
 *   2. patch 里的 config 会随插件重载被重置，而统计出来的推荐值要能长期留存；
 *   3. 开源之后，用户能一眼看到"我该调哪个数字"，而不用翻 YAML 目录。
 *
 * 优先级：配置文件 > patch config > 内置默认。
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".dsh", "dsh-compact-kit.json");

export const DEFAULTS = Object.freeze({
	remind: true,
	proactive: true,
	remindRatio: "auto",
	reserveSteps: 4,
	minSamples: 5,
	minReserveTokens: 2048,
	minReserveRatio: 0.05,
	// compaction-basic 的 headroomTokens 默认值。它**真正的自动压缩线**是
	// `窗口 − 输出预留 − headroom`，不是 `窗口 − 输出预留`。少算这一项，
	// 提醒线就会落在压缩线之上 —— 提醒发了也等于没发（2026-11-11 实测踩到）。
	// 引擎若在别处改了这个值，这里要跟着改，否则线会算高。
	headroomTokens: 65536,
	statsPath: "",
});

function num(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}

/** 把三份来源合并成一份可用的配置。 */
export function normalizeConfig(fileConfig, patchConfig) {
	const file = fileConfig !== null && typeof fileConfig === "object" ? fileConfig : {};
	const patch = patchConfig !== null && typeof patchConfig === "object" ? patchConfig : {};
	const merged = { ...DEFAULTS, ...patch, ...file };
	const ratioRaw = merged.remindRatio;
	return {
		remind: bool(merged.remind, DEFAULTS.remind),
		proactive: bool(merged.proactive, DEFAULTS.proactive),
		// "auto" ⇒ 用统计出来的推荐值；给数字 ⇒ 听用户的。
		remindRatio:
			ratioRaw === undefined || ratioRaw === "auto" ? "auto" : num(ratioRaw, 0.62, 0.3, 0.95),
		reserveSteps: Math.round(num(merged.reserveSteps, DEFAULTS.reserveSteps, 1, 16)),
		minSamples: Math.round(num(merged.minSamples, DEFAULTS.minSamples, 1, 200)),
		minReserveTokens: Math.round(
			num(merged.minReserveTokens, DEFAULTS.minReserveTokens, 0, 1e6)
		),
		// 兜底余量占窗口的比例：P90 被短步稀释时，靠它保住"够落盘"的空间。
		minReserveRatio: num(merged.minReserveRatio, DEFAULTS.minReserveRatio, 0, 0.5),
		headroomTokens: Math.round(
			num(merged.headroomTokens, DEFAULTS.headroomTokens, 0, 1e6)
		),
		statsPath: typeof merged.statsPath === "string" ? merged.statsPath : "",
	};
}

/**
 * 提供热读配置：每次 refresh 只在文件 mtime 变化时重新解析。
 *
 * 读坏了（JSON 写错、文件被删）**保留上一份**，绝不因为配置写错就让提醒罢工——
 * 配置是用户的，出错的是用户的手，不该由功能承担。
 */
export function createConfigLoader(patchConfig, filePath) {
	const path = filePath || DEFAULT_CONFIG_PATH;
	let mtime = -1;
	let current = normalizeConfig(undefined, patchConfig);
	let lastError;
	let loadedFrom = "内置默认";

	function refresh() {
		let st;
		try {
			st = statSync(path);
		} catch {
			// 没有配置文件是正常状态，不是错误。
			return current;
		}
		if (st.mtimeMs === mtime) return current;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			current = normalizeConfig(parsed, patchConfig);
			mtime = st.mtimeMs;
			lastError = undefined;
			loadedFrom = "配置文件";
		} catch (error) {
			// 文件在、但内容是坏的：记住错误，继续用旧配置。
			lastError = error;
		}
		return current;
	}

	refresh();

	return {
		path,
		refresh,
		get current() {
			return current;
		},
		get lastError() {
			return lastError;
		},
		get loadedFrom() {
			return loadedFrom;
		},
	};
}
