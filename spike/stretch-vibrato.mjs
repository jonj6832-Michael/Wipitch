// 伸縮後畫抖音的解析度測試。
//
// 素材：穩定 300Hz 母音，整段拉長 3 倍。在「輸出時間」上加 5.5Hz ±1 半音的抖音
// （跟畫筆一樣：抖音速率照輸出時間算），比較輸出的抖音深度。
// 舊的 16ms 格子在 3 倍下每格 48ms，抖音會被量化成折線、深度掉很多。
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { CURVE_HOP_SEC } from '../src/model/curves.ts';

const sr = 48000, F0 = 300, DUR = 2, RATIO = 3, VIB_HZ = 5.5, VIB_DEPTH = 1;
const n = sr * DUR, src = new Float32Array(n);
{
	const p = new Float32Array(n); let g = 0;
	for (let i = 0; i < n; i++) { g += F0 / sr; if (g >= 1) { g -= 1; p[i] = 1; } }
	for (const [hz, bw, gn] of [[700, 90, 1], [1220, 110, .5], [2600, 140, .25]]) {
		const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * hz / sr;
		const a1 = 2 * r * Math.cos(th), a2 = -r * r; let y1 = 0, y2 = 0;
		for (let i = 0; i < n; i++) { const y = p[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; src[i] += y * gn; }
	}
	let pk = 0; for (const v of src) pk = Math.max(pk, Math.abs(v));
	for (let i = 0; i < n; i++) src[i] *= 0.4 / pk;
}
const anchors = [{ src: DUR, out: DUR * RATIO }];

/** 輸出在 VIB_HZ 的音高調變深度（半音） */
function depth(x, from, to) {
	const N = 1024, hop = 128, pts = [];
	const lo = Math.floor(sr / (F0 * 2 ** .5)), hi = Math.ceil(sr / (F0 * 2 ** -.5));
	for (let off = Math.round(from * sr); off + N + hi < to * sr; off += hop) {
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
const run = (hop, blockSamples) => {
	const frames = Math.ceil(DUR / hop) + 2, delta = new Float32Array(frames), zero = new Float32Array(frames);
	// 曲線在原始時間，抖音在輸出時間：第 i 格的輸出時間 = i·hop·RATIO
	for (let i = 0; i < frames; i++) delta[i] = VIB_DEPTH * Math.sin(2 * Math.PI * VIB_HZ * i * hop * RATIO);
	const [y] = renderWithCurve(api, { channels: [src], sampleRate: sr, delta, gainDb: zero, hopSec: hop, anchors, blockSamples });
	return depth(y, 0.5, DUR * RATIO - 0.5);
};

const coarse = run(256 / 16000);
const fine = run(CURVE_HOP_SEC);
console.log(`拉長 ${RATIO} 倍，抖音 ${VIB_HZ}Hz ±${VIB_DEPTH} 半音`);
console.log(`16ms 格子：深度 ${coarse.toFixed(3)}`);
console.log(` 2ms 格子：深度 ${fine.toFixed(3)}`);
const ok = fine > 0.8 * VIB_DEPTH;
console.log(`${ok ? '✅' : '❌'} 2ms 格子保留 ${(fine / VIB_DEPTH * 100).toFixed(0)}%（門檻 80%）`);
process.exit(ok ? 0 : 1);
