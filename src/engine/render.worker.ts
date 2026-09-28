/// <reference lib="webworker" />
// 算繪 Worker。把 Rubber Band 的計算移出主執行緒，這樣拖曳編輯時介面不會卡。
import { renderWithCurve, type RubberBandApi } from './rbcore';
import wasmUrl from 'rubberband-wasm/dist/rubberband.wasm?url';
import { RubberBandInterface } from 'rubberband-wasm';

declare const self: DedicatedWorkerGlobalScope;

let api: RubberBandApi | null = null;
let source: Float32Array[] = [];
let sampleRate = 48000;

async function ensureApi(): Promise<RubberBandApi> {
	if (!api) {
		const bytes = await (await fetch(wasmUrl)).arrayBuffer();
		api = await RubberBandInterface.initialize(await WebAssembly.compile(bytes)) as RubberBandApi;
	}
	return api;
}

self.onmessage = async (e: MessageEvent) => {
	const msg = e.data;
	try {
		if (msg.type === 'init') {
			source = msg.channels;
			sampleRate = msg.sampleRate;
			await ensureApi();
			self.postMessage({ type: 'ready' });
			return;
		}

		if (msg.type === 'render') {
			const a = await ensureApi();
			const { delta, gainDb, formant, formantFollow, hopSec, fromSample, toSample, preRollSamples, anchors, id } = msg;
			const out = renderWithCurve(a, {
				channels: source, sampleRate, delta, gainDb, formant, formantFollow, hopSec,
				// 漏傳 anchors 的話 worker 會照 1× 算，但主執行緒以為有伸縮——長度對、內容錯，
				// 而且不會報錯（第一版就是這樣，spike/stretch-pitch.mjs 量音高才抓到）
				fromSample, toSample, preRollSamples, anchors,
				onProgress: f => self.postMessage({ type: 'progress', id, fraction: f }),
			});
			self.postMessage(
				{ type: 'rendered', id, fromSample: fromSample ?? 0, channels: out },
				out.map(c => c.buffer),
			);
			return;
		}
	} catch (err) {
		self.postMessage({ type: 'error', id: msg.id, error: (err as Error).message });
	}
};
