export interface ReferenceCache {
	mono16k: Float32Array;
	onsets: Float32Array;
	duration: number;
}
export interface ReferenceRhythm {
	bpm: number;
	meter: string;
	anchorSec: number;
	barStartsSec: number[];
	pitch?: { timeSec: number; midi: number }[];
}

/** 面積平均降採樣，保留 16k 單聲道供後續音高偵測；節奏特徵每 10ms 一格。 */
export function createReferenceCache(channels: Float32Array[], rate: number): ReferenceCache {
	const duration = channels[0].length / rate;
	const mono16k = new Float32Array(Math.floor(duration * 16000));
	for (let i = 0; i < mono16k.length; i++) {
		const a = i * rate / 16000, b = (i + 1) * rate / 16000;
		let sum = 0;
		for (let s = Math.floor(a); s < Math.ceil(b); s++) {
			const weight = Math.max(0, Math.min(b, s + 1) - Math.max(a, s));
			for (const ch of channels) sum += (ch[s] ?? 0) * weight / channels.length;
		}
		mono16k[i] = sum / (b - a);
	}
	const energy = new Float32Array(Math.floor(mono16k.length / 160));
	for (let i = 0; i < energy.length; i++) {
		let sum = 0;
		for (let k = 0; k < 160; k++) sum += mono16k[i * 160 + k] ** 2;
		energy[i] = Math.sqrt(sum / 160);
	}
	const onsets = new Float32Array(energy.length);
	for (let i = 2; i < energy.length; i++) onsets[i] = Math.max(0, energy[i] - energy[i - 2]);
	return { mono16k, onsets, duration };
}

export function findOnset(cache: ReferenceCache, center: number, radius: number, start = 0, end = cache.duration): number | null {
	let best = -1, score = 0;
	for (let i = Math.max(1, Math.ceil(Math.max(start, center - radius) * 100)); i <= Math.min(cache.onsets.length - 2, Math.floor(Math.min(end, center + radius) * 100)); i++) {
		if (cache.onsets[i] < cache.onsets[i - 1] || cache.onsets[i] < cache.onsets[i + 1]) continue;
		const value = cache.onsets[i] * (1 - 0.3 * Math.abs(i / 100 - center) / radius);
		if (value > score && value > 1e-5) { best = i; score = value; }
	}
	return best < 0 ? null : best / 100;
}

export function trackBars(cache: ReferenceCache, anchor: number, bpm: number, meter: string, start: number, end: number): number[] {
	const beats = Number(meter.split('/')[0]); // BPM 以拍號分母所指音符為一拍。
	const nominal = 60 / bpm * beats;
	const points: number[] = [];
	for (const direction of [-1, 1]) {
		let current = anchor, interval = nominal;
		if (direction > 0 && current < start - nominal) current += Math.max(0, Math.floor((start - current) / nominal) - 1) * nominal;
		if (direction < 0 && current > end + nominal) current -= Math.max(0, Math.floor((current - end) / nominal) - 1) * nominal;
		while (true) {
			const expected = current + direction * interval;
			if (expected < 0 || expected > cache.duration || (direction < 0 && expected < start - nominal) || (direction > 0 && expected > end + nominal)) break;
			const found = findOnset(cache, expected, Math.min(0.5, interval * 0.15), start, end);
			// 無可確認起音仍向前推進搜尋，但不把推算點標成確認點。
			const next = found ?? expected;
			if (Math.abs(next - current) < nominal * 0.5) break;
			if (found !== null && found >= start && found <= end) points.push(found);
			interval = Math.max(nominal * 0.8, Math.min(nominal * 1.2, interval * 0.75 + Math.abs(next - current) * 0.25));
			current = next;
		}
	}
	if (anchor >= start && anchor <= end) points.push(anchor);
	return points.sort((a, b) => a - b);
}
