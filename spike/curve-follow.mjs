// 最基本的問題：時變的 Δ 曲線到底有沒有真的讓輸出音高跟著變？
// 分三種難度測：常數 → 慢速斜坡 → 快速正弦。
import { loadRubberBand } from './rubberband-node.mjs';
import { renderWithCurve } from '../src/engine/rbcore.ts';

const sr = 48000, HOP_SEC = 256 / 16000, F0 = 300, DUR = 3;

// 穩定的 300Hz 母音，沒有抖音
const n = sr * DUR, src = new Float32Array(n);
{
	const pulses = new Float32Array(n);
	let g = 0;
	for (let i = 0; i < n; i++) { g += F0 / sr; if (g >= 1) { g -= 1; pulses[i] = 1; } }
	for (const [hz, bw, gain] of [[700, 90, 1], [1220, 110, .5], [2600, 140, .25]]) {
		const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * hz / sr;
		const a1 = 2 * r * Math.cos(th), a2 = -r * r;
		let y1 = 0, y2 = 0;
		for (let i = 0; i < n; i++) { const y = pulses[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; src[i] += y * gain; }
	}
	let pk = 0; for (const v of src) pk = Math.max(pk, Math.abs(v));
	for (let i = 0; i < n; i++) src[i] *= 0.4 / pk;
}

// 在指定時間點附近量音高（搜尋範圍放寬到 ±14 半音，因為要量移調後的結果）
function f0At(x, tSec) {
	const off = Math.round(tSec * sr), N = 2048;
	const lo = Math.floor(sr / (F0 * Math.pow(2, 14 / 12)));
	const hi = Math.ceil(sr / (F0 * Math.pow(2, -14 / 12)));
	if (off + N + hi >= x.length) return NaN;
	const cc = l => { let s = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { s += x[off + i] * x[off + i + l]; a += x[off + i] ** 2; b += x[off + i + l] ** 2; } return s / Math.sqrt(a * b + 1e-20); };
	let best = -2, bl = 0;
	for (let l = lo; l <= hi; l++) { const c = cc(l); if (c > best) { best = c; bl = l; } }
	if (!bl) return NaN;
	const ym = cc(Math.max(lo, bl - 1)), yp = cc(Math.min(hi, bl + 1));
	const d = ym - 2 * best + yp;
	return sr / (bl + (d ? Math.max(-1, Math.min(1, 0.5 * (ym - yp) / d)) : 0));
}
const semi = hz => 12 * Math.log2(hz / F0);

const frames = Math.ceil(DUR / HOP_SEC) + 2;
const gain = new Float32Array(frames).fill(1);
const api = await loadRubberBand();

function run(name, deltaFn, block) {
	const delta = new Float32Array(frames);
	for (let i = 0; i < frames; i++) delta[i] = deltaFn(i * HOP_SEC);
	const [y] = renderWithCurve(api, { channels: [src], sampleRate: sr, delta, gain, hopSec: HOP_SEC, blockSamples: block });
	const probes = [0.6, 1.0, 1.4, 1.8, 2.2];
	const rows = probes.map(t => {
		const want = deltaFn(t), got = semi(f0At(y, t));
		return `t=${t}s 想要${want >= 0 ? '+' : ''}${want.toFixed(2)} 得到${got >= 0 ? '+' : ''}${got.toFixed(2)}`;
	});
	const err = probes.reduce((a, t) => a + Math.abs(semi(f0At(y, t)) - deltaFn(t)), 0) / probes.length;
	console.log(`${name.padEnd(22)} block=${String(block).padStart(4)}  平均誤差 ${err.toFixed(3)} 半音`);
	console.log('   ' + rows.join('  '));
	return err;
}

console.log('原始音高檢查: ' + f0At(src, 1.5).toFixed(1) + 'Hz（應為 300）\n');
for (const block of [4096, 512]) {
	run('① 常數 +7', () => 7, block);
	run('② 慢斜坡 0→+7 (3s)', t => 7 * t / DUR, block);
	run('③ 快正弦 ±2 @5.5Hz', t => 2 * Math.sin(2 * Math.PI * 5.5 * t), block);
	console.log();
}
