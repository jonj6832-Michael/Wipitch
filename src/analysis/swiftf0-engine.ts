// 在 Worker 裡跑 SwiftF0。放 Worker 是因為 100 秒的音檔要跑好幾秒，
// 在主執行緒跑會讓整個介面凍住。
/// <reference lib="webworker" />
import type * as Ort from 'onnxruntime-web';
import type { ComputeBackend } from './compute-mode';

declare const self: DedicatedWorkerGlobalScope;
import { HOP, CONFIDENCE_THRESHOLD, MODEL_FMIN, MODEL_FMAX } from './swiftf0';

// 一次餵給模型的長度。整段一起餵（100 秒 = 160 萬個 sample）記憶體吃緊，
// 切塊比較保險。切點一律對齊 HOP，否則格子的時間戳會偏掉。
const CHUNK = 320000;          // 20 秒
const CONTEXT = 4096;          // 每塊前後多帶的前後文（16 格）
const CONTEXT_FRAMES = CONTEXT / HOP;

export function installSwiftF0Worker(ort: typeof Ort, backend: ComputeBackend) {
	// 每個 WASM Worker 代表一個 CPU 工作槽；避免 cross-origin isolated 部署時
	// ONNX Runtime 在每個 Worker 內再次展開執行緒而造成 CPU 過度訂閱。
	if (ort.env.wasm) ort.env.wasm.numThreads = 1;
	let retainedSession: Ort.InferenceSession | null = null;
	const createSession = async (modelUrl: string) => {
		if (backend === 'webgpu' && !('gpu' in self.navigator)) throw new Error('此瀏覽器未提供 WebGPU');
		const session = await ort.InferenceSession.create(modelUrl, {
			executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
		});
		if (backend === 'webgpu' && !(await ort.env.webgpu.device)) {
			await session.release();
			throw new Error('WebGPU 裝置初始化失敗');
		}
		return session;
	};
	self.onmessage = async (e: MessageEvent) => {
		const data = e.data as { type?: 'init' | 'analyse' | 'dispose'; id?: number; audio?: Float32Array; modelUrl?: string };
		// Worker pool protocol: initialize once, then analyse multiple time segments.
		if (data.type === 'init') {
			try {
				retainedSession = await createSession(data.modelUrl!);
				self.postMessage({ type: 'ready', backend });
			} catch (err) {
				self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
			}
			return;
		}
		if (data.type === 'analyse') {
			try {
				if (!retainedSession || !data.audio) throw new Error('音高 Worker 尚未初始化');
				const result = await analyse(ort, retainedSession, data.audio,
					progress => self.postMessage({ type: 'progress', id: data.id, progress }));
				self.postMessage({ type: 'result', id: data.id, ...result },
					[result.f0.buffer, result.confidence.buffer, result.voiced.buffer]);
			} catch (err) {
				self.postMessage({ type: 'error', id: data.id, error: err instanceof Error ? err.message : String(err) });
			}
			return;
		}
		if (data.type === 'dispose') {
			try { await retainedSession?.release(); } finally { retainedSession = null; self.postMessage({ type: 'disposed' }); }
			return;
		}

		// Backward-compatible one-shot protocol used by diagnostics and fallback tests.
		const { audio, modelUrl } = data as { audio: Float32Array; modelUrl: string };
		let session: Ort.InferenceSession | null = null;
		try {
			self.postMessage({ stage: backend === 'webgpu' ? '載入音高模型（GPU 優先）' : '載入音高模型（CPU）' });
			session = await createSession(modelUrl);
			self.postMessage({ backend });
			self.postMessage({ stage: '分析音高' });
			const result = await analyse(ort, session, audio, progress => self.postMessage({ progress }));
			await session.release();
			session = null;
			self.postMessage({ ok: true, ...result }, [result.f0.buffer, result.confidence.buffer, result.voiced.buffer]);
		} catch (err) {
			try { await session?.release(); } catch { /* 裝置遺失時仍須回報失敗以啟動 fallback。 */ }
			self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	};
}

async function analyse(ort: typeof Ort, session: Ort.InferenceSession, audio: Float32Array,
	onProgress: (fraction: number) => void) {
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
		let out: Ort.InferenceSession.ReturnType | undefined;
		try {
			out = await session.run({ [inputName]: tensor });
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
		} finally {
			tensor.dispose();
			if (out) for (const value of Object.values(out)) value.dispose();
		}

		onProgress(Math.min(1, (start + CHUNK) / audio.length));
	}

	const voiced = new Uint8Array(totalFrames);
	for (let i = 0; i < totalFrames; i++) {
		voiced[i] = (confidence[i] > CONFIDENCE_THRESHOLD && f0[i] >= MODEL_FMIN && f0[i] <= MODEL_FMAX) ? 1 : 0;
	}
	return { f0, confidence, voiced, length: totalFrames };
}
