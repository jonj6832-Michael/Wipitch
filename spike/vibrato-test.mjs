// 診斷「壓平抖音會斷斷續續」的問題，並找出正確的 block 大小。
//
// 做法：合成一個「音高完全穩定 + 人工抖音」的母音，然後餵一條剛好抵銷抖音的
// Δ 曲線進去。理想結果是輸出音高變成一條水平線。
// 如果 block 太大，音高會變成階梯狀——那就是聽起來斷斷續續的原因。
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { writeWav } from './wav.mjs';

const sr = 48000;
const HOP_SEC = 256 / 16000;
const F0 = 300;            // 基頻
const VIB_HZ = 5.5;        // 抖音頻率（人聲典型值）
const VIB_SEMI = 0.5;      // 抖音深度（±0.5 半音）
const DUR = 3;

// --- 合成帶抖音的母音 ---
const n = sr * DUR;
const src = new Float32Array(n);
{
	let phase = 0, glottal = 0;
	const formants = [[700, 90, 1], [1220, 110, 0.5], [2600, 140, 0.25]];
	const pulses = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const semis = VIB_SEMI * Math.sin(2 * Math.PI * VIB_HZ * i / sr);
		const f = F0 * Math.pow(2, semis / 12);
		glottal += f / sr;
		if (glottal >= 1) { glottal -= 1; pulses[i] = 1; }
	}
	for (const [hz, bw, gain] of formants) {
		const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * hz / sr;
		const a1 = 2 * r * Math.cos(th), a2 = -r * r;
		let y1 = 0, y2 = 0;
		for (let i = 0; i < n; i++) { const y = pulses[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; src[i] += y * gain; }
	}
	let pk = 0; for (const v of src) pk = Math.max(pk, Math.abs(v));
	for (let i = 0; i < n; i++) src[i] *= 0.4 / pk;
}

// --- 抵銷抖音的 Δ 曲線（這正是壓平功能會產生的東西）---
const frames = Math.ceil(DUR / HOP_SEC) + 2;
const delta = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
	const t = i * HOP_SEC;
	delta[i] = -VIB_SEMI * Math.sin(2 * Math.PI * VIB_HZ * t);
}
const gain = new Float32Array(frames).fill(1);

// --- 用自相關量輸出的音高 ---
//
// 搜尋範圍刻意夾得很窄（預期基頻的 ±5 半音）。合成的脈衝串加上強共振峰
// 很容易讓自相關在兩倍週期處出現更高的峰，產生八度錯誤——第一版就是這樣
// 量到「原始起伏 2.46 半音、最大跳躍 12 半音」這種明顯荒謬的數字。
function trackF0(x) {
	const N = 2048, hop = 128;
	const lo = Math.floor(sr / (F0 * Math.pow(2, 5 / 12)));
	const hi = Math.ceil(sr / (F0 * Math.pow(2, -5 / 12)));
	const out = [];
	for (let off = sr * 0.3; off + N + hi < x.length - sr * 0.3; off += hop) {
		let best = -2, bl = 0;
		for (let lag = lo; lag <= hi; lag++) {
			let s = 0, n1 = 0, n2 = 0;
			for (let i = 0; i < N; i++) { s += x[off + i] * x[off + i + lag]; n1 += x[off + i] ** 2; n2 += x[off + i + lag] ** 2; }
			const c = s / Math.sqrt(n1 * n2 + 1e-20);
			if (c > best) { best = c; bl = lag; }
		}
		if (!bl) continue;
		// 拋物線內插，讓解析度細於一個 sample，否則量不出小於半音的差異
		const cc = l => {
			let s = 0, n1 = 0, n2 = 0;
			for (let i = 0; i < N; i++) { s += x[off + i] * x[off + i + l]; n1 += x[off + i] ** 2; n2 += x[off + i + l] ** 2; }
			return s / Math.sqrt(n1 * n2 + 1e-20);
		};
		const ym = cc(Math.max(lo, bl - 1)), y0 = best, yp = cc(Math.min(hi, bl + 1));
		const denom = ym - 2 * y0 + yp;
		const shift = denom !== 0 ? 0.5 * (ym - yp) / denom : 0;
		out.push(sr / (bl + Math.max(-1, Math.min(1, shift))));
	}
	return out;
}

const stdSemi = f0s => {
	const m = f0s.reduce((a, b) => a + b) / f0s.length;
	const semis = f0s.map(f => 12 * Math.log2(f / m));
	return Math.sqrt(semis.reduce((a, s) => a + s * s, 0) / semis.length);
};
/** 相鄰音高值的最大跳躍（半音）——階梯狀的話這個會很大 */
const maxStep = f0s => {
	let m = 0;
	for (let i = 1; i < f0s.length; i++) m = Math.max(m, Math.abs(12 * Math.log2(f0s[i] / f0s[i - 1])));
	return m;
};

const api = await loadRubberBand();
const OPT_BASE = 1 | 536870912 | 16777216;          // RealTime | Finer | FormantPreserved
const QUALITY = 33554432, CONSISTENCY = 67108864;

console.log(`素材：${F0}Hz，抖音 ${VIB_HZ}Hz ±${VIB_SEMI} 半音`);
const before = trackF0(src);
const beforeStd = stdSemi(before);
const expect = VIB_SEMI / Math.SQRT2;
console.log(`原始音高起伏 = ${beforeStd.toFixed(3)} 半音（理論值 ${expect.toFixed(3)}）`);
if (Math.abs(beforeStd - expect) > 0.08) {
	console.log('❌ 追蹤器對不上理論值，測量不可信，不用往下看了');
	process.exit(1);
}
console.log('✅ 追蹤器驗證通過\n');
console.log('block          選項              壓平後起伏   最大跳躍   耗時');
console.log('─────────────  ────────────────  ──────────  ────────  ──────');

for (const [optName, opt] of [['HighQuality', QUALITY], ['HighConsistency', CONSISTENCY]]) {
	for (const block of [4096, 2048, 1024, 512, 256]) {
		const t0 = Date.now();
		const [y] = renderWithCurve(api, {
			channels: [src], sampleRate: sr, delta, gain, hopSec: HOP_SEC,
			blockSamples: block, options: OPT_BASE | opt,
		});
		const ms = Date.now() - t0;
		const f0s = trackF0(y);
		const label = `${String(block).padStart(4)} (${(block / sr * 1000).toFixed(1)}ms)`;
		console.log(`${label.padEnd(15)}${optName.padEnd(18)}${stdSemi(f0s).toFixed(3).padStart(9)}   ${maxStep(f0s).toFixed(3).padStart(8)}   ${String(ms).padStart(4)}ms`);
		if (block === 4096 && opt === QUALITY) writeWav('spike/out/vib_bad.wav', [y], sr);
		if (block === 256 && opt === CONSISTENCY) writeWav('spike/out/vib_good.wav', [y], sr);
	}
}
writeWav('spike/out/vib_orig.wav', [src], sr);
