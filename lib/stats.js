/**
 * 输出 token 统计：为"提醒线该定在哪"提供实测依据。
 *
 * 只记一样东西——**模型一次 step 的输出 token**（含思考）。
 * 理由：从"提醒发出"到"落盘完成、压缩被预约"，这段时间的上下文增长
 * 绝大部分是模型自己吐的字加工具回显，而模型吐字的速度正是这里量的。
 *
 * 取 **P90 不取平均**：平均会被一堆小步（只调一个工具、回一句"好"）稀释，
 * 而我们要防的是"最贵的那一次落盘"。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_SAMPLES = 300;

export function createStats(path) {
	const file = path || join(homedir(), ".dsh", "dsh-compact-kit-stats.json");
	const data = { samples: [] };

	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (Array.isArray(parsed?.samples)) {
			data.samples = parsed.samples.filter((n) => Number.isFinite(n) && n > 0);
		}
	} catch {
		// 第一次运行没有文件，正常。
	}

	let dirty = false;
	let timer;

	function save() {
		if (!dirty) return;
		dirty = false;
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(
				file,
				JSON.stringify({ version: 1, samples: data.samples, updatedAt: Date.now() }, null, 1)
			);
		} catch {
			// 写不进去不影响提醒，只是这次的采样丢了。
		}
	}

	return {
		file,
		get count() {
			return data.samples.length;
		},
		get samples() {
			return [...data.samples];
		},
		push(outputTokens) {
			if (!Number.isFinite(outputTokens) || outputTokens <= 0) return;
			data.samples.push(Math.round(outputTokens));
			if (data.samples.length > MAX_SAMPLES) {
				data.samples.splice(0, data.samples.length - MAX_SAMPLES);
			}
			dirty = true;
			// 攒 5 秒再写，别每步都碰磁盘。
			if (timer === undefined) {
				timer = setTimeout(() => {
					timer = undefined;
					save();
				}, 5000);
				// 定时器不该拖住进程退出。
				if (typeof timer.unref === "function") timer.unref();
			}
		},
		p90() {
			if (data.samples.length === 0) return 0;
			const sorted = [...data.samples].sort((a, b) => a - b);
			const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));
			return sorted[index];
		},
		save,
	};
}
