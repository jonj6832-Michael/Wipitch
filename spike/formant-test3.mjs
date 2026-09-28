// 再測：把時變 f0 做不同程度的平滑，看「餵多粗的估計值」才是對的。
// 文件的原話是 "Rough guesstimate of the fundamental frequency"。
import { readWav } from './wav.mjs';
import { loadWasm, OfflineStretch } from './stretch-node.mjs';
import { averageSpectrum, spectralEnvelope, envelopeCentroidSemitones } from './spectrum.mjs';
import { trackF0, f0At } from './f0track.mjs';

const FFT = 4096, START = 45, DUR = 8;
const w = readWav('Vocal.wav'); const sr = w.sampleRate;
const x = w.channels[0].subarray(START * sr, (START + DUR) * sr);
const centroid = s => envelopeCentroidSemitones(spectralEnvelope(averageSpectrum(s, FFT), 80), sr, FFT);
const base = centroid(x);
const resample = (src, r) => { const n = Math.floor(src.length / r), o = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * r, j = Math.floor(p), f = p - j; o[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f; } return o; };

const track = trackF0(x, sr);

// 用移動中位數平滑 f0（單位：秒）
function smoothed(win) {
	const n = Math.max(1, Math.round(win / track.hopSec));
	const out = track.f0.map((_, i) => {
		const a = track.f0.slice(Math.max(0, i - n >> 1), i + (n >> 1) + 1).filter(v => v > 0).sort((p, q) => p - q);
		return a.length ? a[a.length >> 1] : 0;
	});
	return { ...track, f0: out };
}

const tracks = { '逐frame': track, '平滑0.5s': smoothed(0.5), '平滑2s': smoothed(2) };
const median = (() => { const a = track.f0.filter(v => v > 0).sort((p, q) => p - q); return a[a.length >> 1]; })();

const wasm = await loadWasm(sr);
const st = new OfflineStretch(wasm, sr, 1);

const cases = [
	['AUTO(0)', k => () => ({ semitones: k, formantCompensation: true, formantBaseHz: 0 })],
	['逐frame', k => t => ({ semitones: k, formantCompensation: true, formantBaseHz: f0At(tracks['逐frame'], t) })],
	['平滑0.5s', k => t => ({ semitones: k, formantCompensation: true, formantBaseHz: f0At(tracks['平滑0.5s'], t) })],
	['平滑2s', k => t => ({ semitones: k, formantCompensation: true, formantBaseHz: f0At(tracks['平滑2s'], t) })],
	['固定中位數', k => () => ({ semitones: k, formantCompensation: true, formantBaseHz: median })],
];

const ks = [-7, -5, -2, 2, 5, 7];
const acc = cases.map(() => 0);
console.log(`f0 中位數 = ${median.toFixed(0)}Hz\n`);
console.log('半音  ' + cases.map(c => c[0].padEnd(12)).join(''));
console.log('────  ' + cases.map(() => '────────────').join(''));
for (const k of ks) {
	const calib = centroid(resample(x, Math.pow(2, k / 12))) - base;
	const cells = cases.map(([name, mk], i) => {
		st.wasm._reset();
		const [y] = st.render([x], mk(k), 1024);
		const ratio = 1 - (centroid(y) - base) / calib;
		acc[i] += ratio;
		return `${(ratio * 100).toFixed(0)}%`.padEnd(12);
	});
	console.log(String(k >= 0 ? '+' + k : k).padStart(4) + '  ' + cells.join(''));
}
console.log('────  ' + cases.map(() => '────────────').join(''));
console.log('平均  ' + acc.map(a => `${(a / ks.length * 100).toFixed(0)}%`.padEnd(12)).join(''));
