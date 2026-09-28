// Spike 1b 正式驗收：Signalsmith vs Rubber Band，保留音色的品質與速度。
import { readWav, writeWav } from './wav.mjs';
import { loadWasm, OfflineStretch } from './stretch-node.mjs';
import { loadRubberBand, rbPitchShift } from './rubberband-node.mjs';
import { averageSpectrum, spectralEnvelope, envelopeCentroidSemitones } from './spectrum.mjs';

const FFT = 4096, START = 45, DUR = 8;
const w = readWav('Vocal.wav');
const sr = w.sampleRate;
const x = w.channels[0].subarray(START * sr, (START + DUR) * sr);

const centroid = s => envelopeCentroidSemitones(spectralEnvelope(averageSpectrum(s, FFT), 80), sr, FFT);
const base = centroid(x);
const resample = (src, r) => { const n = Math.floor(src.length / r), o = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * r, j = Math.floor(p), f = p - j; o[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f; } return o; };

const wasm = await loadWasm(sr);
const ss = new OfflineStretch(wasm, sr, 1);
const rbApi = await loadRubberBand();

const engines = [
	['SS 關formant', k => { ss.wasm._reset(); return ss.render([x], () => ({ semitones: k, formantCompensation: false }), 1024)[0]; }],
	['SS 開formant', k => { ss.wasm._reset(); return ss.render([x], () => ({ semitones: k, formantCompensation: true, formantBaseHz: 0 }), 1024)[0]; }],
	['RB -3 關-F', k => rbPitchShift(rbApi, [x], sr, k, false)[0]],
	['RB -3 -F', k => rbPitchShift(rbApi, [x], sr, k, true)[0]],
	['RB 即時 -F', k => rbPitchShift(rbApi, [x], sr, k, true, true)[0]],
];

const ks = [-7, -5, -2, 2, 5, 7];
const acc = engines.map(() => 0);
const time = engines.map(() => 0);

console.log(`素材：Vocal.wav ${START}s~${START + DUR}s（女聲，f0 中位數 361Hz）`);
console.log('數字 = 音色保留率，100% 為完美保留、0% 為完全沒保留\n');
console.log('半音  ' + engines.map(e => e[0].padEnd(14)).join(''));
console.log('────  ' + engines.map(() => '──────────────').join(''));

for (const k of ks) {
	const calib = centroid(resample(x, Math.pow(2, k / 12))) - base;
	const cells = engines.map(([name, run], i) => {
		const t0 = Date.now();
		const y = run(k);
		time[i] += Date.now() - t0;
		const ratio = 1 - (centroid(y) - base) / calib;
		acc[i] += ratio;
		writeWav(`spike/out/cmp_${k >= 0 ? '+' : ''}${k}_${name.replace(/[ -]/g, '')}.wav`, [y], sr);
		return `${(ratio * 100).toFixed(0)}%`.padEnd(14);
	});
	console.log(String(k >= 0 ? '+' + k : k).padStart(4) + '  ' + cells.join(''));
}
console.log('────  ' + engines.map(() => '──────────────').join(''));
console.log('平均  ' + acc.map(a => `${(a / ks.length * 100).toFixed(0)}%`.padEnd(14)).join(''));
console.log('速度  ' + time.map(t => `${(DUR * ks.length / (t / 1000)).toFixed(0)}x即時`.padEnd(14)).join(''));
writeWav('spike/out/cmp_original.wav', [x], sr);
