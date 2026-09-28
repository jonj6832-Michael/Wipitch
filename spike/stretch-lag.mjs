// Time stretch 下的時間精度與自動化延遲。
//
// 1. 時間對應：短音包在輸出裡的位置是否落在 srcToOut（有/沒有 30ms 補償）
// 2. 局部算繪（從中途開始 + 暖機）與整段算繪的同一段是否一致
// 3. 音高自動化延遲（85ms）在 2× 伸縮下是輸入時間還是輸出時間的常數
//
// 用法：node --experimental-strip-types --import ./tools/ts-resolve.mjs spike/stretch-lag.mjs
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { TimeMap } from '../src/model/timemap.ts';

const sr = 48000, HOP_SEC = 256 / 16000, DUR = 6;
const api = await loadRubberBand();
const frames = Math.ceil(DUR / HOP_SEC) + 2;
const zero = new Float32Array(frames);

// ── 1. 時間對應 ──────────────────────────────────────────────────────────
const n = sr * DUR;
const clicksSrc = new Float32Array(n);
const clickTimes = [];
for (let t = 0.125; t < DUR - 0.2; t += 0.25) {
	clickTimes.push(t);
	const i0 = Math.round(t * sr);
	for (let i = 0; i < sr * 0.005; i++) clicksSrc[i0 + i] = 0.6 * Math.sin(2 * Math.PI * 2000 * i / sr) * Math.sin(Math.PI * i / (sr * 0.005));
}

function findClicks(x) {
	const win = Math.round(sr * 0.004), env = new Float32Array(Math.floor(x.length / win));
	for (let k = 0; k < env.length; k++) { let s = 0; for (let i = 0; i < win; i++) s += x[k * win + i] ** 2; env[k] = s; }
	const peak = Math.max(...env), out = [];
	for (let k = 1; k < env.length - 1; k++) {
		if (env[k] > peak * 0.05 && env[k] >= env[k - 1] && env[k] > env[k + 1]) {
			let sw = 0, sm = 0;
			for (let j = Math.max(0, k - 3); j <= Math.min(env.length - 1, k + 3); j++) { sw += j * env[j]; sm += env[j]; }
			const t = (sw / sm + 0.5) * win / sr;
			// 壓成 0.25× 時脈衝間隔只剩 62ms，合併門檻太寬會把相鄰兩個當成一個
			if (!out.length || t - out[out.length - 1] > 0.02) out.push(t);
		}
	}
	return out;
}

/** 做一組錨點：[src, out] 對 */
const mk = pairs => pairs.map(([src, out]) => ({ src, out }));
const cases = [
	{ name: '沒有錨點', anchors: [] },
	{ name: '1~2s 拉成 2×', anchors: mk([[1, 1], [2, 3]]) },
	{ name: '1~3s 壓成 0.5×', anchors: mk([[1, 1], [3, 2]]) },
	{ name: '兩段：1~2 為 3×、2~4 為 0.25×', anchors: mk([[1, 1], [2, 4], [4, 4.5]]) },
];

// ONLY=1,2 只跑指定的部分（量測很慢）
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(Number)) : null;
const part = k => !only || only.has(k);
const LAGS = process.env.LAGS ? process.env.LAGS.split(',').map(Number) : [0, -0.030];

if (part(1)) console.log('1. 時間對應（脈衝位置誤差 ms；個位數的正偏移是量法本身的偏差，1× 時也有）');
for (const c of part(1) ? cases : []) {
	const map = new TimeMap(c.anchors.map((a, i) => ({ id: i + 1, ...a })));
	const row = [];
	for (const lag of LAGS) {
		const [y] = renderWithCurve(api, {
			channels: [clicksSrc], sampleRate: sr, delta: zero, gainDb: zero, hopSec: HOP_SEC,
			anchors: c.anchors, stretchLagSec: lag,
		});
		const found = findClicks(y);
		const errs = clickTimes.map(t => {
			const want = map.srcToOut(t);
			const got = found.reduce((b, x) => (Math.abs(x - want) < Math.abs(b - want) ? x : b), Infinity);
			return (got - want) * 1000;
		});
		const expectLen = Math.round(map.srcToOut(DUR) * sr);
		row.push(`${(lag * 1000).toFixed(0)}ms：${Math.min(...errs).toFixed(1)}~${Math.max(...errs).toFixed(1)}${y.length === expectLen ? '' : `（長度 ${y.length}≠${expectLen}）`}`);
	}
	console.log(`  ${c.name.padEnd(24)} ${row.join('　')}`);
}

// 誤差隨時間的分布，看是「進入段落時」還是「離開段落時」歪掉
if (process.env.DETAIL) {
	const lag = Number(process.env.DETAIL);
	for (const c of cases.slice(1)) {
		const map = new TimeMap(c.anchors.map((a, i) => ({ id: i + 1, ...a })));
		const [y] = renderWithCurve(api, { channels: [clicksSrc], sampleRate: sr, delta: zero, gainDb: zero, hopSec: HOP_SEC, anchors: c.anchors, stretchLagSec: lag });
		const found = findClicks(y);
		console.log(`  ${c.name}（${lag * 1000}ms）：` + clickTimes.map(t => {
			const want = map.srcToOut(t);
			const got = found.reduce((b, x) => (Math.abs(x - want) < Math.abs(b - want) ? x : b), Infinity);
			return `${t.toFixed(2)}[${map.ratioAt(t)}]${((got - want) * 1000).toFixed(0)}`;
		}).join(' '));
	}
}

// ── 2. 局部算繪 vs 整段 ─────────────────────────────────────────────────
if (part(2)) console.log('\n2. 局部算繪（從輸出 2.5s 開始、暖機 0.5s）與整段算繪的同一段比較');
const tone = new Float32Array(n);
{
	// 有音高、有起伏的素材，比脈衝更能看出相位聲碼器狀態差異
	let ph = 0;
	for (let i = 0; i < n; i++) { ph += 2 * Math.PI * (220 + 30 * Math.sin(2 * Math.PI * 0.7 * i / sr)) / sr; tone[i] = 0.3 * Math.sin(ph) + 0.1 * Math.sin(3 * ph); }
}
// STRETCH_LAG=-0.035 覆寫 rbcore 的補償值，用來掃「局部 vs 整段」的偏移
const lagOverride = process.env.STRETCH_LAG !== undefined ? { stretchLagSec: Number(process.env.STRETCH_LAG) } : {};
if (part(2) && process.env.STRETCH_LAG !== undefined) console.log(`  （補償值 ${Number(process.env.STRETCH_LAG) * 1000}ms）`);
for (const c of part(2) ? cases : []) {
	const req = { channels: [tone], sampleRate: sr, delta: zero, gainDb: zero, hopSec: HOP_SEC, anchors: c.anchors, ...lagOverride };
	const [full] = renderWithCurve(api, req);
	const from = Math.round(2.5 * sr), to = Math.round(4.5 * sr);
	const [part] = renderWithCurve(api, { ...req, fromSample: from, toSample: to, preRollSamples: Math.round(0.5 * sr) });
	// 前 0.1s 是暖機剛結束的區域，跳過。另外搜尋 ±40ms 內最佳對齊，看是不是只差一個時間偏移
	const corr = off => {
		let dot = 0, a2 = 0, b2 = 0;
		for (let i = Math.round(0.1 * sr); i < part.length - 2000; i++) { const a = part[i], b = full[from + i + off] ?? 0; dot += a * b; a2 += a * a; b2 += b * b; }
		return dot / Math.sqrt(a2 * b2);
	};
	let best = { off: 0, c: -2 };
	for (let off = -1920; off <= 1920; off += 4) { const c = corr(off); if (c > best.c) best = { off, c }; }
	console.log(`  ${c.name.padEnd(24)} 對齊時相關係數 ${corr(0).toFixed(4)}；最佳偏移 ${(best.off / sr * 1000).toFixed(2)}ms 時 ${best.c.toFixed(4)}（長度 ${part.length}/${to - from}）`);

	// 逐窗分析：每 150ms 一窗，看差異在伸縮段內還是延續到後面的 1× 區域
	if (process.env.WINDOWS) {
		const map = new TimeMap(c.anchors.map((a, i) => ({ id: i + 1, ...a })));
		const W = Math.round(0.15 * sr), cells = [];
		for (let w0 = 0; w0 + W <= part.length; w0 += W) {
			const wc = off => {
				let dot = 0, a2 = 0, b2 = 0;
				for (let i = w0; i < w0 + W; i++) { const a = part[i], b = full[from + i + off] ?? 0; dot += a * b; a2 += a * a; b2 += b * b; }
				return dot / Math.sqrt(a2 * b2 + 1e-20);
			};
			let bo = 0, bc = -2;
			for (let off = -480; off <= 480; off += 2) { const cc = wc(off); if (cc > bc) { bc = cc; bo = off; } }
			const tOut = (from + w0 + W / 2) / sr;
			cells.push(`${tOut.toFixed(2)}[${map.ratioAt(map.outToSrc(tOut))}] ${wc(0).toFixed(2)}/${bc.toFixed(2)}@${(bo / sr * 1000).toFixed(1)}`);
		}
		console.log('    輸出時間[倍率] 對齊相關/最佳@偏移ms：\n    ' + cells.join('\n    '));
	}
}

// ── 3. 音高自動化延遲在伸縮下的單位 ────────────────────────────────────────
if (!part(3) && !part(4)) process.exit(0);
console.log('\n3. 音高自動化延遲：整段 2× 伸縮，量到的延遲換算回原始時間');
const F0 = 300;
const vowel = new Float32Array(n);
{
	const p = new Float32Array(n); let g = 0;
	for (let i = 0; i < n; i++) { g += F0 / sr; if (g >= 1) { g -= 1; p[i] = 1; } }
	for (const [hz, bw, gn] of [[700, 90, 1], [1220, 110, .5], [2600, 140, .25]]) {
		const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * hz / sr;
		const a1 = 2 * r * Math.cos(th), a2 = -r * r; let y1 = 0, y2 = 0;
		for (let i = 0; i < n; i++) { const y = p[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; vowel[i] += y * gn; }
	}
	let pk = 0; for (const v of vowel) pk = Math.max(pk, Math.abs(v));
	for (let i = 0; i < n; i++) vowel[i] *= 0.4 / pk;
}
function pitchTrack(x, timeScale) {
	const N = 1024, hop = 128, out = [];
	const lo = Math.floor(sr / (F0 * 2 ** (6 / 12))), hi = Math.ceil(sr / (F0 * 2 ** (-6 / 12)));
	for (let off = sr * 1.0; off + N + hi < x.length - sr * 1.0; off += hop) {
		const cc = l => { let s = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { s += x[off + i] * x[off + i + l]; a += x[off + i] ** 2; b += x[off + i + l] ** 2; } return s / Math.sqrt(a * b + 1e-20); };
		let best = -2, bl = 0;
		for (let l = lo; l <= hi; l++) { const c = cc(l); if (c > best) { best = c; bl = l; } }
		if (!bl) continue;
		const ym = cc(Math.max(lo, bl - 1)), yp = cc(Math.min(hi, bl + 1)), d = ym - 2 * best + yp;
		const lag = bl + (d ? Math.max(-1, Math.min(1, .5 * (ym - yp) / d)) : 0);
		out.push({ t: (off + N / 2) / sr / timeScale, s: 12 * Math.log2((sr / lag) / F0) });
	}
	return out;
}
function lockIn(track, hz) {
	let re = 0, im = 0;
	for (const { t, s } of track) { re += s * Math.cos(2 * Math.PI * hz * t); im += s * Math.sin(2 * Math.PI * hz * t); }
	re = 2 * re / track.length; im = 2 * im / track.length;
	let phase = Math.atan2(-re, im);
	while (phase > Math.PI) phase -= 2 * Math.PI;
	while (phase <= -Math.PI) phase += 2 * Math.PI;
	return { depth: Math.hypot(re, im), lagMs: phase / (2 * Math.PI * hz) * 1000 };
}
const hz = 2;
const delta = new Float32Array(frames);
for (let i = 0; i < frames; i++) delta[i] = 2 * Math.sin(2 * Math.PI * hz * i * HOP_SEC);
// automationLagSec 現在是「1× 時的延遲」，rbcore 依倍率換算；0 = 不補償
const stretchCases = [['1×', [], 1], ['2×', mk([[DUR, DUR * 2]]), 2], ['0.5×', mk([[DUR, DUR / 2]]), 0.5]];
for (const [label, anchors, scale] of stretchCases) {
	const row = [];
	for (const lag of [0, 0.085]) {
		const [y] = renderWithCurve(api, { channels: [vowel], sampleRate: sr, delta, gainDb: zero, hopSec: HOP_SEC, anchors, automationLagSec: lag });
		const r = lockIn(pitchTrack(y, scale), hz);
		row.push(`${lag ? '依倍率補償' : '不補償'} → ${r.lagMs.toFixed(1)}ms（深度 ${r.depth.toFixed(2)}）`);
	}
	console.log(`  ${label.padEnd(5)} ${row.join('　')}`);
}

// ── 4. formant 延遲在伸縮下的拆法 ─────────────────────────────────────────
console.log('\n4. formant 自動化延遲（換算回原始時間）');
function centroidTrack(x, timeScale) {
	const N = 2048, hop = 512, out = [];
	const win = new Float32Array(N);
	for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
	const lo = Math.ceil(400 * N / sr), hi = Math.floor(5000 * N / sr);
	for (let off = sr * 1.0; off + N < x.length - sr * 1.0; off += hop) {
		let sw = 0, sm = 0;
		for (let k = lo; k <= hi; k += 2) {
			let re = 0, im = 0;
			const w = 2 * Math.PI * k / N;
			for (let i = 0; i < N; i += 2) { const v = x[off + i] * win[i]; re += v * Math.cos(w * i); im -= v * Math.sin(w * i); }
			const mag = Math.hypot(re, im);
			sw += mag * Math.log2(k * sr / N); sm += mag;
		}
		if (sm > 0) out.push({ t: (off + N / 2) / sr / timeScale, s: 12 * (sw / sm) });
	}
	const med = out.map(o => o.s).sort((a, b) => a - b)[out.length >> 1];
	for (const o of out) o.s -= med;
	return out;
}
const formant = new Float32Array(frames);
for (let i = 0; i < frames; i++) formant[i] = 3 * Math.sin(2 * Math.PI * hz * i * HOP_SEC);
const fLag = {};
for (const [label, anchors, scale] of stretchCases) {
	const [y] = renderWithCurve(api, { channels: [vowel], sampleRate: sr, delta: zero, gainDb: zero, formant, hopSec: HOP_SEC, anchors, formantLagSec: 0 });
	const r = lockIn(centroidTrack(y, scale), hz);
	fLag[label] = -r.lagMs;
	console.log(`  ${label.padEnd(5)} 不補償 → ${r.lagMs.toFixed(1)}ms（深度 ${r.depth.toFixed(2)}）`);
}
// L(r) = a + b/r：用 1× 與 2× 解出 a、b，0.5× 拿來驗證
const b = 2 * (fLag['1×'] - fLag['2×']), a = fLag['1×'] - b;
console.log(`  擬合：輸入端 ${a.toFixed(1)}ms + 輸出端 ${b.toFixed(1)}ms/r → 輸入端比例 ${(a / (a + b)).toFixed(2)}；0.5× 預測 ${(a + 2 * b).toFixed(1)}ms、實測 ${fLag['0.5×'].toFixed(1)}ms`);
