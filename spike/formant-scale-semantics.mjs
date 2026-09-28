// rubberband_set_formant_scale(1.0) 到底等不等於「不呼叫它」？
//
// 這個問題很要命：舊版程式碼從來不呼叫 set_formant_scale，所以它一直是預設的
// 0.0（= 交給 FormantPreserved 自動推算）。加入 formant 曲線之後，曲線值為 0 的
// 地方我們改成明確傳 1.0。如果 1.0 的語意不是「保留」，音色保留就被無聲地關掉了，
// 而這正是「拉高音會不會變花栗鼠」的差別。
//
// 量法沿用 formant-test.mjs：比較移調前後「頻譜包絡重心」移動了幾個半音，
// 再用「單純改播放速度」當校準基準（定義上完全沒保留）。
//   保留率 = 1 − 量到的包絡位移 / 校準基準的位移      1.0 = 完美保留、0.0 = 沒保留
import { readWav } from './wav.mjs';
import { loadRubberBand } from './rubberband-node.mjs';
import { averageSpectrum, spectralEnvelope, envelopeCentroidSemitones } from './spectrum.mjs';

const FFT = 4096;
const START = 45, DUR = 8;
const BLOCK = 1024;
// 產品的選項組合（rbcore.RB_OPTIONS）
const RT = 1, FINER = 536870912, HC = 67108864, FORMANT = 16777216;
const OPTIONS = RT | FINER | HC | FORMANT;

const w = readWav('Vocal.wav');
const sr = w.sampleRate;
const x = w.channels[0].subarray(START * sr, (START + DUR) * sr);

const centroid = sig => envelopeCentroidSemitones(spectralEnvelope(averageSpectrum(sig, FFT), 80), sr, FFT);
const base = centroid(x);

function resample(src, ratio) {
	const n = Math.floor(src.length / ratio), out = new Float32Array(n);
	for (let i = 0; i < n; i++) { const p = i * ratio, j = Math.floor(p), f = p - j; out[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f; }
	return out;
}

/**
 * 固定移調量跑一遍 realtime 管線。
 * @param formantScale null = 完全不呼叫 set_formant_scale（舊版行為），否則每個 block 傳這個值
 */
function render(api, semitones, formantScale) {
	const n = x.length;
	const state = api.rubberband_new(sr, 1, OPTIONS, 1.0, Math.pow(2, semitones / 12));
	const block = Math.min(BLOCK, api.rubberband_get_samples_required(state));
	api.rubberband_set_max_process_size(state, block);
	const startPad = api.rubberband_get_preferred_start_pad(state);

	const arrayPtr = api.malloc(4);
	const dataPtr = api.malloc(block * 4);
	api.memWritePtr(arrayPtr, dataPtr);

	const discard = startPad;
	const out = new Float32Array(n);
	let written = 0;
	const drain = final => {
		for (;;) {
			const avail = api.rubberband_available(state);
			if (avail < 1 || (!final && avail < block)) break;
			const got = api.rubberband_retrieve(state, arrayPtr, Math.min(block, avail));
			if (got < 1) break;
			const d = api.memReadF32(dataPtr, got);
			for (let i = 0; i < got; i++) {
				const pos = written + i - discard;
				if (pos >= 0 && pos < n) out[pos] = d[i];
			}
			written += got;
			if (written - discard >= n) return;
		}
	};

	const silence = new Float32Array(block);
	for (let done = 0; done < startPad;) {
		const count = Math.min(block, startPad - done);
		api.memWrite(dataPtr, silence.subarray(0, count));
		api.rubberband_process(state, arrayPtr, count, 0);
		done += count;
		drain(false);
	}
	for (let read = 0; read < n;) {
		const count = Math.min(block, n - read);
		if (formantScale !== null) api.rubberband_set_formant_scale(state, formantScale);
		api.memWrite(dataPtr, x.subarray(read, read + count));
		read += count;
		api.rubberband_process(state, arrayPtr, count, read >= n ? 1 : 0);
		drain(false);
		if (written - discard >= n) break;
	}
	drain(true);

	api.rubberband_delete(state);
	api.free(dataPtr);
	api.free(arrayPtr);
	return out;
}

const api = await loadRubberBand();

console.log(`素材：Vocal.wav ${START}s ~ ${START + DUR}s，選項 = 產品設定（含 FormantPreserved）`);
console.log('保留率：1.00 = 完美保留音色、0.00 = 完全沒保留（跟著泛音一起移動）\n');
console.log('半音   校準基準    不呼叫(舊版)        傳 0.0(auto)        傳 1.0');
console.log('────  ─────────  ─────────────────  ─────────────────  ─────────────────');

const cases = [
	['不呼叫', null],
	['0.0', 0.0],
	['1.0', 1.0],
];
const totals = new Map(cases.map(([name]) => [name, []]));

for (const k of [-5, -2, 2, 5, 7]) {
	const calib = centroid(resample(x, Math.pow(2, k / 12))) - base;
	const cells = [];
	for (const [name, scale] of cases) {
		const shift = centroid(render(api, k, scale)) - base;
		const ratio = 1 - shift / calib;
		totals.get(name).push(ratio);
		cells.push(`${shift >= 0 ? '+' : ''}${shift.toFixed(2)} 半音 ${ratio.toFixed(2)}`.padStart(17));
	}
	console.log(`${String(k).padStart(4)}  ${calib.toFixed(2).padStart(9)}  ${cells.join('  ')}`);
}

const avg = name => (totals.get(name).reduce((a, b) => a + b, 0) / totals.get(name).length);
console.log(`\n平均保留率：不呼叫 ${avg('不呼叫').toFixed(3)}、傳 0.0 ${avg('0.0').toFixed(3)}、傳 1.0 ${avg('1.0').toFixed(3)}`);

// ── 明確 scale 的換算公式 ──────────────────────────────────────────────
//
// 上面的結果顯示「明確指定 scale 會關掉自動補償」，所以包絡的位移應該是
//     位移（半音） = Δ + 12·log2(scale)
// 驗證方法：挑幾個 (Δ, 目標位移 D) 組合，用 scale = 2^((D − Δ)/12) 去算，
// 看量到的位移是不是就是 D。
console.log('\n明確 scale 的換算：scale = 2^((D − Δ)/12) 是否真的產生 D 的包絡位移？');
console.log('（D = 想要的包絡位移，0 = 保留音色。尺規是「把原始素材 resample D 半音」的包絡重心——');
console.log('  用 Δ 的校準去量 D 的位移會錯，這個指標在升調與降調的壓縮率並不對稱。）\n');
console.log('   Δ      D    scale    量到的重心   D 的尺規    誤差');
console.log('─────  ─────  ───────  ──────────  ──────────  ───────');
for (const [k, D] of [[7, 0], [5, 0], [-5, 0], [7, -4], [-5, 4], [2, 2], [0, -4]]) {
	const scale = Math.pow(2, (D - k) / 12);
	const want = D === 0 ? 0 : centroid(resample(x, Math.pow(2, D / 12))) - base;
	const got = centroid(render(api, k, scale)) - base;
	console.log(`${String(k).padStart(5)}  ${String(D).padStart(5)}  ${scale.toFixed(4).padStart(7)}  ${got.toFixed(2).padStart(10)}  ${want.toFixed(2).padStart(10)}  ${(got - want >= 0 ? '+' : '')}${(got - want).toFixed(2)}`);
}
