/** 以使用者錨點為第一拍，在輸入 BPM 附近尋找參考音軌的脈衝速度。 */
export function estimateReferenceTempo(channels: Float32Array[], sampleRate: number, anchorSec: number, roughBpm: number): number | null {
	if (!channels.length || !Number.isFinite(roughBpm)) return null;
	const hop = Math.max(1, Math.round(sampleRate / 100));
	const count = Math.floor(channels[0].length / hop);
	if (count < 200) return null;
	const energy = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		let sum = 0;
		for (let s = i * hop; s < (i + 1) * hop; s++) {
			let sample = 0;
			for (const channel of channels) sample += channel[s] / channels.length;
			sum += sample * sample;
		}
		energy[i] = Math.sqrt(sum / hop);
	}
	const onset = new Float32Array(count);
	let total = 0;
	for (let i = 2; i < count; i++) {
		onset[i] = Math.max(0, energy[i] - energy[i - 2]);
		total += onset[i];
	}
	if (total < 1e-4) return null;
	const stepSec = hop / sampleRate;
	const low = Math.max(30, Math.round(roughBpm * 0.75));
	const high = Math.min(300, Math.round(roughBpm * 1.25));
	let best = low, bestScore = -Infinity;
	for (let bpm = low; bpm <= high; bpm += 0.25) {
		const beat = 60 / bpm;
		let score = 0, beats = 0;
		for (let t = anchorSec; t < count * stepSec && beats < 64; t += beat, beats++) {
			const center = Math.round(t / stepSec);
			let peak = 0;
			for (let k = -5; k <= 5; k++) if (center + k >= 0 && center + k < count) peak = Math.max(peak, onset[center + k]);
			score += peak;
		}
		if (beats >= 4 && score / beats > bestScore) { bestScore = score / beats; best = bpm; }
	}
	return bestScore > 0 ? Math.round(best * 10) / 10 : null;
}
