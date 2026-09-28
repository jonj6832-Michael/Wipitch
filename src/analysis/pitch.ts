// 主執行緒這側的音高偵測介面。
import type { PitchTrack } from './swiftf0';
import SwiftF0Worker from './swiftf0.worker?worker';

export function detectPitch(
	mono16k: Float32Array,
	onProgress?: (fraction: number) => void,
): Promise<PitchTrack> {
	return new Promise((resolve, reject) => {
		const worker = new SwiftF0Worker();

		worker.onmessage = (e: MessageEvent) => {
			const d = e.data;
			if (typeof d.progress === 'number') { onProgress?.(d.progress); return; }
			worker.terminate();
			if (d.ok) resolve({ f0: d.f0, confidence: d.confidence, voiced: d.voiced, length: d.length });
			else reject(new Error(d.error));
		};
		worker.onerror = (err: ErrorEvent) => { worker.terminate(); reject(new Error(err.message)); };

		// audio 要複製一份再轉移，因為原始的 mono16k 之後還要用
		const copy = mono16k.slice();
		worker.postMessage({ audio: copy, modelUrl: new URL('models/swift_f0.onnx', document.baseURI).href }, [copy.buffer]);
	});
}
