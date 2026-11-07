import RhythmWorker from './reference-rhythm.worker?worker';
import type { RhythmRequest, RhythmResult } from './reference-rhythm.worker';

/** 複製輸入後移交專用 Worker，保留參考音軌的共用暫存。 */
export function detectReferenceRhythm(request: RhythmRequest, signal?: AbortSignal): Promise<RhythmResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new Error('節拍工作已取消')); return; }
		const worker = new RhythmWorker();
		const cleanup = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
		const fail = (message: string) => { cleanup(); reject(new Error(message)); };
		const abort = () => fail('節拍工作已取消');
		signal?.addEventListener('abort', abort, { once: true });
		worker.onerror = event => { event.preventDefault(); fail(event.message || '節拍 Worker 啟動失敗'); };
		worker.onmessageerror = () => fail('節拍 Worker 資料傳輸失敗');
		worker.onmessage = ({ data }) => {
			cleanup();
			if (data.error) reject(new Error(data.error)); else resolve(data.result);
		};
		const audio = request.audio.slice(), onsets = request.onsets.slice();
		worker.postMessage({ ...request, audio, onsets }, [audio.buffer, onsets.buffer]);
	});
}
