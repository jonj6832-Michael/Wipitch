// 在 Worker 裡跑 SwiftF0。放 Worker 是因為 100 秒的音檔要跑好幾秒，
// 在主執行緒跑會讓整個介面凍住。
/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';

declare const self: DedicatedWorkerGlobalScope;
import { HOP, CONFIDENCE_THRESHOLD, MODEL_FMIN, MODEL_FMAX } from './swiftf0';

// 一次餵給模型的長度。整段一起餵（100 秒 = 160 萬個 sample）記憶體吃緊，
// 切塊比較保險。切點一律對齊 HOP，否則格子的時間戳會偏掉。
const CHUNK = 320000;          // 20 秒
const CONTEXT = 4096;          // 每塊前後多帶的前後文（16 格）
const CONTEXT_FRAMES = CONTEXT / HOP;

let session: ort.InferenceSession | null = null;

self.onmessage = async (e: MessageEvent) => {
	const { audio, modelUrl } = e.data as { audio: Float32Array; modelUrl: string };
	try {
		if (!session) {
			session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
		}
		const result = await analyse(session, audio);
		self.postMessage({ ok: true, ...result }, [result.f0.buffer, result.confidence.buffer, result.voiced.buffer]);
	} catch (err) {
		self.postMessage({ ok: false, error: (err as Error).message });
	}
};

async function analyse(session: ort.InferenceSession, audio: Float32Array) {
	const totalFrames = Math.max(1, Math.floor((audio.length - HOP) / HOP) + 1);
	const f0 = new Float32Array(totalFrames);
	const confidence = new Float32Array(totalFrames);
	const inputName = session.inputNames[0];

	for (let start = 0; start < audio.length; start += CHUNK) {
		// 前後多帶一段真實音訊當前後文，算完再把邊緣的格子丟掉。
		// 不這樣做的話，每塊的頭尾會看到零填充，接縫處的音高會抽一下。
		const from = Math.max(0, start - CONTEXT);
		const to = Math.min(audio.length, start + CHUNK + CONTEXT);
		const slice = audio.subarray(from, to);

		const tensor = new ort.Tensor('float32', slice, [1, slice.length]);
		const out = await session.run({ [inputName]: tensor });
		const names = session.outputNames;
		const chunkF0 = out[names[0]].data as Float32Array;
		const chunkConf = out[names[1]].data as Float32Array;

		// 這塊的第 0 格對應到全域的第幾格
		const frameBase = from / HOP;
		const dropHead = from > 0 ? CONTEXT_FRAMES : 0;
		const dropTail = to < audio.length ? CONTEXT_FRAMES : 0;

		for (let i = dropHead; i < chunkF0.length - dropTail; i++) {
			const g = frameBase + i;
			if (g >= 0 && g < totalFrames) { f0[g] = chunkF0[i]; confidence[g] = chunkConf[i]; }
		}

		self.postMessage({ progress: Math.min(1, (start + CHUNK) / audio.length) });
	}

	const voiced = new Uint8Array(totalFrames);
	for (let i = 0; i < totalFrames; i++) {
		voiced[i] = (confidence[i] > CONFIDENCE_THRESHOLD && f0[i] >= MODEL_FMIN && f0[i] <= MODEL_FMAX) ? 1 : 0;
	}
	return { f0, confidence, voiced, length: totalFrames };
}
