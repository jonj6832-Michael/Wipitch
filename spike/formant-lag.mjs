// 量 Rubber Band 對 **formant** 自動化的反應延遲。
//
// 音高自動化早了 85ms（見 automation-lag.mjs）。formant 走的是同一條相位聲碼器
// 管線，理論上延遲應該一樣，但這是假設不是事實——rbcore 用 FORMANT_LAG_SEC
// 補償，補錯了會讓「畫一條 formant 曲線」在快速變化時對不上。
//
// 做法跟音高那支相同，只是把正弦餵給 formant 曲線，量的是「頻譜包絡重心」
// 而不是基頻：f0 固定不動，動的只有共振峰。
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';

const sr = 48000, HOP_SEC = 256 / 16000, F0 = 300, DUR = 6, DEPTH = 3;

/** 合成一個基頻固定、共振峰固定的母音 */
function vowel(n) {
	const x = new Float32Array(n);
	const p = new Float32Array(n); let g = 0;
	for (let i = 0; i < n; i++) { g += F0 / sr; if (g >= 1) { g -= 1; p[i] = 1; } }
	for (const [hz, bw, gn] of [[700, 90, 1], [1220, 110, .5], [2600, 140, .25]]) {
		const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * hz / sr;
		const a1 = 2 * r * Math.cos(th), a2 = -r * r; let y1 = 0, y2 = 0;
		for (let i = 0; i < n; i++) { const y = p[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; x[i] += y * gn; }
	}
	let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v));
	for (let i = 0; i < n; i++) x[i] *= 0.4 / pk;
	return x;
}

const n = sr * DUR;
const src = vowel(n);

/**
 * 頻譜包絡重心軌跡（半音，相對於整段的中位數）。
 *
 * 重心用的是 log 頻率上的加權平均——formant 移調在 log 頻率上是平移，
 * 用線性頻率的重心會被高頻能量主導，靈敏度差很多。
 * 只看 400Hz 以上，避開基頻本身（它不會跟著 formant 動）。
 */
function centroidTrack(x) {
	const N = 2048, hop = 256, out = [];
	const win = new Float32Array(N);
	for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
	const lo = Math.ceil(400 * N / sr), hi = Math.floor(5000 * N / sr);

	for (let off = sr * 1.0; off + N < x.length - sr * 1.0; off += hop) {
		// 只要 |X(k)|，用最單純的 Goertzel 式直接算比較慢但夠用；這裡用 DFT-lite：
		// 對 lo..hi 的每個 bin 做一次內積。N=2048、bin 約 200 個，可接受。
		let sw = 0, sm = 0;
		for (let k = lo; k <= hi; k++) {
			let re = 0, im = 0;
			const w = 2 * Math.PI * k / N;
			for (let i = 0; i < N; i++) {
				const v = x[off + i] * win[i];
				re += v * Math.cos(w * i); im -= v * Math.sin(w * i);
			}
			const mag = Math.hypot(re, im);
			const logf = Math.log2(k * sr / N);
			sw += mag * logf; sm += mag;
		}
		if (sm <= 0) continue;
		out.push({ t: (off + N / 2) / sr, s: 12 * (sw / sm) });
	}
	// 減掉中位數，讓 lock-in 只看到調變成分
	const med = out.map(o => o.s).sort((a, b) => a - b)[out.length >> 1];
	for (const o of out) o.s -= med;
	return out;
}

/** lock-in：回傳 {depth, lagMs}。做法與 automation-lag.mjs 完全相同。 */
function lockIn(track, hz) {
	let re = 0, im = 0;
	for (const { t, s } of track) { re += s * Math.cos(2 * Math.PI * hz * t); im += s * Math.sin(2 * Math.PI * hz * t); }
	re = 2 * re / track.length; im = 2 * im / track.length;
	const depth = Math.hypot(re, im);
	let phase = Math.atan2(-re, im);
	while (phase > Math.PI) phase -= 2 * Math.PI;
	while (phase <= -Math.PI) phase += 2 * Math.PI;
	return { depth, lagMs: phase / (2 * Math.PI * hz) * 1000 };
}

const frames = Math.ceil(DUR / HOP_SEC) + 2;
const zero = new Float32Array(frames);
const api = await loadRubberBand();
const RT = 1, FINER = 536870912, FORMANT = 16777216, HC = 67108864;

console.log('Rubber Band 的 formant 自動化延遲');
console.log(`（曲線是 ±${DEPTH} 半音的正弦，完美跟隨 = 深度 ${DEPTH.toFixed(2)}、延遲 0ms）\n`);
console.log('          ── 不補償 ──        ── 補償 39ms ──');
console.log('頻率       深度      延遲        深度      延遲');
console.log('──────   ──────  ─────────   ──────  ─────────');

for (const hz of [1, 2, 3, 5.5]) {
	const formant = new Float32Array(frames);
	for (let i = 0; i < frames; i++) formant[i] = DEPTH * Math.sin(2 * Math.PI * hz * i * HOP_SEC);
	const run = lag => {
		const [y] = renderWithCurve(api, {
			channels: [src], sampleRate: sr, delta: zero, gainDb: zero, formant,
			hopSec: HOP_SEC, options: RT | FINER | FORMANT | HC, formantLagSec: lag,
		});
		return lockIn(centroidTrack(y), hz);
	};
	const off = run(0), on = run(0.039);
	console.log(`${String(hz).padStart(5)}Hz   ${off.depth.toFixed(2).padStart(6)}  ${off.lagMs.toFixed(1).padStart(7)}ms   ${on.depth.toFixed(2).padStart(6)}  ${on.lagMs.toFixed(1).padStart(7)}ms`);
}

// 對照組：formant 曲線全 0 的話，包絡不該有任何調變
const [flat] = renderWithCurve(api, {
	channels: [src], sampleRate: sr, delta: zero, gainDb: zero, formant: zero,
	hopSec: HOP_SEC, options: RT | FINER | FORMANT | HC,
});
console.log(`\n對照組（formant 全 0）：5.5Hz 的調變深度 ${lockIn(centroidTrack(flat), 5.5).depth.toFixed(3)} 半音（應該接近 0）`);
