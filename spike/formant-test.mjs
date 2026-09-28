// Spike 1b：Signalsmith 的「保留音色」到底有沒有效、效果多好。
//
// 測量方法：比較移調前後「頻譜包絡重心」移動了幾個半音。
//   - 完全沒保留音色 → 包絡跟著泛音一起移動
//   - 完美保留音色   → 包絡完全不動（重心差 = 0）
//
// 絕對數值會被分析頻帶截斷壓縮，所以不直接看絕對值，而是用「單純改變播放
// 速度」的版本當校準基準——那是定義上「完全沒保留」的樣子。於是：
//
//   保留率 = 1 − (量到的包絡位移 / 校準基準的包絡位移)
//
//   1.0 = 完美保留     0.0 = 完全沒保留
import { readWav, writeWav } from './wav.mjs';
import { loadWasm, OfflineStretch } from './stretch-node.mjs';
import { averageSpectrum, spectralEnvelope, envelopeCentroidSemitones } from './spectrum.mjs';

const FFT = 4096;
const START = 45, DUR = 8;
const F0_HZ = 316;          // 這段人聲的基頻中位數（自相關量出來的）

const w = readWav('Vocal.wav');
const sr = w.sampleRate;
const x = w.channels[0].subarray(START * sr, (START + DUR) * sr);

const centroid = sig => envelopeCentroidSemitones(spectralEnvelope(averageSpectrum(sig, FFT), 80), sr, FFT);
const base = centroid(x);

// 單純改速度：泛音與包絡一起移動，定義上「完全沒保留音色」
function resample(src, ratio) {
	const n = Math.floor(src.length / ratio), out = new Float32Array(n);
	for (let i = 0; i < n; i++) { const p = i * ratio, j = Math.floor(p), f = p - j; out[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f; }
	return out;
}

const wasm = await loadWasm(sr);
const stretch = new OfflineStretch(wasm, sr, 1);

const variants = {
	OFF:   k => ({ semitones: k, formantCompensation: false }),
	AUTO:  k => ({ semitones: k, formantCompensation: true, formantBaseHz: 0 }),
	FIXED: k => ({ semitones: k, formantCompensation: true, formantBaseHz: F0_HZ }),
};

console.log(`素材：Vocal.wav ${START}s ~ ${START + DUR}s，f0 中位數 ${F0_HZ}Hz`);
console.log();
console.log('半音   校準基準   OFF(關)        AUTO(自動測基頻)   FIXED(餵基頻)');
console.log('────  ────────  ─────────────  ─────────────────  ─────────────────');

const rows = [];
for (const k of [-7, -5, -2, 2, 5, 7]) {
	const calib = centroid(resample(x, Math.pow(2, k / 12))) - base;
	const cells = [];
	for (const name of ['OFF', 'AUTO', 'FIXED']) {
		stretch.wasm._reset();
		const [y] = stretch.render([x], () => variants[name](k), 1024);
		const shift = centroid(y) - base;
		const ratio = 1 - shift / calib;
		cells.push({ name, shift, ratio });
		writeWav(`spike/out/${k >= 0 ? '+' : ''}${k}_${name}.wav`, [y], sr);
	}
	rows.push({ k, calib, cells });
	const fmt = c => `${c.shift >= 0 ? '+' : ''}${c.shift.toFixed(2)} (保留 ${(c.ratio * 100).toFixed(0)}%)`;
	console.log(
		String(k >= 0 ? '+' + k : k).padStart(4) + '  ' +
		(calib >= 0 ? '+' : '') + calib.toFixed(2).padEnd(8) + '  ' +
		fmt(cells[0]).padEnd(15) + fmt(cells[1]).padEnd(19) + fmt(cells[2])
	);
}

writeWav('spike/out/original.wav', [x], sr);
console.log();
const avg = i => rows.reduce((s, r) => s + r.cells[i].ratio, 0) / rows.length;
console.log(`平均保留率： OFF ${(avg(0) * 100).toFixed(0)}%   AUTO ${(avg(1) * 100).toFixed(0)}%   FIXED ${(avg(2) * 100).toFixed(0)}%`);
console.log('\n試聽檔已寫到 spike/out/');
