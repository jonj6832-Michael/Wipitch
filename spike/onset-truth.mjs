// 起音處的音高過渡：「沒音高 → 有音高」那一瞬間到底有沒有被移調？
//
// 使用者回報：把一段調得很高時，起音那 ~10ms 聽起來像沒被調到。
// 素材是合成的（靜音 → 子音雜訊 → 母音），起音時間與真實音高完全已知。
// 跑產品的 renderWithCurve，量輸出起音後每 1ms 的 f0 相對目標差幾 cents。
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve, RB_OPTIONS } from '../src/engine/rbcore.ts';
import { CURVE_HOP_SEC } from '../src/model/curves.ts';
import { synthVowel, VOWEL_A } from './synth.mjs';

const sr = 48000, F0 = 220;
const ONSET = 0.5, CONS = 0.03, DUR = 1.2;

function makeSource(consonant) {
	const n = Math.round(DUR * sr), x = new Float32Array(n);
	const v = synthVowel(sr, DUR - ONSET, F0, VOWEL_A);
	const a = Math.round(ONSET * sr), atk = Math.round(0.005 * sr);
	for (let i = 0; i < v.length && a + i < n; i++) x[a + i] = v[i] * Math.min(1, i / atk);
	if (consonant) {
		// 起音前 30ms 的高頻雜訊（像 s / t 的子音）
		let s = 12345, y1 = 0;
		for (let i = a - Math.round(CONS * sr); i < a; i++) {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			const r = s / 0x7fffffff - 0.5, y = r - y1; y1 = r;
			x[i] = y * 0.15;
		}
	}
	return x;
}

/** 起音後 [0, 120ms) 每 1ms 的 f0 誤差（cents，相對 target Hz）。自相關，窗長 12ms。 */
function f0Error(y, targetHz) {
	const N = Math.round(0.012 * sr), out = [];
	const lo = Math.floor(sr / (targetHz * 1.6)), hi = Math.ceil(sr / (targetHz / 1.6));
	for (let ms = 0; ms < 120; ms++) {
		const off = Math.round((ONSET + ms / 1000) * sr);
		let best = -2, bl = 0;
		const cc = l => { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i < N; i++) { s += y[off + i] * y[off + i + l]; e1 += y[off + i] ** 2; e2 += y[off + i + l] ** 2; } return s / Math.sqrt(e1 * e2 + 1e-20); };
		for (let l = lo; l <= hi; l++) { const c = cc(l); if (c > best) { best = c; bl = l; } }
		const ym = cc(bl - 1), yp = cc(bl + 1), d = ym - 2 * best + yp;
		const lag = bl + (d ? Math.max(-1, Math.min(1, 0.5 * (ym - yp) / d)) : 0);
		out.push(1200 * Math.log2(sr / lag / targetHz));
	}
	return out;
}

function summarise(err) {
	const abs = err.map(Math.abs);
	let settle = 0;
	for (let i = abs.length - 1; i >= 0; i--) if (abs[i] > 25) { settle = i + 1; break; }
	const mean = (a, b) => abs.slice(a, b).reduce((s, v) => s + v, 0) / (b - a);
	return { settle, first20: mean(0, 20), first50: mean(0, 50), late: mean(60, 120) };
}

const api = await loadRubberBand();
const frames = Math.ceil(DUR / CURVE_HOP_SEC) + 2;
const curveConst = v => new Float32Array(frames).fill(v);
/** 起音前是 0、起音處（或更早 lead 秒）跳到 v 的階梯——畫筆跳過未發聲格子時留下的形狀 */
const curveStep = (v, lead) => { const c = new Float32Array(frames); c.fill(v, Math.round((ONSET - lead) / CURVE_HOP_SEC)); return c; };

const rows = [];
/** 量輸出相對「原始 f0 × 2^(k/12)」的誤差：真實素材沒有已知音高，用原始素材本身當尺規 */
function f0Track(y, at, approxHz) {
	const N = Math.round(0.012 * sr), out = [];
	const lo = Math.floor(sr / (approxHz * 2)), hi = Math.ceil(sr / (approxHz / 2));
	for (let ms = 0; ms < 120; ms++) {
		const off = Math.round((at + ms / 1000) * sr);
		let best = -2, bl = lo;
		const cc = l => { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i < N; i++) { s += y[off + i] * y[off + i + l]; e1 += y[off + i] ** 2; e2 += y[off + i + l] ** 2; } return s / Math.sqrt(e1 * e2 + 1e-20); };
		for (let l = lo; l <= hi; l++) { const c = cc(l); if (c > best) { best = c; bl = l; } }
		out.push({ hz: sr / bl, c: best });
	}
	return out;
}
function run(label, src, delta, semis, extra = {}) {
	const [y] = renderWithCurve(api, {
		channels: [src], sampleRate: sr, delta, gainDb: curveConst(0), hopSec: CURVE_HOP_SEC, ...extra,
	});
	const s = summarise(f0Error(y, F0 * 2 ** (semis / 12)));
	rows.push({ label, ...s });
}

for (const cons of [false, true]) {
	const src = makeSource(cons);
	const tag = cons ? '子音+母音' : '母音    ';
	// 對照：沒移調時量法本身在起音的誤差
	run(`${tag} Δ=0 對照`, src, curveConst(0), 0);
	for (const k of [7, 12]) {
		run(`${tag} Δ=+${k} 常數`, src, curveConst(k), k);
		run(`${tag} Δ=+${k} 階梯@起音`, src, curveStep(k, 0), k);
		run(`${tag} Δ=+${k} 階梯@−30ms`, src, curveStep(k, 0.03), k);
		run(`${tag} Δ=+${k} 階梯@+20ms`, src, curveStep(k, -0.02), k);
		for (const b of [512, 256]) run(`${tag} Δ=+${k} 常數 block ${b}`, src, curveConst(k), k, { blockSamples: b });
		run(`${tag} Δ=+${k} 常數 WindowShort`, src, curveConst(k), k, { options: RB_OPTIONS | 1048576 });
	}
}

console.log('起音後 f0 誤差（cents）。settle = 最後一次 |誤差| > 25 cents 的 ms\n');
console.log('情況'.padEnd(36) + 'settle   0–20ms   0–50ms   60–120ms');
for (const r of rows) {
	console.log(r.label.padEnd(36) + `${String(r.settle).padStart(4)}ms ${r.first20.toFixed(0).padStart(7)} ${r.first50.toFixed(0).padStart(8)} ${r.late.toFixed(0).padStart(9)}`);
}

// ── 真實素材：Vocal.wav 裡從無聲進入發聲的地方 ──
import fs from 'node:fs';
if (fs.existsSync('Vocal.wav')) {
	const { readWav } = await import('./wav.mjs');
	const w = readWav('Vocal.wav');
	const x = w.channels[0];
	const hop = Math.round(0.01 * sr);
	const rms = i => { let s = 0; for (let j = i; j < i + hop; j++) s += x[j] * x[j]; return Math.sqrt(s / hop); };
	let peak = 0; for (let i = 0; i + hop < x.length; i += hop) peak = Math.max(peak, rms(i));
	// 至少 150ms 很小聲、接著 100ms 以上夠大聲 = 一個起音
	const onsets = [];
	let quiet = 0;
	for (let i = 0; i + hop * 12 < x.length; i += hop) {
		const r = rms(i);
		if (r < peak * 0.01) { quiet++; continue; }
		if (quiet >= 15 && r > peak * 0.05) onsets.push(i / sr);
		quiet = 0;
	}
	console.log(`\nVocal.wav：找到 ${onsets.length} 個起音，取前 12 個。Δ=+7 常數，量起音後的 f0 相對原始 f0 × 2^(7/12)`);
	console.log('起音秒數   0–20ms 誤差   20–50ms 誤差   60–120ms 誤差（cents，只算有週期性的 ms）');
	const agg = [[], [], []];
	for (const t0 of onsets.slice(0, 12)) {
		const a = Math.round((t0 - 0.6) * sr), b = Math.round((t0 + 0.4) * sr);
		const seg = x.slice(a, b);
		const n = Math.ceil(1 / CURVE_HOP_SEC) + 10;
		const [y] = renderWithCurve(api, { channels: [seg], sampleRate: sr, delta: new Float32Array(n).fill(7), gainDb: new Float32Array(n), hopSec: CURVE_HOP_SEC });
		const ref = f0Track(seg, 0.6, 350), out = f0Track(y, 0.6, 350 * 1.5);
		const bucket = (p, q) => {
			const v = [];
			for (let i = p; i < q; i++) if (ref[i].c > 0.8 && out[i].c > 0.5) {
				let e = 1200 * Math.log2(out[i].hz / (ref[i].hz * 2 ** (7 / 12)));
				e -= 1200 * Math.round(e / 1200);   // 八度錯誤不算
				v.push(Math.abs(e));
			}
			return v;
		};
		const bs = [bucket(0, 20), bucket(20, 50), bucket(60, 120)];
		bs.forEach((v, k) => agg[k].push(...v));
		const f = v => v.length ? (v.reduce((s, e) => s + e, 0) / v.length).toFixed(0).padStart(5) + ` (${v.length})` : '    —';
		console.log(`${t0.toFixed(2).padStart(7)}s  ${f(bs[0]).padStart(12)}  ${f(bs[1]).padStart(13)}  ${f(bs[2]).padStart(13)}`);
	}
	const m = v => (v.reduce((s, e) => s + e, 0) / Math.max(1, v.length)).toFixed(1);
	console.log(`平均       ${m(agg[0]).padStart(8)}      ${m(agg[1]).padStart(9)}      ${m(agg[2]).padStart(9)}`);
}
