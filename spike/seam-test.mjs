// 接縫測試：把「重算的一小段」貼回「舊的整段算繪」，接縫處會怎樣？
//
// 前一個測試測錯了東西。相位聲碼器的輸出相位取決於整個處理歷史，
// 分段算繪本來就不可能跟整段算繪逐 sample 相同——但那不代表會有聽得見的接縫。
// 真正該問的是：拼接處有沒有不連續（爆音），以及交叉淡化能不能蓋掉。
import { readWav, writeWav } from './wav.mjs';
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';

const HOP_SEC = 256 / 16000;
const w = readWav('Vocal.wav');
const sr = w.sampleRate;
const x = w.channels[0].subarray(45 * sr, 53 * sr);
const frames = Math.ceil(x.length / sr / HOP_SEC) + 2;
const flat = v => new Float32Array(frames).fill(v);

const api = await loadRubberBand();
const DELTA = parseFloat(process.argv[2] || '0');
console.log(`接縫兩側的 Δ = ${DELTA} 半音\n`);

// 基準：整段一次算繪
const [full] = renderWithCurve(api, { channels: [x], sampleRate: sr, delta: flat(DELTA), gainDb: flat(0), hopSec: HOP_SEC });

// 重算 4~5 秒這一段（同樣 Δ=0，所以內容應該一樣，差別純粹來自「分開算」）
const from = 4 * sr, to = 5 * sr;
const [tile] = renderWithCurve(api, {
	channels: [x], sampleRate: sr, delta: flat(0), gainDb: flat(0), hopSec: HOP_SEC,
	fromSample: from, toSample: to, preRollSamples: Math.round(sr * 0.5),
});

/** 量某個位置附近的「相鄰 sample 跳躍量」相對於該處訊號強度的比值 */
function discontinuity(buf, at, win = 64) {
	let maxJump = 0;
	for (let i = at - win; i < at + win; i++) {
		const j = Math.abs(buf[i + 1] - buf[i]);
		if (j > maxJump) maxJump = j;
	}
	let rms = 0, n = 0;
	for (let i = at - 2000; i < at + 2000; i++) { rms += buf[i] * buf[i]; n++; }
	return maxJump / (Math.sqrt(rms / n) + 1e-9);
}

// 參考值：連續訊號本身的自然跳躍比值
const natural = [1, 2, 3, 6].map(s => discontinuity(full, s * sr)).reduce((a, b) => a + b) / 4;
console.log(`連續訊號的自然跳躍比值（基準）= ${natural.toFixed(2)}\n`);

function splice(fadeMs) {
	const out = Float32Array.from(full);
	const fade = Math.round(sr * fadeMs / 1000);
	for (let i = 0; i < tile.length; i++) {
		let a = 1;                                    // tile 的權重
		if (fade > 0) {
			if (i < fade) a = 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
			else if (i > tile.length - fade) a = 0.5 - 0.5 * Math.cos(Math.PI * (tile.length - i) / fade);
		}
		out[from + i] = full[from + i] * (1 - a) + tile[i] * a;
	}
	return out;
}

console.log('淡化長度   頭接縫跳躍   尾接縫跳躍   交叉區RMS/原始RMS');
for (const ms of [0, 5, 15, 30, 60]) {
	const s = splice(ms);
	const head = discontinuity(s, from), tail = discontinuity(s, to);
	// 交叉淡化區的音量：兩個相位不同的訊號疊加會抵消，音量掉下去就代表有梳狀濾波
	const fade = Math.max(1, Math.round(sr * ms / 1000));
	let a = 0, b = 0;
	for (let i = from; i < from + fade; i++) { a += s[i] * s[i]; b += full[i] * full[i]; }
	console.log(`  ${String(ms).padStart(3)}ms      ${head.toFixed(2).padStart(6)}       ${tail.toFixed(2).padStart(6)}        ${(Math.sqrt(a / (b + 1e-20))).toFixed(3)}`);
	if (ms === 30) writeWav('spike/out/seam_30ms.wav', [s], sr);
}
writeWav('spike/out/seam_none.wav', [splice(0)], sr);
writeWav('spike/out/seam_ref.wav', [full], sr);
