// 驗證「包絡位移」這個指標可不可信。
// 手法：單純改變播放速度（線性內插重取樣）會讓泛音和包絡「一起」移動確切的 k 半音，
// 這是完美的 ground truth。如果工具量出來就是 k，代表指標可信。
import { readWav } from './wav.mjs';
import { averageSpectrum, spectralEnvelope, envelopeShiftSemitones } from './spectrum.mjs';

const FFT = 4096;
const w = readWav('Vocal.wav');
const sr = w.sampleRate;
const x = w.channels[0].subarray(45 * sr, 53 * sr);

function resample(src, ratio) {   // ratio>1 = 播快 = 音高變高
	const n = Math.floor(src.length / ratio);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const p = i * ratio, j = Math.floor(p), f = p - j;
		out[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f;
	}
	return out;
}

const envRef = spectralEnvelope(averageSpectrum(x, FFT));
console.log('ground truth 測試（改變播放速度，泛音與包絡一起移動）');
console.log('  預期        量到        相關係數');
for (const k of [-7, -5, -2, 0, 2, 5, 7]) {
	const y = resample(x, Math.pow(2, k / 12));
	const env = spectralEnvelope(averageSpectrum(y, FFT));
	const r = envelopeShiftSemitones(envRef, env, sr, FFT);
	const err = r.semitones - k;
	console.log(`  ${String(k.toFixed(1)).padStart(6)}   ${String(r.semitones.toFixed(2)).padStart(8)}   ${r.correlation.toFixed(4)}   誤差 ${err >= 0 ? '+' : ''}${err.toFixed(2)}`);
}
