// 壓平抖音的 ground truth 測試。
//
// 素材是合成的：音高完全已知（穩定基頻 + 已知深度與頻率的抖音），
// 所以「壓平之後應該長什麼樣」有明確答案，不用倚賴不可靠的音高追蹤。
//
// 流程跑的是真正的產品程式碼：edits.flattenRange → rbcore.renderWithCurve。
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { Curves, CURVE_HOP_SEC } from '../src/model/curves.ts';
import { flattenRange, limitSlope } from '../src/model/edits.ts';

// 曲線格子（跟產品一樣 2ms 一格）
const sr = 48000, HOP_SEC = CURVE_HOP_SEC;
const F0 = 300, DUR = 5, VIB_HZ = 5.5, VIB_DEPTH = 0.6;
const SEL_FROM = 0.8, SEL_TO = 4.2;

// --- 合成：穩定基頻 + 已知抖音 ---
const n = sr * DUR, src = new Float32Array(n);
const trueSemi = t => VIB_DEPTH * Math.sin(2 * Math.PI * VIB_HZ * t);
{
	const p = new Float32Array(n); let g = 0;
	for (let i = 0; i < n; i++) {
		g += F0 * Math.pow(2, trueSemi(i / sr) / 12) / sr;
		if (g >= 1) { g -= 1; p[i] = 1; }
	}
	for (const [hz, bw, gn] of [[700, 90, 1], [1220, 110, .5], [2600, 140, .25]]) {
		const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * hz / sr;
		const a1 = 2 * r * Math.cos(th), a2 = -r * r; let y1 = 0, y2 = 0;
		for (let i = 0; i < n; i++) { const y = p[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; src[i] += y * gn; }
	}
	let pk = 0; for (const v of src) pk = Math.max(pk, Math.abs(v));
	for (let i = 0; i < n; i++) src[i] *= 0.4 / pk;
}

// --- app 會有的資料：完美的音高偵測結果（這裡直接用真值，排除偵測誤差的干擾）---
const frames = Math.ceil(DUR / HOP_SEC);
const pitchMidi = new Float32Array(frames), voiced = new Uint8Array(frames).fill(1);
for (let i = 0; i < frames; i++) {
	pitchMidi[i] = 69 + 12 * Math.log2(F0 / 440) + trueSemi(i * HOP_SEC);
}

/** 量輸出在 VIB_HZ 的音高調變深度（半音） */
function depth(x) {
	const N = 1024, hop = 128, pts = [];
	const lo = Math.floor(sr / (F0 * 2 ** .5)), hi = Math.ceil(sr / (F0 * 2 ** -.5));
	for (let off = Math.round((SEL_FROM + 0.3) * sr); off + N + hi < (SEL_TO - 0.3) * sr; off += hop) {
		const cc = l => { let s = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { s += x[off + i] * x[off + i + l]; a += x[off + i] ** 2; b += x[off + i + l] ** 2; } return s / Math.sqrt(a * b + 1e-20); };
		let best = -2, bl = 0;
		for (let l = lo; l <= hi; l++) { const c = cc(l); if (c > best) { best = c; bl = l; } }
		if (!bl) continue;
		const ym = cc(Math.max(lo, bl - 1)), yp = cc(Math.min(hi, bl + 1)), d = ym - 2 * best + yp;
		const lag = bl + (d ? Math.max(-1, Math.min(1, .5 * (ym - yp) / d)) : 0);
		pts.push({ t: (off + N / 2) / sr, s: 12 * Math.log2((sr / lag) / F0) });
	}
	let re = 0, im = 0;
	for (const { t, s } of pts) { re += s * Math.cos(2 * Math.PI * VIB_HZ * t); im += s * Math.sin(2 * Math.PI * VIB_HZ * t); }
	return 2 * Math.hypot(re, im) / pts.length;
}

const api = await loadRubberBand();
const before = depth(src);
console.log(`合成素材：${F0}Hz，抖音 ${VIB_HZ}Hz ±${VIB_DEPTH} 半音`);
console.log(`量到的原始抖音深度 = ${before.toFixed(4)}（真值 ${VIB_DEPTH.toFixed(4)}）`);
if (Math.abs(before - VIB_DEPTH) > 0.06) { console.log('❌ 量測對不上真值'); process.exit(1); }
console.log('✅ 量測驗證通過\n');

console.log('α=0（完全壓平）。目標是把深度壓到接近 0。\n');
console.log('延遲補償   算繪後深度   剩餘比例');
console.log('────────   ──────────   ────────');
let best = { lag: 0, d: Infinity };
for (let lagMs = 0; lagMs <= 140; lagMs += 20) {
	const curves = new Curves(frames);
	flattenRange(curves, pitchMidi, voiced, SEL_FROM, SEL_TO, 0);
	const [y] = renderWithCurve(api, {
		channels: [src], sampleRate: sr, delta: curves.pitch, gainDb: curves.gainDb,
		hopSec: HOP_SEC, automationLagSec: lagMs / 1000,
	});
	const d = depth(y);
	if (d < best.d) best = { lag: lagMs, d };
	console.log(`${String(lagMs).padStart(5)}ms    ${d.toFixed(4).padStart(9)}     ${(d / before * 100).toFixed(0).padStart(4)}%  ${'█'.repeat(Math.round(d / before * 30))}`);
}
console.log(`\n最佳補償 = ${best.lag}ms → 剩餘 ${(best.d / before * 100).toFixed(0)}%`);

// 用產品的預設設定再跑一次，這才是驗收的重點
const curves = new Curves(frames);
flattenRange(curves, pitchMidi, voiced, SEL_FROM, SEL_TO, 0);
// 產品在壓平之後會套用音高變化上限（main.ts 的 limitPitchSlope），驗收也要一起套
limitSlope(curves.pitch, 0, curves.length, curves.pitchSlopeLimit);
const [prod] = renderWithCurve(api, {
	channels: [src], sampleRate: sr, delta: curves.pitch, gainDb: curves.gainDb, hopSec: HOP_SEC,
});
const residual = depth(prod) / before;
const ok = residual < 0.35;
console.log(`\n${ok ? '✅' : '❌'} 產品預設設定：抖音剩餘 ${(residual * 100).toFixed(0)}%（門檻 35%）`);
process.exit(ok ? 0 : 1);
