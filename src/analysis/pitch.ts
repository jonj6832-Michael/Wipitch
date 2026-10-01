// 主執行緒這側的音高偵測介面。
import type { PitchTrack } from './swiftf0';
import SwiftF0Worker from './swiftf0.worker?worker';
import SwiftF0GpuWorker from './swiftf0-gpu.worker?worker';
import { withWasmFallback, type ComputeMode, type BackendStatus } from './compute-mode';

export function detectPitch(
	mono16k: Float32Array,
	onProgress?: (fraction: number) => void,
	onStage?: (stage: string) => void,
	options: { mode?: ComputeMode; onBackend?: (status: BackendStatus) => void } = {},
): Promise<PitchTrack> {
	let fallbackReason: string | undefined;
	return withWasmFallback(options.mode ?? 'wasm', backend => new Promise((resolve, reject) => {
		const worker = backend === 'webgpu' ? new SwiftF0GpuWorker() : new SwiftF0Worker();
		const fail = (error: Error) => { worker.terminate(); reject(error); };

		worker.onmessage = (e: MessageEvent) => {
			const d = e.data;
			if (d.backend) { options.onBackend?.({ backend: d.backend, fallback: fallbackReason !== undefined, reason: fallbackReason }); return; }
			if (typeof d.stage === 'string') { onStage?.(d.stage); return; }
			if (typeof d.progress === 'number') { onProgress?.(d.progress); return; }
			worker.terminate();
			if (d.ok) resolve({ f0: d.f0, confidence: d.confidence, voiced: d.voiced, length: d.length });
			else reject(new Error(d.error));
		};
		worker.onerror = (err: ErrorEvent) => { err.preventDefault(); fail(new Error(err.message || '音高 Worker 無法啟動')); };
		worker.onmessageerror = () => fail(new Error('音高 Worker 資料傳輸失敗'));

		// 保留原始 mono16k 供 GPU 失敗後的 WASM 回退；最終成功後由載入流程釋放。
		try {
			const copy = mono16k.slice();
			worker.postMessage({ audio: copy, modelUrl: new URL('models/swift_f0.onnx', document.baseURI).href }, [copy.buffer]);
		} catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
	}), reason => {
		fallbackReason = reason;
		onStage?.('GPU 無法使用，改用 CPU 重新分析');
		onProgress?.(0);
		options.onBackend?.({ backend: 'wasm', fallback: true, reason });
	});
}
