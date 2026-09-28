// 補測：餵「時變」基頻給 formant 分析，對照 AUTO（library 自己測）。
import { readWav, writeWav } from './wav.mjs';
import { loadWasm, OfflineStretch } from './stretch-node.mjs';
import { averageSpectrum, spectralEnvelope, envelopeCentroidSemitones } from './spectrum.mjs';
import { trackF0, f0At } from './f0track.mjs';

const FFT = 4096, START = 45, DUR = 8;
const w = readWav('Vocal.wav');
const sr = w.sampleRate;
const x = w.channels[0].subarray(START * sr, (START + DUR) * sr);

const centroid = s => envelopeCentroidSemitones(spectralEnvelope(averageSpectrum(s, FFT), 80), sr, FFT);
const base = centroid(x);
const resample = (src, r) => { const n = Math.floor(src.length / r), o = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * r, j = Math.floor(p), f = p - j; o[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f; } return o; };

console.log('追蹤基頻中…');
const t0 = Date.now();
const track = trackF0(x, sr);
console.log(`  ${track.f0.length} 個 frame，耗時 ${Date.now() - t0}ms`);

const wasm = await loadWasm(sr);
const stretch = new OfflineStretch(wasm, sr, 1);

const variants = {
	AUTO:    k => () => ({ semitones: k, formantCompensation: true, formantBaseHz: 0 }),
	TRACKED: k => t => ({ semitones: k, formantCompensation: true, formantBaseHz: f0At(track, t) }),
};

console.log();
console.log('半音   校準基準   AUTO(自動)         TRACKED(餵時變f0)');
console.log('────  ────────  ─────────────────  ─────────────────');
const acc = { AUTO: 0, TRACKED: 0 };
const ks = [-7, -5, -2, 2, 5, 7];
for (const k of ks) {
	const calib = centroid(resample(x, Math.pow(2, k / 12))) - base;
	const cells = [];
	for (const name of ['AUTO', 'TRACKED']) {
		stretch.wasm._reset();
		const [y] = stretch.render([x], variants[name](k), 1024);
		const shift = centroid(y) - base;
		const ratio = 1 - shift / calib;
		acc[name] += ratio;
		cells.push(`${shift >= 0 ? '+' : ''}${shift.toFixed(2)} (保留 ${(ratio * 100).toFixed(0)}%)`);
		writeWav(`spike/out/${k >= 0 ? '+' : ''}${k}_${name}.wav`, [y], sr);
	}
	console.log(String(k >= 0 ? '+' + k : k).padStart(4) + '  ' + ((calib >= 0 ? '+' : '') + calib.toFixed(2)).padEnd(8) + '  ' + cells[0].padEnd(19) + cells[1]);
}
console.log();
console.log(`平均保留率： AUTO ${(acc.AUTO / ks.length * 100).toFixed(0)}%   TRACKED ${(acc.TRACKED / ks.length * 100).toFixed(0)}%`);
