// 換成 PitchHighConsistency 之後，確認沒有賠掉別的東西：
//   1. block 大小還需不需要調小
//   2. 音色保留還在不在
//   3. Δ=0 的恆等性還在不在
//   4. 速度
import { readWav } from './wav.mjs';
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { averageSpectrum, spectralEnvelope, envelopeCentroidSemitones } from './spectrum.mjs';

const sr = 48000, HOP_SEC = 256 / 16000;
const RT = 1, FINER = 536870912, FORMANT = 16777216, HQ = 33554432, HC = 67108864;
const api = await loadRubberBand();

// ── 1. block 大小掃描（用穩定合成音 + 5.5Hz 正弦 Δ）──
const F0 = 300, DUR = 4, DEPTH = 2;
const n = sr * DUR, synth = new Float32Array(n);
{
	const p = new Float32Array(n); let g = 0;
	for (let i = 0; i < n; i++) { g += F0 / sr; if (g >= 1) { g -= 1; p[i] = 1; } }
	for (const [hz, bw, gn] of [[700, 90, 1], [1220, 110, .5], [2600, 140, .25]]) {
		const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * hz / sr;
		const a1 = 2 * r * Math.cos(th), a2 = -r * r; let y1 = 0, y2 = 0;
		for (let i = 0; i < n; i++) { const y = p[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; synth[i] += y * gn; }
	}
	let pk = 0; for (const v of synth) pk = Math.max(pk, Math.abs(v));
	for (let i = 0; i < n; i++) synth[i] *= 0.4 / pk;
}
const frames = Math.ceil(DUR / HOP_SEC) + 2;
const gainFlat = new Float32Array(frames);   // dB，0 = 不動
const sine = new Float32Array(frames);
for (let i = 0; i < frames; i++) sine[i] = DEPTH * Math.sin(2 * Math.PI * 5.5 * i * HOP_SEC);

function depth(x) {
	const N = 1536, hop = 256, pts = [];
	const lo = Math.floor(sr / (F0 * 2 ** .5)), hi = Math.ceil(sr / (F0 * 2 ** -.5));
	for (let off = sr * .6; off + N + hi < x.length - sr * .6; off += hop) {
		const cc = l => { let s = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { s += x[off + i] * x[off + i + l]; a += x[off + i] ** 2; b += x[off + i + l] ** 2; } return s / Math.sqrt(a * b + 1e-20); };
		let best = -2, bl = 0;
		for (let l = lo; l <= hi; l++) { const c = cc(l); if (c > best) { best = c; bl = l; } }
		if (!bl) continue;
		const ym = cc(Math.max(lo, bl - 1)), yp = cc(Math.min(hi, bl + 1)), d = ym - 2 * best + yp;
		pts.push({ t: (off + N / 2) / sr, s: 12 * Math.log2((sr / (bl + (d ? Math.max(-1, Math.min(1, .5 * (ym - yp) / d)) : 0))) / F0) });
	}
	let re = 0, im = 0;
	for (const { t, s } of pts) { re += s * Math.cos(2 * Math.PI * 5.5 * t); im += s * Math.sin(2 * Math.PI * 5.5 * t); }
	return 2 * Math.hypot(re, im) / pts.length;
}

console.log('① block 大小對「跟隨 5.5Hz 音高自動化」的影響（目標 2.00）');
for (const block of [4096, 2048, 1024, 512, 256]) {
	const t0 = Date.now();
	const [y] = renderWithCurve(api, { channels: [synth], sampleRate: sr, delta: sine, gainDb: gainFlat, hopSec: HOP_SEC, blockSamples: block, options: RT | FINER | FORMANT | HC });
	console.log(`   block ${String(block).padStart(4)} (${(block / sr * 1000).toFixed(1)}ms) → 深度 ${depth(y).toFixed(2)}   ${DUR / ((Date.now() - t0) / 1000) | 0}x 即時`);
}

// ── 2~4. 拿真實人聲測音色保留、恆等性、速度 ──
const w = readWav('Vocal.wav');
const x = w.channels[0].subarray(45 * sr, 53 * sr);
const vf = Math.ceil(8 / HOP_SEC) + 2;
const vgain = new Float32Array(vf);          // dB，0 = 不動
const mid = s => s.subarray(2 * sr, 6 * sr);
const cen = s => envelopeCentroidSemitones(spectralEnvelope(averageSpectrum(mid(s), 4096), 80), sr, 4096);
const base = cen(x);

console.log('\n② 音色保留（formant 偏移量，半音，越小越好）');
console.log('   半音    高品質(舊)   一致性(新)');
for (const k of [-7, -5, -2, 2, 5, 7]) {
	const d = new Float32Array(vf).fill(k);
	const a = renderWithCurve(api, { channels: [x], sampleRate: sr, delta: d, gainDb: vgain, hopSec: HOP_SEC, blockSamples: 512, options: RT | FINER | FORMANT | HQ })[0];
	const b = renderWithCurve(api, { channels: [x], sampleRate: sr, delta: d, gainDb: vgain, hopSec: HOP_SEC, blockSamples: 512, options: RT | FINER | FORMANT | HC })[0];
	const f = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
	console.log(`   ${String(k >= 0 ? '+' + k : k).padStart(4)}    ${f(cen(a) - base).padStart(9)}   ${f(cen(b) - base).padStart(9)}`);
}

console.log('\n③ Δ=0 恆等性（輸出應與輸入對齊且幾乎相同）');
const zero = new Float32Array(vf);
const t0 = Date.now();
const [ident] = renderWithCurve(api, { channels: [x], sampleRate: sr, delta: zero, gainDb: vgain, hopSec: HOP_SEC, blockSamples: 512, options: RT | FINER | FORMANT | HC });
const ms = Date.now() - t0;
let bestLag = 0, bestC = -2;
for (let lag = -600; lag <= 600; lag++) {
	let num = 0, da = 0, db = 0;
	for (let i = sr * 2; i < sr * 5; i += 3) { const p = x[i], q = ident[i + lag] || 0; num += p * q; da += p * p; db += q * q; }
	const c = num / Math.sqrt(da * db + 1e-20);
	if (c > bestC) { bestC = c; bestLag = lag; }
}
console.log(`   lag = ${bestLag} sample，相關係數 ${bestC.toFixed(4)}`);
console.log(`\n④ 速度：8 秒素材 ${ms}ms → ${(8 / (ms / 1000)).toFixed(1)}x 即時`);
