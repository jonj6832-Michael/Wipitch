// Rubber Band realtime 模式的實際表現。
//
// 這才是我們真正會用到的模式：時變音高曲線在 Rubber Band 裡只能靠
// realtime 模式逐 block 改 pitch scale（離線模式的 pitch 是整段固定的）。
import { readWav } from './wav.mjs';
import { loadRubberBand, rbPitchShift } from './rubberband-node.mjs';
import { averageSpectrum, spectralEnvelope, envelopeCentroidSemitones } from './spectrum.mjs';

const FFT = 4096, START = 45, DUR = 8;
const w = readWav('Vocal.wav'); const sr = w.sampleRate;
const x = w.channels[0].subarray(START * sr, (START + DUR) * sr);
const centroid = s => envelopeCentroidSemitones(spectralEnvelope(averageSpectrum(s, FFT), 80), sr, FFT);
const base = centroid(x);
const resample = (src, r) => { const n = Math.floor(src.length / r), o = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * r, j = Math.floor(p), f = p - j; o[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f; } return o; };

const api = await loadRubberBand();
const cases = [
	['離線 -F', k => rbPitchShift(api, [x], sr, k, true, false)[0]],
	['即時 -F', k => rbPitchShift(api, [x], sr, k, true, true)[0]],
	['即時 關-F', k => rbPitchShift(api, [x], sr, k, false, true)[0]],
];
console.log('半音  校準     ' + cases.map(c => c[0].padEnd(20)).join(''));
console.log('────  ───────  ' + cases.map(() => '────────────────────').join(''));
for (const k of [-7, -5, -2, 2, 5, 7]) {
	const calib = centroid(resample(x, Math.pow(2, k / 12))) - base;
	const cells = cases.map(([, run]) => {
		const shift = centroid(run(k)) - base;
		return `${shift >= 0 ? '+' : ''}${shift.toFixed(2)} → ${(((1 - shift / calib)) * 100).toFixed(0)}%`.padEnd(20);
	});
	console.log(String(k >= 0 ? '+' + k : k).padStart(4) + '  ' + ((calib >= 0 ? '+' : '') + calib.toFixed(2)).padEnd(7) + '  ' + cells.join(''));
}
