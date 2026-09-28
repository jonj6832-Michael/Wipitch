// 合成「源—濾波器」模型的人聲：聲門脈衝串 → 共振峰濾波器。
// 好處是共振峰位置完全已知，可以拿來驗證測量工具對不對。
export function synthVowel(sampleRate, seconds, f0, formants) {
	const n = Math.round(sampleRate * seconds);
	const src = new Float32Array(n);

	// 聲門脈衝串（每個週期一根脈衝）
	let phase = 0;
	for (let i = 0; i < n; i++) {
		phase += f0 / sampleRate;
		if (phase >= 1) { phase -= 1; src[i] = 1; }
	}

	// 每個共振峰是一個二階帶通共振器，串成並聯
	const out = new Float32Array(n);
	for (const { hz, bw, gain } of formants) {
		const r = Math.exp(-Math.PI * bw / sampleRate);
		const theta = 2 * Math.PI * hz / sampleRate;
		const a1 = 2 * r * Math.cos(theta), a2 = -r * r;
		let y1 = 0, y2 = 0;
		for (let i = 0; i < n; i++) {
			const y = src[i] + a1 * y1 + a2 * y2;
			y2 = y1; y1 = y;
			out[i] += y * gain;
		}
	}

	let peak = 0;
	for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
	for (let i = 0; i < n; i++) out[i] *= 0.5 / peak;
	return out;
}

// 一個 /a/ 母音的典型共振峰
export const VOWEL_A = [
	{ hz: 700, bw: 90, gain: 1.0 },
	{ hz: 1220, bw: 110, gain: 0.5 },
	{ hz: 2600, bw: 140, gain: 0.25 },
];
