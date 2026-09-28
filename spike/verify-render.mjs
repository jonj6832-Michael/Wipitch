// 驗證 rbcore 的算繪正確性。
//
// 最關鍵的一項是「恆等測試」：Δ 全為 0 的時候，輸出必須跟輸入對齊而且幾乎相同。
// 這條過了，才代表延遲補償是對的；不對的話所有編輯都會整段位移，
// 而且是那種不會報錯、只會聽起來很怪的錯。
import { readWav } from './wav.mjs';
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';

const HOP_SEC = 256 / 16000;
const w = readWav('Vocal.wav');
const sr = w.sampleRate;
const x = w.channels[0].subarray(45 * sr, 53 * sr);
const frames = Math.ceil(x.length / sr / HOP_SEC) + 2;

const api = await loadRubberBand();
const flat = (v) => new Float32Array(frames).fill(v);

function align(a, b, searchFrom, searchTo, maxLag = 3000) {
	let best = { lag: 0, c: -2 };
	for (let lag = -maxLag; lag <= maxLag; lag += 1) {
		let num = 0, da = 0, db = 0;
		for (let i = searchFrom; i < searchTo; i += 3) {
			const p = a[i], q = b[i + lag] || 0;
			num += p * q; da += p * p; db += q * q;
		}
		const c = num / Math.sqrt(da * db + 1e-20);
		if (c > best.c) best = { lag, c };
	}
	return best;
}

console.log('== 恆等測試（Δ = 0，輸出應與輸入相同）==');
let t0 = Date.now();
const [ident] = renderWithCurve(api, {
	channels: [x], sampleRate: sr, delta: flat(0), gainDb: flat(0), hopSec: HOP_SEC,
});
console.log(`  算繪 8 秒耗時 ${Date.now() - t0}ms（${(8 / ((Date.now() - t0) / 1000)).toFixed(1)}x 即時）`);
console.log(`  輸出長度 ${ident.length}（輸入 ${x.length}）`);
const a = align(x, ident, sr * 2, sr * 5);
console.log(`  最佳對齊 lag = ${a.lag} sample（${(a.lag / sr * 1000).toFixed(2)}ms），相關係數 ${a.c.toFixed(4)}`);

let rmsIn = 0, rmsOut = 0;
for (let i = sr * 2; i < sr * 5; i++) { rmsIn += x[i] * x[i]; rmsOut += ident[i] * ident[i]; }
console.log(`  RMS 輸入 ${Math.sqrt(rmsIn / (sr * 3)).toFixed(4)}  輸出 ${Math.sqrt(rmsOut / (sr * 3)).toFixed(4)}`);

console.log('\n== 分段算繪的接縫測試 ==');
// 從中間算一小段，跟整段算繪的同一位置比對。
// 前導暖機夠長的話，兩者應該幾乎一模一樣。
const [full] = renderWithCurve(api, {
	channels: [x], sampleRate: sr, delta: flat(3), gainDb: flat(0), hopSec: HOP_SEC,
});
for (const preRollMs of [0, 100, 300, 500, 1000]) {
	const from = Math.round(sr * 4), to = Math.round(sr * 5);
	const [part] = renderWithCurve(api, {
		channels: [x], sampleRate: sr, delta: flat(3), gainDb: flat(0), hopSec: HOP_SEC,
		fromSample: from, toSample: to, preRollSamples: Math.round(sr * preRollMs / 1000),
	});
	let num = 0, da = 0, db = 0;
	for (let i = 0; i < part.length; i++) {
		const p = full[from + i], q = part[i];
		num += p * q; da += p * p; db += q * q;
	}
	console.log(`  preRoll ${String(preRollMs).padStart(4)}ms → 與整段算繪的相關係數 ${(num / Math.sqrt(da * db + 1e-20)).toFixed(4)}`);
}
