// 音色保留的驗收：跑真正的產品程式碼（rbcore.renderWithCurve），量實際輸出。
//
// 為什麼需要這一支：加入 formant 曲線的時候，我在「曲線值為 0」的情況下傳了
// set_formant_scale(1.0)，直覺上那是「不動」——實際上它把 FormantPreserved 的
// 自動補償整個關掉，保留率從 0.92 掉到 0.01（= 花栗鼠）。
// 這種錯誤不會當掉、不會有 console 錯誤、曲線也完全正確，只有「聽起來」不對，
// 所以一定要有一支直接量輸出的測試擋著。
//
// 量法：比較移調前後「頻譜包絡重心」移動了幾個半音，用「單純改播放速度」當校準
// 基準（定義上完全沒保留）。保留率 = 1 − 量到的位移 / 校準基準的位移。
import { readWav } from './wav.mjs';
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { averageSpectrum, spectralEnvelope, envelopeCentroidSemitones } from './spectrum.mjs';

const FFT = 4096;
const START = 45, DUR = 8;
const HOP_SEC = 256 / 16000;
const PRESERVE_MIN = 0.80;   // 門檻。實測產品設定是 0.92
const FOLLOW_MAX = 0.15;     // 跟隨比例 1.0 時應該幾乎沒保留

const w = readWav('Vocal.wav');
const sr = w.sampleRate;
const x = w.channels[0].subarray(START * sr, (START + DUR) * sr);

const centroid = sig => envelopeCentroidSemitones(spectralEnvelope(averageSpectrum(sig, FFT), 80), sr, FFT);
const base = centroid(x);

function resample(src, ratio) {
	const n = Math.floor(src.length / ratio), out = new Float32Array(n);
	for (let i = 0; i < n; i++) { const p = i * ratio, j = Math.floor(p), f = p - j; out[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f; }
	return out;
}

const frames = Math.ceil(DUR / HOP_SEC) + 2;
const flat = v => new Float32Array(frames).fill(v);
const api = await loadRubberBand();

/** 跑產品的算繪路徑。semitones 是移調量，formantSemis 是 formant 曲線的值。 */
const render = (semitones, formantSemis, formantFollow) => renderWithCurve(api, {
	channels: [x], sampleRate: sr,
	delta: flat(semitones), gainDb: flat(0), formant: flat(formantSemis), formantFollow,
	hopSec: HOP_SEC,
})[0];

let failed = 0;
const check = (pass, name, detail) => {
	console.log(`${pass ? '✅' : '❌'} ${name}  — ${detail}`);
	if (!pass) failed++;
};

console.log(`素材：Vocal.wav ${START}s ~ ${START + DUR}s（女聲，f0 中位數 361Hz）\n`);
console.log('1) 預設設定（formant 曲線 = 0、跟隨 = 0）應該保留音色');
console.log('   半音   校準基準   量到的位移   保留率');
console.log('   ────  ────────  ──────────  ──────');

const ratios = [];
for (const k of [-5, -2, 2, 5, 7]) {
	const calib = centroid(resample(x, Math.pow(2, k / 12))) - base;
	const shift = centroid(render(k, 0, 0)) - base;
	const ratio = 1 - shift / calib;
	ratios.push(ratio);
	console.log(`   ${String(k).padStart(4)}  ${calib.toFixed(2).padStart(8)}  ${shift.toFixed(2).padStart(10)}  ${ratio.toFixed(2).padStart(6)}`);
}
const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
check(avg > PRESERVE_MIN, '移調時保留音色', `平均保留率 ${avg.toFixed(3)}（門檻 ${PRESERVE_MIN}）`);

// 跟隨比例 1.0 = 刻意讓 formant 跟著移調，也就是花栗鼠。
// 這一項是反向的護欄：如果保留與不保留量起來一樣，代表選項根本沒傳進去。
const followRatios = [];
for (const k of [-5, 5, 7]) {
	const calib = centroid(resample(x, Math.pow(2, k / 12))) - base;
	followRatios.push(1 - (centroid(render(k, 0, 1)) - base) / calib);
}
const followAvg = followRatios.reduce((a, b) => a + b, 0) / followRatios.length;
check(followAvg < FOLLOW_MAX, '跟隨比例 1.0 → 音色完全跟著移調',
	`平均保留率 ${followAvg.toFixed(3)}（門檻 < ${FOLLOW_MAX}，與上面的 ${avg.toFixed(3)} 要有明顯差距）`);

// formant 曲線本身：不移調、只把 formant 推 −4 半音，包絡就該往下 4 個半音
{
	const want = centroid(resample(x, Math.pow(2, -4 / 12))) - base;
	const got = centroid(render(0, -4, 0)) - base;
	check(Math.abs(got - want) < 0.6, 'formant 曲線 −4 半音（不移調）',
		`包絡重心 ${got.toFixed(2)}，目標 ${want.toFixed(2)}（誤差 ${(got - want).toFixed(2)} 半音）`);
}

// formant 曲線與移調並存：+7 半音移調 + formant −4，包絡要落在 −4 而不是 +3
{
	const want = centroid(resample(x, Math.pow(2, -4 / 12))) - base;
	const got = centroid(render(7, -4, 0)) - base;
	check(Math.abs(got - want) < 0.6, '移調 +7 的同時 formant −4',
		`包絡重心 ${got.toFixed(2)}，目標 ${want.toFixed(2)}（誤差 ${(got - want).toFixed(2)} 半音）`);
}

console.log(failed ? `\n${failed} 項未通過` : '\n全部通過');
process.exit(failed ? 1 : 0);
