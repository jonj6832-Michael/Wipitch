import CandidateWorker from './ai-candidate.worker?worker';
import type { CorrectionInput } from '../application/ai-correction-flow';
import type { CorrectionNote } from '../model/auto-pitch';

export type OutputRange = { start: number; end: number };

/** 真正的瀏覽器 Web Worker 池；不複製原始 WAV，只複製較小的音高分析陣列。 */
export async function collectCorrectionNotesParallel(input: CorrectionInput, ranges: OutputRange[],
	signal: AbortSignal, progress: (done: number, total: number) => void): Promise<CorrectionNote[]> {
	if (!ranges.length) return [];
	const hardware = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
	const count = Math.min(ranges.length, Math.max(1, Math.min(4, hardware - 1 || 1)));
	const workers = Array.from({ length: count }, () => new CandidateWorker());
	const stop = () => workers.forEach(worker => worker.terminate());
	if (signal.aborted) { stop(); throw new Error('AI 修正已取消，未套用變更'); }
	let rejectAbort: ((error: Error) => void) | null = null;
	const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
	const abort = () => { stop(); rejectAbort?.(new Error('AI 修正已取消，未套用變更')); };
	signal.addEventListener('abort', abort, { once: true });
	try {
		let next = 0, done = 0;
		const results: CorrectionNote[][] = Array.from({ length: ranges.length }, () => []);
		await Promise.race([Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
			let current = -1;
			worker.onerror = event => reject(new Error(event.message || 'AI 分析 Worker 無法啟動'));
			worker.onmessageerror = () => reject(new Error('AI 分析 Worker 資料傳輸失敗'));
			worker.onmessage = event => {
				const data = event.data;
				if (data.type === 'error') { reject(new Error(data.error)); return; }
				if (data.type === 'result') { results[current] = data.notes; done++; progress(done, ranges.length); }
				if (data.type !== 'ready' && data.type !== 'result') return;
				if (signal.aborted) { reject(new Error('AI 修正已取消，未套用變更')); return; }
				current = next++;
				if (current >= ranges.length) { resolve(); return; }
				worker.postMessage({ type: 'analyse', id: current, range: ranges[current] });
			};
			const pitch = input.curves.pitch.slice(), midi = input.midi.slice(), voiced = input.voiced.slice();
			worker.postMessage({ type: 'init', pitch, midi, voiced, key: input.key,
				anchors: input.curves.timeMap.anchors.map(anchor => ({ ...anchor })) }, [pitch.buffer, midi.buffer, voiced.buffer]);
		}))), aborted]);
		return results.flat().sort((a, b) => a.from - b.from).map((note, id) => ({ ...note, id }));
	} finally {
		signal.removeEventListener('abort', abort);
		stop();
	}
}
