// 音量自動化的時間對準：輸出的音量變化跟 gainDb 曲線差幾毫秒？
//
// 合成母音（音高固定、不移調），音量曲線是 ±6dB 的正弦。量輸出 RMS（dB）
// 與曲線的互相關，找最佳對齊的延遲。正值 = 輸出比曲線晚。
// RBCORE 環境變數可以指定另一份 rbcore（用來對照修正前的版本）。
import { loadRubberBand } from './rubberband-node.mjs';
import { CURVE_HOP_SEC } from '../src/model/curves.ts';
import { synthVowel, VOWEL_A } from './synth.mjs';

const { renderWithCurve } = await import(process.env.RBCORE ?? '../src/engine/rbcore.ts');
const sr = 48000, DUR = 4;
const src = synthVowel(sr, DUR, 220, VOWEL_A);
const frames = Math.ceil(DUR / CURVE_HOP_SEC) + 2;
const api = await loadRubberBand();

let failed = 0;
for (const hz of [1, 2, 4]) {
	const gain = new Float32Array(frames).map((_, i) => 6 * Math.sin(2 * Math.PI * hz * i * CURVE_HOP_SEC));
	for (const semis of [0, 7]) {
		const [y] = renderWithCurve(api, {
			channels: [src], sampleRate: sr, delta: new Float32Array(frames).fill(semis), gainDb: gain, hopSec: CURVE_HOP_SEC,
		});
		// 輸出每 1ms 的 RMS（10ms 窗），換成 dB 後除掉「沒改音量」的基準
		const [ref] = renderWithCurve(api, {
			channels: [src], sampleRate: sr, delta: new Float32Array(frames).fill(semis), gainDb: new Float32Array(frames), hopSec: CURVE_HOP_SEC,
		});
		const win = Math.round(0.01 * sr), env = [];
		for (let ms = 500; ms < (DUR - 0.5) * 1000; ms++) {
			const o = Math.round(ms / 1000 * sr);
			let a = 0, b = 0;
			for (let i = o - win / 2; i < o + win / 2; i++) { a += y[i] * y[i]; b += ref[i] * ref[i]; }
			env.push({ t: ms / 1000, db: 10 * Math.log10((a + 1e-20) / (b + 1e-20)) });
		}
		let best = { lag: 0, err: Infinity };
		for (let lagMs = -150; lagMs <= 150; lagMs++) {
			let e = 0;
			for (const { t, db } of env) e += (db - 6 * Math.sin(2 * Math.PI * hz * (t - lagMs / 1000))) ** 2;
			if (e < best.err) best = { lag: lagMs, err: e };
		}
		const rmsErr = Math.sqrt(best.err / env.length);
		const ok = Math.abs(best.lag) <= 2;
		if (!ok) failed++;
		console.log(`${ok ? '✅' : '❌'} ${hz}Hz 音量正弦、移調 ${semis}：輸出比曲線 ${best.lag >= 0 ? '晚' : '早'} ${Math.abs(best.lag)}ms（對齊後殘差 ${rmsErr.toFixed(2)} dB）`);
	}
}
process.exit(failed ? 1 : 0);
