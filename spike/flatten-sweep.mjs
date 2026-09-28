// 掃描延遲補償值，找出真實素材上能真正抵銷抖音的設定（如果存在的話）。
import { readWav } from './wav.mjs';
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { Curves } from '../src/model/curves.ts';
import { flattenRange } from '../src/model/edits.ts';
import { trackF0 } from './f0track.mjs';

const sr = 48000, HOP_SEC = 256 / 16000;
const AT = 66.4, LEN = 2.4, SEL_FROM = 0.35, SEL_TO = 1.9, VIB_HZ = 5.25;

const w = readWav('Vocal.wav');
const x = w.channels[0].subarray(Math.round(AT * sr), Math.round((AT + LEN) * sr));
const track = trackF0(x, sr, HOP_SEC);
const frames = track.f0.length;
const pitchMidi = new Float32Array(frames), voiced = new Uint8Array(frames);
for (let i = 0; i < frames; i++) {
	if (track.f0[i] > 60) { pitchMidi[i] = 69 + 12 * Math.log2(track.f0[i] / 440); voiced[i] = 1; }
}

/** lock-in 量抖音深度（半音），順便回傳相位 */
function vib(sig) {
	const t = trackF0(sig, sr, HOP_SEC);
	const pts = [];
	for (let i = 0; i < t.f0.length; i++) {
		const time = i * HOP_SEC;
		if (time < SEL_FROM + 0.2 || time > SEL_TO - 0.2) continue;
		if (t.f0[i] > 60) pts.push({ t: time, s: 12 * Math.log2(t.f0[i] / 440) });
	}
	if (pts.length < 20) return { depth: NaN, phase: 0 };
	const dev = pts.map((p, k) => {
		const win = pts.slice(Math.max(0, k - 6), k + 7).map(q => q.s).sort((a, b) => a - b);
		return { t: p.t, v: p.s - win[win.length >> 1] };
	});
	let re = 0, im = 0;
	for (const { t, v } of dev) { re += v * Math.cos(2 * Math.PI * VIB_HZ * t); im += v * Math.sin(2 * Math.PI * VIB_HZ * t); }
	re = 2 * re / dev.length; im = 2 * im / dev.length;
	return { depth: Math.hypot(re, im), phase: Math.atan2(im, re) };
}

const api = await loadRubberBand();
const orig = vib(x);
console.log(`原始抖音深度 = ${orig.depth.toFixed(4)} 半音，相位 ${(orig.phase * 180 / Math.PI).toFixed(0)}°\n`);

const curves = new Curves(frames);
flattenRange(curves, pitchMidi, voiced, SEL_FROM, SEL_TO, 0);

// 先檢查曲線本身：把 Δ 加回偵測到的音高，抖音應該要消失
{
	const pts = [];
	for (let i = 0; i < frames; i++) {
		const time = i * HOP_SEC;
		if (time < SEL_FROM + 0.2 || time > SEL_TO - 0.2 || !voiced[i]) continue;
		pts.push({ t: time, s: pitchMidi[i] + curves.pitch[i] });
	}
	const dev = pts.map((p, k) => {
		const win = pts.slice(Math.max(0, k - 6), k + 7).map(q => q.s).sort((a, b) => a - b);
		return { t: p.t, v: p.s - win[win.length >> 1] };
	});
	let re = 0, im = 0;
	for (const { t, v } of dev) { re += v * Math.cos(2 * Math.PI * VIB_HZ * t); im += v * Math.sin(2 * Math.PI * VIB_HZ * t); }
	console.log(`曲線本身（預期音高）的抖音深度 = ${(2 * Math.hypot(re, im) / dev.length).toFixed(4)} 半音  ← 這是「數學上」該有的結果\n`);
}

console.log('延遲補償    算繪後抖音深度   相對原始');
console.log('────────    ──────────────   ────────');
let best = { lag: 0, d: Infinity };
for (let lagMs = -120; lagMs <= 120; lagMs += 20) {
	const [y] = renderWithCurve(api, {
		channels: [x], sampleRate: sr, delta: curves.pitch, gainDb: curves.gainDb,
		hopSec: HOP_SEC, automationLagSec: lagMs / 1000,
	});
	const d = vib(y).depth;
	if (d < best.d) best = { lag: lagMs, d };
	const bar = '█'.repeat(Math.round(d / orig.depth * 20));
	console.log(`${String(lagMs).padStart(5)}ms     ${d.toFixed(4).padStart(11)}      ${(d / orig.depth * 100).toFixed(0).padStart(4)}%  ${bar}`);
}
console.log(`\n最佳補償 = ${best.lag}ms，抖音深度 ${best.d.toFixed(4)}（原始的 ${(best.d / orig.depth * 100).toFixed(0)}%）`);
