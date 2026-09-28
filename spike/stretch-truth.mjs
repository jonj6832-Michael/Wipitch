// Time stretch 的數值驗收（納入 npm run verify）。
//
// 直接量 rbcore 算出來的聲音，不看介面：
//   1. 時間對應：短音包在輸出裡的位置落在 srcToOut 上，輸出長度正確
//   2. 錨點全部落在原位（等同沒有伸縮）時，輸出逐 sample 等於沒有錨點
//   3. 伸縮下音高自動化的延遲補償仍然對齊（深度不掉）
//   4. 伸縮下 formant 自動化的延遲補償仍然對齊
//   5. 從伸縮段中間開始的局部算繪，回到 1× 之後與整段算繪只差很小的時間偏移
//
// 用法：node --experimental-strip-types --import ./tools/ts-resolve.mjs spike/stretch-truth.mjs
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { TimeMap } from '../src/model/timemap.ts';

const sr = 48000, HOP_SEC = 256 / 16000, DUR = 6;
const api = await loadRubberBand();
const frames = Math.ceil(DUR / HOP_SEC) + 2;
const zero = new Float32Array(frames);
const n = sr * DUR;

let fails = 0;
const check = (name, pass, detail = '') => {
	if (!pass) fails++;
	console.log(`${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
};
const mk = pairs => pairs.map(([src, out]) => ({ src, out }));
const mapOf = anchors => new TimeMap(anchors.map((a, i) => ({ id: i + 1, ...a })));
// STRETCH_LAG=-0.035 覆寫 rbcore 的伸縮補償值（調參用）；ONLY=1,5 只跑指定部分
const lagOpt = process.env.STRETCH_LAG !== undefined ? { stretchLagSec: Number(process.env.STRETCH_LAG) } : {};
if (lagOpt.stretchLagSec !== undefined) console.log(`（伸縮補償值覆寫為 ${lagOpt.stretchLagSec * 1000}ms）`);
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(Number)) : null;
const part = k => !only || only.has(k);

// ── 1. 時間對應 ──────────────────────────────────────────────────────────
const clicks = new Float32Array(n), clickTimes = [];
for (let t = 0.125; t < DUR - 0.2; t += 0.25) {
	clickTimes.push(t);
	const i0 = Math.round(t * sr);
	for (let i = 0; i < sr * 0.005; i++) clicks[i0 + i] = 0.6 * Math.sin(2 * Math.PI * 2000 * i / sr) * Math.sin(Math.PI * i / (sr * 0.005));
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
			if (!out.length || t - out[out.length - 1] > 0.02) out.push(t);
		}
	}
	return out;
}
// 量法本身在 1× 時就有約 +2.5ms 的偏差（能量重心 vs 音包起點），門檻以此為中心
for (const [name, anchors] of part(1) ? [
	['1~2s 拉長 2×', mk([[1, 1], [2, 3]])],
	['1~3s 壓成 0.5×', mk([[1, 1], [3, 2]])],
	['1~3s 拉長 1.5×、3~4s 壓成 0.5×', mk([[1, 1], [3, 4], [4, 4.5]])],
] : []) {
	const map = mapOf(anchors);
	const [y] = renderWithCurve(api, { channels: [clicks], sampleRate: sr, delta: zero, gainDb: zero, hopSec: HOP_SEC, anchors, ...lagOpt });
	const found = findClicks(y);
	const errs = clickTimes.map(t => {
		const want = map.srcToOut(t);
		return (found.reduce((b, x) => (Math.abs(x - want) < Math.abs(b - want) ? x : b), Infinity) - want) * 1000;
	});
	const lenOk = y.length === Math.round(map.srcToOut(DUR) * sr);
	check(`時間對應：${name}`, lenOk && Math.min(...errs) > -5 && Math.max(...errs) < 7,
		`脈衝誤差 ${Math.min(...errs).toFixed(1)} ~ ${Math.max(...errs).toFixed(1)}ms、長度${lenOk ? '正確' : '錯誤'}`);
}

// ── 2. 錨點都在原位 = 沒有伸縮 ─────────────────────────────────────────────
const tone = new Float32Array(n);
{
	let ph = 0;
	for (let i = 0; i < n; i++) { ph += 2 * Math.PI * (220 + 30 * Math.sin(2 * Math.PI * 0.7 * i / sr)) / sr; tone[i] = 0.3 * Math.sin(ph) + 0.1 * Math.sin(3 * ph); }
}
if (part(2)) {
	const base = { channels: [tone], sampleRate: sr, delta: zero, gainDb: zero, hopSec: HOP_SEC };
	const [a] = renderWithCurve(api, base);
	const [b] = renderWithCurve(api, { ...base, anchors: mk([[1, 1], [2.5, 2.5]]) });
	let same = a.length === b.length;
	for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
	check('錨點都在原位時，輸出逐 sample 等於沒有錨點', same);
}

// ── 3. 音高自動化延遲 ──────────────────────────────────────────────────────
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
function lockIn(track, hz) {
	let re = 0, im = 0;
	for (const { t, s } of track) { re += s * Math.cos(2 * Math.PI * hz * t); im += s * Math.sin(2 * Math.PI * hz * t); }
	re = 2 * re / track.length; im = 2 * im / track.length;
	let phase = Math.atan2(-re, im);
	while (phase > Math.PI) phase -= 2 * Math.PI;
	while (phase <= -Math.PI) phase += 2 * Math.PI;
	return { depth: Math.hypot(re, im), lagMs: phase / (2 * Math.PI * hz) * 1000 };
}
/** 音高軌，時間戳換算回原始時間（整段固定倍率時 = 輸出時間 / 倍率） */
function pitchTrack(x, scale) {
	const N = 1024, hop = 128, out = [];
	const lo = Math.floor(sr / (F0 * 2 ** (6 / 12))), hi = Math.ceil(sr / (F0 * 2 ** (-6 / 12)));
	for (let off = sr * 1.0; off + N + hi < x.length - sr * 1.0; off += hop) {
		const cc = l => { let s = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { s += x[off + i] * x[off + i + l]; a += x[off + i] ** 2; b += x[off + i + l] ** 2; } return s / Math.sqrt(a * b + 1e-20); };
		let best = -2, bl = 0;
		for (let l = lo; l <= hi; l++) { const c = cc(l); if (c > best) { best = c; bl = l; } }
		if (!bl) continue;
		const ym = cc(Math.max(lo, bl - 1)), yp = cc(Math.min(hi, bl + 1)), d = ym - 2 * best + yp;
		const lag = bl + (d ? Math.max(-1, Math.min(1, .5 * (ym - yp) / d)) : 0);
		out.push({ t: (off + N / 2) / sr / scale, s: 12 * Math.log2((sr / lag) / F0) });
	}
	return out;
}
const hz = 2;
const delta = new Float32Array(frames);
for (let i = 0; i < frames; i++) delta[i] = 2 * Math.sin(2 * Math.PI * hz * i * HOP_SEC);
for (const [label, anchors, scale] of part(3) ? [['2×', mk([[DUR, DUR * 2]]), 2], ['0.5×', mk([[DUR, DUR / 2]]), 0.5]] : []) {
	const [y] = renderWithCurve(api, { channels: [vowel], sampleRate: sr, delta, gainDb: zero, hopSec: HOP_SEC, anchors });
	const r = lockIn(pitchTrack(y, scale), hz);
	check(`音高自動化在 ${label} 伸縮下仍對齊`, Math.abs(r.lagMs) < 5 && r.depth > 1.8,
		`延遲 ${r.lagMs.toFixed(1)}ms（原始時間）、深度 ${r.depth.toFixed(2)}（目標 2.00）`);
}

// ── 4. formant 自動化延遲 ─────────────────────────────────────────────────
function centroidTrack(x, scale) {
	const N = 2048, hop = 512, out = [];
	const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
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
		if (sm > 0) out.push({ t: (off + N / 2) / sr / scale, s: 12 * (sw / sm) });
	}
	const med = out.map(o => o.s).sort((a, b) => a - b)[out.length >> 1];
	for (const o of out) o.s -= med;
	return out;
}
if (part(4)) {
	const formant = new Float32Array(frames);
	for (let i = 0; i < frames; i++) formant[i] = 3 * Math.sin(2 * Math.PI * hz * i * HOP_SEC);
	const [y] = renderWithCurve(api, { channels: [vowel], sampleRate: sr, delta: zero, gainDb: zero, formant, hopSec: HOP_SEC, anchors: mk([[DUR, DUR * 2]]) });
	const r = lockIn(centroidTrack(y, 2), hz);
	check('formant 自動化在 2× 伸縮下仍對齊', Math.abs(r.lagMs) < 8, `延遲 ${r.lagMs.toFixed(1)}ms（原始時間）、深度 ${r.depth.toFixed(2)}`);
}

// ── 5. 背景精算的前提：接縫放在無聲處 ─────────────────────────────────────
//
// 從不同位置開始算，經過伸縮段之後的輸出就不會逐 sample 相同（連整體時間都會差幾毫秒，
// 實測從伸縮段之前的 1× 區域開始算，差異仍達峰值的 140% 以上）。所以背景精算不追求
// 「跟別次算繪一樣」，而是讓接縫落在無聲處：那裡新舊內容差多少都聽不到。
//
// 這個做法成立的前提是：伸縮之後，原本無聲的間隙中間仍然夠安靜——相位聲碼器的尾音
// 不會拖進去。用「音包 + 無聲間隙」量間隙中間（交叉淡化那 25ms）的音量。
if (part(5)) {
	// 0.4s 的音包、間隙長度從 60ms 到 300ms（背景精算要求的最短無聲是 48ms）
	const gaps = [0.06, 0.1, 0.2, 0.3];
	const bursts = new Float32Array(n);
	const gapCenters = [];
	{
		let t = 0.3, ph = 0, k = 0;
		while (t + 0.4 < DUR - 0.5) {
			const i0 = Math.round(t * sr), i1 = Math.round((t + 0.4) * sr);
			for (let i = i0; i < i1; i++) {
				ph += 2 * Math.PI * 220 / sr;
				const env = Math.min(1, (i - i0) / 480, (i1 - i) / 480);   // 10ms 的起落，避免喀聲本身
				bursts[i] = env * (0.3 * Math.sin(ph) + 0.1 * Math.sin(3 * ph));
			}
			const gap = gaps[k++ % gaps.length];
			gapCenters.push({ t: t + 0.4 + gap / 2, gap });
			t += 0.4 + gap;
		}
	}
	for (const [name, anchors] of [
		['整段 2×', mk([[DUR, DUR * 2]])],
		['整段 0.5×', mk([[DUR, DUR / 2]])],
		['整段 3×', mk([[DUR, DUR * 3]])],
	]) {
		const map = mapOf(anchors);
		const [y] = renderWithCurve(api, { channels: [bursts], sampleRate: sr, delta: zero, gainDb: zero, hopSec: HOP_SEC, anchors, ...lagOpt });
		let peakRms = 0;
		{
			const w = Math.round(0.016 * sr);
			for (let i = 0; i + w < y.length; i += w) { let s = 0; for (let j = 0; j < w; j++) s += y[i + j] ** 2; peakRms = Math.max(peakRms, Math.sqrt(s / w)); }
		}
		const byGap = new Map();
		// 背景精算只會把接縫放在「輸出上至少 48ms」的無聲裡（renderer.ts 的 SILENCE_MIN_SEC），
		// 壓縮後比這短的間隙不會被選為接縫，不必檢查
		for (const { t, gap } of gapCenters.filter(g => g.gap * map.ratioAt(g.t) >= 0.048)) {
			const c = Math.round(map.srcToOut(t) * sr), half = Math.round(0.0125 * sr);
			let s = 0;
			for (let i = c - half; i < c + half; i++) s += (y[i] ?? 0) ** 2;
			const db = 20 * Math.log10(Math.sqrt(s / (2 * half)) / peakRms + 1e-12);
			byGap.set(gap, Math.max(byGap.get(gap) ?? -Infinity, db));
		}
		const worst = Math.max(...byGap.values());
		check(`伸縮後無聲間隙的中間仍然夠安靜（< −40dB）：${name}`, worst < -40,
			[...byGap].map(([g, db]) => `間隙 ${g * 1000}ms → ${db.toFixed(0)}dB`).join('、'));
	}
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
