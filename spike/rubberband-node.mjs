// 在 Node 裡用 rubberband-wasm 做離線移調，當作品質基準線。
// 等同命令列的 `rubberband -3 -F`：R3(Finer) 引擎 + 保留 formant。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rb = require('rubberband-wasm/dist/index.umd.js');

const OPT = {
	ProcessOffline: 0,
	ProcessRealTime: 1,
	EngineFiner: 536870912,       // -3
	FormantPreserved: 16777216,   // -F
	PitchHighQuality: 33554432,
};

export async function loadRubberBand() {
	const bytes = fs.readFileSync(require.resolve('rubberband-wasm/dist/rubberband.wasm'));
	const mod = await WebAssembly.compile(bytes);
	return rb.RubberBandInterface.initialize(mod);
}

/**
 * 離線移調。時間比例固定 1.0，只動音高。
 * @param preserveFormant 是否保留音色（等同 -F）
 * @param realtime        用 realtime 模式（不做 study 全域規劃，可分塊處理但品質較差）
 */
export function rbPitchShift(api, input, sampleRate, semitones, preserveFormant, realtime = false) {
	const channels = input.length;
	const n = input[0].length;
	const pitchScale = Math.pow(2, semitones / 12);

	let options = (realtime ? OPT.ProcessRealTime : OPT.ProcessOffline) | OPT.EngineFiner | OPT.PitchHighQuality;
	if (preserveFormant) options |= OPT.FormantPreserved;

	const state = api.rubberband_new(sampleRate, channels, options, 1.0, pitchScale);
	if (!realtime) api.rubberband_set_expected_input_duration(state, n);

	const chunk = api.rubberband_get_samples_required(state);
	const arrayPtr = api.malloc(channels * 4);
	const dataPtr = [];
	for (let c = 0; c < channels; c++) {
		const p = api.malloc(chunk * 4);
		dataPtr.push(p);
		api.memWritePtr(arrayPtr + c * 4, p);
	}

	// 第一階段：study（只有離線模式需要；realtime 模式看不到未來，所以跳過）
	for (let read = 0; !realtime && read < n;) {
		const count = Math.min(chunk, n - read);
		input.forEach((b, i) => api.memWrite(dataPtr[i], b.subarray(read, read + count)));
		read += count;
		api.rubberband_study(state, arrayPtr, count, read >= n ? 1 : 0);
	}

	// 第二階段：process + retrieve
	const out = input.map(() => new Float32Array(n + chunk * 4));
	let write = 0;
	const drain = final => {
		for (;;) {
			const avail = api.rubberband_available(state);
			if (avail < 1) break;
			if (!final && avail < chunk) break;
			const got = api.rubberband_retrieve(state, arrayPtr, Math.min(chunk, avail));
			if (got < 1) break;
			dataPtr.forEach((p, i) => {
				if (write + got <= out[i].length) out[i].set(api.memReadF32(p, got), write);
			});
			write += got;
		}
	};
	for (let read = 0; read < n;) {
		const count = Math.min(chunk, n - read);
		input.forEach((b, i) => api.memWrite(dataPtr[i], b.subarray(read, read + count)));
		read += count;
		api.rubberband_process(state, arrayPtr, count, read >= n ? 1 : 0);
		drain(false);
	}
	drain(true);

	api.rubberband_delete(state);
	dataPtr.forEach(p => api.free(p));
	api.free(arrayPtr);

	return out.map(b => b.subarray(0, Math.min(write, n)));
}
