// 量 Rubber Band 對音高自動化的「反應延遲」。
//
// 這是壓平抖音失敗的真正原因：如果輸出比曲線慢了半個抖音週期（5.5Hz → 91ms），
// 反向抵銷就會變成同向疊加，抖音不減反增。
//
// 做法：穩定音高的合成素材 + 已知頻率的正弦 Δ 曲線，
// 用 lock-in 同時取出輸出調變的「深度」和「相位」，相位換算回時間就是延遲。
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';

const sr = 48000, HOP_SEC = 256 / 16000, F0 = 300, DUR = 6, DEPTH = 2;

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

/** 音高軌。時間戳標在分析視窗的「中心」——標在起點會引入 N/2 的系統性偏差。 */
function pitchTrack(x) {
	const N = 1024, hop = 128, out = [];
	const lo = Math.floor(sr / (F0 * 2 ** (6 / 12))), hi = Math.ceil(sr / (F0 * 2 ** (-6 / 12)));
	for (let off = sr * 1.0; off + N + hi < x.length - sr * 1.0; off += hop) {
		const cc = l => { let s = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { s += x[off + i] * x[off + i + l]; a += x[off + i] ** 2; b += x[off + i + l] ** 2; } return s / Math.sqrt(a * b + 1e-20); };
		let best = -2, bl = 0;
		for (let l = lo; l <= hi; l++) { const c = cc(l); if (c > best) { best = c; bl = l; } }
		if (!bl) continue;
		const ym = cc(Math.max(lo, bl - 1)), yp = cc(Math.min(hi, bl + 1)), d = ym - 2 * best + yp;
		const lag = bl + (d ? Math.max(-1, Math.min(1, .5 * (ym - yp) / d)) : 0);
		// +N/2：這個音高值代表的是視窗中心那個時刻
		out.push({ t: (off + N / 2) / sr, s: 12 * Math.log2((sr / lag) / F0) });
	}
	return out;
}

/** lock-in：回傳 {depth, lagMs}。輸入曲線是 DEPTH*sin(2πft)。 */
function lockIn(track, hz) {
	let re = 0, im = 0;
	for (const { t, s } of track) { re += s * Math.cos(2 * Math.PI * hz * t); im += s * Math.sin(2 * Math.PI * hz * t); }
	re = 2 * re / track.length; im = 2 * im / track.length;
	const depth = Math.hypot(re, im);
	// 輸出是 D·sin(ωt − φ)，其中 φ 是相位落後量。代入正交分量：
	//   re = <s·cos> ·2 = −D·sin φ
	//   im = <s·sin> ·2 = +D·cos φ
	// 所以 φ = atan2(−re, im)。（第一版寫成 atan2(re, im) 少了負號，
	// 量出來的延遲會變成「週期減去真值」，自我驗證時 50ms 量成 132.5ms。）
	let phase = Math.atan2(-re, im);
	// 收斂到 (−π, π]，這樣「早於曲線」會顯示成負數，比較好讀
	while (phase > Math.PI) phase -= 2 * Math.PI;
	while (phase <= -Math.PI) phase += 2 * Math.PI;
	return { depth, lagMs: phase / (2 * Math.PI * hz) * 1000 };
}

const frames = Math.ceil(DUR / HOP_SEC) + 2;
const gainDb = new Float32Array(frames);   // dB，0 = 不動
const api = await loadRubberBand();
const RT = 1, FINER = 536870912, FORMANT = 16777216, HC = 67108864;

// 先驗證量測本身：把已知延遲的曲線餵進去，看量出來對不對
console.log('量測自我驗證（直接對合成訊號做已知延遲的音高調變）');
for (const knownMs of [0, 50]) {
	const test = new Float32Array(n);
	{
		const p = new Float32Array(n); let g = 0;
		for (let i = 0; i < n; i++) {
			const t = i / sr - knownMs / 1000;
			g += F0 * Math.pow(2, DEPTH * Math.sin(2 * Math.PI * 5.5 * t) / 12) / sr;
			if (g >= 1) { g -= 1; p[i] = 1; }
		}
		for (const [hz, bw, gn] of [[700, 90, 1], [1220, 110, .5], [2600, 140, .25]]) {
			const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * hz / sr;
			const a1 = 2 * r * Math.cos(th), a2 = -r * r; let y1 = 0, y2 = 0;
			for (let i = 0; i < n; i++) { const y = p[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; test[i] += y * gn; }
		}
	}
	const r = lockIn(pitchTrack(test), 5.5);
	console.log(`   已知延遲 ${knownMs}ms → 量到 ${r.lagMs.toFixed(1)}ms（深度 ${r.depth.toFixed(2)}）`);
}

console.log('\nRubber Band 的音高自動化延遲');
console.log('          ── 不補償 ──        ── 補償 85ms ──');
console.log('頻率       深度      延遲        深度      延遲');
console.log('──────   ──────  ─────────   ──────  ─────────');
for (const hz of [1, 2, 3, 4, 5.5, 7]) {
	const delta = new Float32Array(frames);
	for (let i = 0; i < frames; i++) delta[i] = DEPTH * Math.sin(2 * Math.PI * hz * i * HOP_SEC);
	const run = lag => {
		const [y] = renderWithCurve(api, { channels: [src], sampleRate: sr, delta, gainDb, hopSec: HOP_SEC, options: RT | FINER | FORMANT | HC, automationLagSec: lag });
		return lockIn(pitchTrack(y), hz);
	};
	const off = run(0), on = run(0.085);
	console.log(`${String(hz).padStart(5)}Hz   ${off.depth.toFixed(2).padStart(6)}  ${off.lagMs.toFixed(1).padStart(7)}ms   ${on.depth.toFixed(2).padStart(6)}  ${on.lagMs.toFixed(1).padStart(7)}ms`);
}
