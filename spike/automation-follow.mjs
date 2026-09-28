// 哪個引擎／設定跟得上快速的音高自動化？
//
// 這是壓平抖音功能的成敗關鍵：人聲抖音是 4~7Hz，Δ 曲線必須以那個速度變動。
// 測法：穩定音高的素材 + 正弦 Δ 曲線，量輸出音高的調變深度。
// 完美跟隨 = 量到的深度等於曲線深度；完全跟不上 = 0。
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { loadWasm, OfflineStretch } from './stretch-node.mjs';

const sr = 48000, HOP_SEC = 256 / 16000, F0 = 300, DUR = 4, DEPTH = 2;

const n = sr * DUR, src = new Float32Array(n);
{
	const pulses = new Float32Array(n); let g = 0;
	for (let i = 0; i < n; i++) { g += F0 / sr; if (g >= 1) { g -= 1; pulses[i] = 1; } }
	for (const [hz, bw, gn] of [[700, 90, 1], [1220, 110, .5], [2600, 140, .25]]) {
		const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * hz / sr;
		const a1 = 2 * r * Math.cos(th), a2 = -r * r; let y1 = 0, y2 = 0;
		for (let i = 0; i < n; i++) { const y = pulses[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; src[i] += y * gn; }
	}
	let pk = 0; for (const v of src) pk = Math.max(pk, Math.abs(v));
	for (let i = 0; i < n; i++) src[i] *= 0.4 / pk;
}

/** 逐格量音高（半音，相對 F0） */
function pitchTrack(x) {
	const N = 1536, hop = 256, out = [];
	const lo = Math.floor(sr / (F0 * Math.pow(2, 6 / 12)));
	const hi = Math.ceil(sr / (F0 * Math.pow(2, -6 / 12)));
	for (let off = sr * 0.6; off + N + hi < x.length - sr * 0.6; off += hop) {
		const cc = l => { let s = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { s += x[off + i] * x[off + i + l]; a += x[off + i] ** 2; b += x[off + i + l] ** 2; } return s / Math.sqrt(a * b + 1e-20); };
		let best = -2, bl = 0;
		for (let l = lo; l <= hi; l++) { const c = cc(l); if (c > best) { best = c; bl = l; } }
		if (!bl) continue;
		const ym = cc(Math.max(lo, bl - 1)), yp = cc(Math.min(hi, bl + 1)), d = ym - 2 * best + yp;
		const lag = bl + (d ? Math.max(-1, Math.min(1, 0.5 * (ym - yp) / d)) : 0);
		out.push({ t: (off + N / 2) / sr, semi: 12 * Math.log2((sr / lag) / F0) });
	}
	return out;
}

/**
 * 量輸出在指定頻率的調變深度：跟參考正弦做同調偵測（lock-in），
 * 這樣不受相位延遲影響，也不會被雜訊干擾。
 */
function modulationDepth(track, hz) {
	let re = 0, im = 0;
	for (const { t, semi } of track) {
		re += semi * Math.cos(2 * Math.PI * hz * t);
		im += semi * Math.sin(2 * Math.PI * hz * t);
	}
	return 2 * Math.hypot(re, im) / track.length;
}

const frames = Math.ceil(DUR / HOP_SEC) + 2;
const gain = new Float32Array(frames).fill(1);
const mkDelta = hz => { const d = new Float32Array(frames); for (let i = 0; i < frames; i++) d[i] = DEPTH * Math.sin(2 * Math.PI * hz * i * HOP_SEC); return d; };

const api = await loadRubberBand();
const wasm = await loadWasm(sr);
const ss = new OfflineStretch(wasm, sr, 1);

const RT = 1, OFFLINE = 0, FINER = 536870912, FASTER = 0, FORMANT = 16777216;
const HQ = 33554432, HS = 0, HC = 67108864;

const engines = [
	['RB R3 -F (現在用的)', hz => renderWithCurve(api, { channels: [src], sampleRate: sr, delta: mkDelta(hz), gain, hopSec: HOP_SEC, blockSamples: 512, options: RT | FINER | FORMANT | HQ })[0]],
	['RB R3 -F 一致性', hz => renderWithCurve(api, { channels: [src], sampleRate: sr, delta: mkDelta(hz), gain, hopSec: HOP_SEC, blockSamples: 512, options: RT | FINER | FORMANT | HC })[0]],
	['RB R2 -F 一致性', hz => renderWithCurve(api, { channels: [src], sampleRate: sr, delta: mkDelta(hz), gain, hopSec: HOP_SEC, blockSamples: 512, options: RT | FASTER | FORMANT | HC })[0]],
	['RB R2 -F 高速', hz => renderWithCurve(api, { channels: [src], sampleRate: sr, delta: mkDelta(hz), gain, hopSec: HOP_SEC, blockSamples: 512, options: RT | FASTER | FORMANT | HS })[0]],
	['Signalsmith', hz => { const d = mkDelta(hz); ss.wasm._reset(); return ss.render([src], t => ({ semitones: d[Math.min(d.length - 1, Math.round(t / HOP_SEC))], formantCompensation: true, formantBaseHz: 0 }), 512)[0]; }],
];

console.log(`素材 ${F0}Hz 穩定音，Δ 曲線是 ±${DEPTH} 半音的正弦`);
console.log('數字 = 輸出實際的調變深度（半音）。完美跟隨 = 2.00，完全跟不上 = 0\n');
const rates = [1, 2, 3, 5.5, 8];
console.log('引擎'.padEnd(24) + rates.map(r => `${r}Hz`.padStart(8)).join(''));
console.log('─'.repeat(24 + rates.length * 8));
// 先確認素材本身沒有調變，避免量到假訊號
console.log('（對照：原始素材）'.padEnd(22) + rates.map(r => modulationDepth(pitchTrack(src), r).toFixed(2).padStart(8)).join(''));
for (const [name, run] of engines) {
	const row = rates.map(hz => modulationDepth(pitchTrack(run(hz)), hz).toFixed(2).padStart(8)).join('');
	console.log(name.padEnd(24) + row);
}
