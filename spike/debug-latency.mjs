import { readWav } from './wav.mjs';
import { loadRubberBand } from './rubberband-node.mjs';

const sr = 48000;
const api = await loadRubberBand();
const OPTIONS = 1 | 536870912 | 33554432 | 16777216;
const state = api.rubberband_new(sr, 1, OPTIONS, 1.0, 1.0);
console.log('samples_required   ', api.rubberband_get_samples_required(state));
console.log('preferred_start_pad', api.rubberband_get_preferred_start_pad(state));
console.log('start_delay        ', api.rubberband_get_start_delay(state));
api.rubberband_delete(state);

// 用脈衝實測延遲：送一個尖峰進去，看它從第幾個 sample 出來
const w = readWav('Vocal.wav');
const n = sr * 2;
const imp = new Float32Array(n);
imp[sr] = 1.0;   // 第 1 秒放一根脈衝

for (const usePad of [false, true]) {
	const st = api.rubberband_new(sr, 1, OPTIONS, 1.0, 1.0);
	const block = api.rubberband_get_samples_required(st);
	const pad = api.rubberband_get_preferred_start_pad(st);
	const delay = api.rubberband_get_start_delay(st);
	const arr = api.malloc(4), buf = api.malloc(block * 4);
	api.memWritePtr(arr, buf);
	const out = new Float32Array(n * 2);
	let written = 0;
	const drain = f => { for (;;) { const av = api.rubberband_available(st); if (av < 1 || (!f && av < block)) break;
		const got = api.rubberband_retrieve(st, arr, Math.min(block, av)); if (got < 1) break;
		const d = api.memReadF32(buf, got); for (let i = 0; i < got; i++) if (written + i < out.length) out[written + i] = d[i]; written += got; } };
	if (usePad) { const z = new Float32Array(block);
		for (let d = 0; d < pad;) { const c = Math.min(block, pad - d); api.memWrite(buf, z.subarray(0, c)); api.rubberband_process(st, arr, c, 0); d += c; drain(false); } }
	for (let r = 0; r < n;) { const c = Math.min(block, n - r); api.memWrite(buf, imp.subarray(r, r + c)); r += c; api.rubberband_process(st, arr, c, r >= n ? 1 : 0); drain(false); }
	drain(true);
	let peak = 0, at = 0;
	for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > peak) { peak = Math.abs(out[i]); at = i; }
	console.log(`\nusePad=${usePad}  block=${block} pad=${pad} delay=${delay}`);
	console.log(`  脈衝在輸入的第 ${sr}，輸出峰值在第 ${at}  → 實測延遲 ${at - sr}`);
	console.log(`  若 discard = delay(${delay}) + pad(${usePad ? pad : 0}) = ${delay + (usePad ? pad : 0)}，則殘餘偏移 = ${at - sr - delay - (usePad ? pad : 0)}`);
	api.rubberband_delete(st); api.free(buf); api.free(arr);
}
