// 端對端測試壓平抖音：跑真正的 edits.flattenRange + rbcore.renderWithCurve，
// 然後量「算繪出來的聲音」的抖音有沒有真的減少。
//
// 這一項先前漏掉了：app 裡的 wobble 指標量的是「曲線算出來的預期音高」，
// 不是實際輸出的音高。結果就是曲線明明對了，聲音卻沒被壓平也沒人發現。
//
// 註：這裡用自相關追蹤基頻（app 用的是 SwiftF0）。本測試要驗的是
// 「算繪有沒有跟上曲線」，不是驗偵測器，所以用哪個追蹤器不影響結論。
import { readWav, writeWav } from './wav.mjs';
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';
import { Curves } from '../src/model/curves.ts';
import { flattenRange } from '../src/model/edits.ts';
import { trackF0 } from './f0track.mjs';

const sr = 48000, HOP_SEC = 256 / 16000;
const AT = 66.4, LEN = 2.4;          // 含抖音的持續音，前後多留一點
const SEL_FROM = 0.35, SEL_TO = 1.9; // 選取範圍（相對於這一小段的開頭）
const VIB_HZ = 5.25;

const w = readWav('Vocal.wav');
const x = w.channels[0].subarray(Math.round(AT * sr), Math.round((AT + LEN) * sr));

// --- 建立 app 會有的那些資料：16ms 格點上的音高與發聲判斷 ---
const track = trackF0(x, sr, HOP_SEC);
const frames = track.f0.length;
const pitchMidi = new Float32Array(frames);
const voiced = new Uint8Array(frames);
for (let i = 0; i < frames; i++) {
	const hz = track.f0[i];
	if (hz > 60) { pitchMidi[i] = 69 + 12 * Math.log2(hz / 440); voiced[i] = 1; }
}

/** 量一段音訊在 VIB_HZ 的音高調變深度（半音） */
function vibratoDepth(sig) {
	const t = trackF0(sig, sr, HOP_SEC);
	const pts = [];
	for (let i = 0; i < t.f0.length; i++) {
		const time = i * HOP_SEC;
		if (time < SEL_FROM + 0.15 || time > SEL_TO - 0.15) continue;   // 避開邊界斜坡
		if (t.f0[i] > 60) pts.push({ t: time, s: 12 * Math.log2(t.f0[i] / 440) });
	}
	if (pts.length < 20) return NaN;
	// 先減掉移動中位數的中心線，才不會把旋律走向算成抖音
	const dev = pts.map((p, k) => {
		const win = pts.slice(Math.max(0, k - 6), k + 7).map(q => q.s).sort((a, b) => a - b);
		return { t: p.t, v: p.s - win[win.length >> 1] };
	});
	let re = 0, im = 0;
	for (const { t, v } of dev) { re += v * Math.cos(2 * Math.PI * VIB_HZ * t); im += v * Math.sin(2 * Math.PI * VIB_HZ * t); }
	return 2 * Math.hypot(re, im) / dev.length;
}

const api = await loadRubberBand();
const RT = 1, FINER = 536870912, FORMANT = 16777216, HQ = 33554432, HC = 67108864;

const before = vibratoDepth(x);
console.log(`素材：Vocal.wav ${AT}s~${(AT + LEN).toFixed(1)}s，抖音 ${VIB_HZ}Hz`);
console.log(`原始抖音深度 = ${before.toFixed(4)} 半音\n`);

console.log('α（壓平強度）  選項          算繪後的抖音深度   相對原始');
console.log('─────────────  ────────────  ────────────────  ────────');
for (const alpha of [0, 0.5]) {
	for (const [optName, opt] of [['高品質(舊)', HQ], ['一致性(新)', HC]]) {
		const curves = new Curves(frames);
		flattenRange(curves, pitchMidi, voiced, SEL_FROM, SEL_TO, alpha);
		const [y] = renderWithCurve(api, {
			channels: [x], sampleRate: sr, delta: curves.pitch, gainDb: curves.gainDb,
			hopSec: HOP_SEC, options: RT | FINER | FORMANT | opt,
		});
		const d = vibratoDepth(y);
		console.log(`   α=${alpha.toFixed(1)}       ${optName.padEnd(14)}${d.toFixed(4).padStart(12)}      ${(d / before * 100).toFixed(0)}%`);
		if (alpha === 0) writeWav(`spike/out/flat_${opt === HQ ? 'old' : 'new'}.wav`, [y], sr);
	}
}
writeWav('spike/out/flat_orig.wav', [x], sr);
console.log('\n試聽檔：spike/out/flat_orig.wav（原始）、flat_old.wav（修正前）、flat_new.wav（修正後）');
