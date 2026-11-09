import { createSpectralFluxOnsets, trackBarSequence, type ReferenceCache } from './reference-cache';

export interface RhythmRequest {
	audio: Float32Array;
	anchorSec: number;
	bpm: number;
	meter: string;
	bpmTolerance: number;
	onsetProminence: number;
	confirmationThreshold: number;
}
export interface RhythmResult { bpm: number; anchorSec: number; barStartsSec: number[]; virtualBarStartsSec: number[] }

// 單一 Worker 依時間順序追蹤整個範圍，不把有前後依賴的小節切給不同 Worker。
self.onmessage = ({ data }: MessageEvent<RhythmRequest>) => {
	try {
		const duration = data.audio.length / 16000;
		const cache: ReferenceCache = { mono16k: data.audio, onsets: createSpectralFluxOnsets(data.audio), duration };
		if (!Number.isFinite(data.bpm) || data.bpm <= 0) throw new Error('初始 BPM 無效');
		const tolerance = Number.isFinite(data.bpmTolerance) ? data.bpmTolerance : 0.05;
		// 錨點由使用者先行確認；頻譜候選需通過使用者設定的 BPM 範圍與連續節奏評分。
		const sequence = trackBarSequence(cache, data.anchorSec, data.bpm, data.meter, 0, duration, tolerance,
			data.onsetProminence, data.confirmationThreshold);
		self.postMessage({ result: { bpm: data.bpm, anchorSec: data.anchorSec,
			barStartsSec: sequence.map(point => point.timeSec),
			virtualBarStartsSec: sequence.filter(point => !point.confirmed).map(point => point.timeSec) } });
	} catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
