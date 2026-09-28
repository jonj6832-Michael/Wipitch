// 定版比較：用「我們真的會用到的模式」來評估。
//
// 重點前提：時變音高曲線在 Rubber Band 只能用 realtime 模式
// （離線模式的 pitch scale 整段固定，這也是 pitchmark.py 用 --pitchmap 的原因）。
// 所以 realtime 才是有意義的數字，離線只列作參考上限。
//
// 一律只分析中間 4 秒，避開 start delay 與收尾造成的偏差。
import { readWav } from './wav.mjs';
import { loadWasm, OfflineStretch } from './stretch-node.mjs';
import { loadRubberBand, rbPitchShift } from './rubberband-node.mjs';
import { averageSpectrum, spectralEnvelope, envelopeCentroidSemitones } from './spectrum.mjs';

const FFT = 4096, START = 45, DUR = 8;
const w = readWav('Vocal.wav'); const sr = w.sampleRate;
const x = w.channels[0].subarray(START * sr, (START + DUR) * sr);
const mid = s => s.subarray(2 * sr, 6 * sr);
const centroid = s => envelopeCentroidSemitones(spectralEnvelope(averageSpectrum(mid(s), FFT), 80), sr, FFT);
const base = centroid(x);

const wasm = await loadWasm(sr);
const ss = new OfflineStretch(wasm, sr, 1);
const api = await loadRubberBand();

const engines = [
	['Signalsmith', k => { ss.wasm._reset(); return ss.render([x], () => ({ semitones: k, formantCompensation: true, formantBaseHz: 0 }), 1024)[0]; }],
	['RB 即時(會用這個)', k => rbPitchShift(api, [x], sr, k, true, true)[0]],
	['RB 離線(參考上限)', k => rbPitchShift(api, [x], sr, k, true, false)[0]],
];

const ks = [0, -7, -5, -2, 2, 5, 7];
const err = engines.map(() => 0), time = engines.map(() => 0);

// 直接看「formant 偏掉幾個半音」的絕對值，不再換算成百分比。
//
// 原本的百分比要拿「單純改變播放速度」當校準基準，但改變速度會同時改變時間軸，
// 取中間 4 秒時抓到的根本是不同段素材，校準就壞了。絕對誤差沒有這個問題，
// 而且更好解讀：0 = formant 完全沒動（完美保留），數字等於偏了幾個半音。
// k=0 那一列是對照組，三個引擎都該接近 0，否則就是量測本身有問題。
console.log('formant 偏移量（半音）。0 = 完美保留音色；數字越大 = 音色被移動越多\n');
console.log('半音  ' + engines.map(e => e[0].padEnd(20)).join(''));
console.log('────  ' + engines.map(() => '────────────────────').join(''));
for (const k of ks) {
	const cells = engines.map(([, run], i) => {
		const t0 = Date.now();
		const shift = centroid(run(k)) - base;
		time[i] += Date.now() - t0;
		if (k !== 0) err[i] += Math.abs(shift);
		return `${shift >= 0 ? '+' : ''}${shift.toFixed(2)}`.padEnd(20);
	});
	console.log((k === 0 ? '對照' : String(k >= 0 ? '+' + k : k)).padStart(4) + '  ' + cells.join(''));
}
console.log('────  ' + engines.map(() => '────────────────────').join(''));
console.log('平均誤差  ' + err.map(e => `${(e / (ks.length - 1)).toFixed(2)}`.padEnd(20)).join(''));
console.log('速度      ' + time.map(t => `${(DUR * ks.length / (t / 1000)).toFixed(0)}x 即時`.padEnd(20)).join(''));
