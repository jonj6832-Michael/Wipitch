import type { Samples } from '../types';

export interface AudioSegment {
	/** 原始音訊時間軸，半開區間。 */
	start: number;
	end: number;
	/** 此段結尾切點的 RMS；最後一段沒有切點。 */
	cutRms: number | null;
}

export interface AudioSegmentOptions {
	start?: number;
	end?: number;
	minSeconds?: number;
	maxSeconds?: number;
	/** 算 RMS 的視窗；50ms 足以避開單一 sample 的偶然零交越。 */
	windowSeconds?: number;
	/** 搜尋最低音壓時的步距。 */
	hopSeconds?: number;
}

/**
 * 將音訊切成約 10–15 秒的工作段。每個非尾端切點都在前一切點後
 * [minSeconds, maxSeconds] 內選擇多聲道 RMS 最低的位置。
 *
 * 只有總剩餘長度介於 maxSeconds 與 2×minSeconds 之間時，數學上無法讓
 * 兩段都符合上下限，才會保留一個不足 minSeconds 的尾段。
 */
export function planAudioSegments(channels: readonly Samples[], sampleRate: number,
	options: AudioSegmentOptions = {}): AudioSegment[] {
	if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];
	const duration = Math.min(...channels.map(channel => channel.length)) / sampleRate;
	const start = clamp(options.start ?? 0, 0, duration);
	const end = clamp(options.end ?? duration, start, duration);
	const minSeconds = options.minSeconds ?? 10;
	const maxSeconds = options.maxSeconds ?? 15;
	const windowSeconds = options.windowSeconds ?? .05;
	const hopSeconds = options.hopSeconds ?? .01;
	if (!(minSeconds > 0) || !(maxSeconds >= minSeconds) || !(windowSeconds > 0) || !(hopSeconds > 0)) {
		throw new Error('音訊分段參數無效');
	}
	if (end <= start) return [];

	const out: AudioSegment[] = [];
	let cursor = start;
	while (end - cursor > maxSeconds) {
		const searchStart = cursor + minSeconds;
		// 若剩餘長度容許兩段都達到下限，不能切得太晚而留下過短尾段。
		const tailLimit = end - cursor >= minSeconds * 2 ? end - minSeconds : Infinity;
		const searchEnd = Math.min(cursor + maxSeconds, end, tailLimit);
		const cut = quietestPoint(channels, sampleRate, searchStart, searchEnd, windowSeconds, hopSeconds);
		out.push({ start: cursor, end: cut.time, cutRms: cut.rms });
		cursor = cut.time;
	}
	out.push({ start: cursor, end, cutRms: null });
	return out;
}

function quietestPoint(channels: readonly Samples[], sampleRate: number, from: number, to: number,
	windowSeconds: number, hopSeconds: number): { time: number; rms: number } {
	const half = Math.max(1, Math.round(windowSeconds * sampleRate / 2));
	const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
	const length = Math.min(...channels.map(channel => channel.length));
	const lo = Math.round(from * sampleRate), hi = Math.round(to * sampleRate);
	let bestAt = lo, bestRms = Infinity, energy = 0, count = 0;
	let windowStart = Math.max(0, lo - half);
	let windowEnd = Math.min(length, lo + half);
	const accumulate = (a: number, b: number, sign: 1 | -1) => {
		if (b <= a) return;
		for (const channel of channels) for (let i = a; i < b; i++) energy += sign * channel[i] * channel[i];
		count += sign * (b - a) * channels.length;
	};
	accumulate(windowStart, windowEnd, 1);
	for (let center = lo; center <= hi; center += hop) {
		if (center !== lo) {
			const nextStart = Math.max(0, center - half);
			const nextEnd = Math.min(length, center + half);
			accumulate(windowStart, Math.min(nextStart, windowEnd), -1);
			accumulate(Math.max(windowEnd, nextStart), nextEnd, 1);
			windowStart = nextStart; windowEnd = nextEnd;
		}
		const rms = Math.sqrt(Math.max(0, energy) / Math.max(1, count));
		if (rms < bestRms) { bestRms = rms; bestAt = center; }
	}
	return { time: clamp(bestAt / sampleRate, from, to), rms: bestRms };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
