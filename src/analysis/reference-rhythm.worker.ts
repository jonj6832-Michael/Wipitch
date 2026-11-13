import { createSpectralFluxOnsets, trackBarSequence, type ReferenceCache } from './reference-cache';
import { analyzeBeatHarmony, type BeatHarmony } from './reference-chord';
import { referenceBeatGrid } from '../model/reference-beat-grid';

export interface RhythmRequest {
	audio: Float32Array;
	anchorSec: number;
	bpm: number;
	meter: string;
	bpmTolerance: number;
	onsetProminence: number;
	confirmationThreshold: number;
	instrumentProfile?: 'rhythm' | 'melody';
}
export interface RhythmResult {
	bpm: number;
	anchorSec: number;
	barStartsSec: number[];
	virtualBarStartsSec: number[];
	beatTimesSec?: number[];
	virtualBeatTimesSec?: number[];
	beatHarmony: BeatHarmony[];
}

// 單一 Worker 依時間順序追蹤整個範圍，不把有前後依賴的小節切給不同 Worker。
self.onmessage = ({ data }: MessageEvent<RhythmRequest>) => {
	try {
		const duration = data.audio.length / 16000;
		const cache: ReferenceCache = { mono16k: data.audio, onsets: createSpectralFluxOnsets(data.audio), duration };
		if (!Number.isFinite(data.bpm) || data.bpm <= 0) throw new Error('初始 BPM 無效');
		const tolerance = Number.isFinite(data.bpmTolerance) ? data.bpmTolerance : 0.05;
		const melody=data.instrumentProfile!=='rhythm';
		// 錨點由使用者先行確認；頻譜候選需通過使用者設定的 BPM 範圍與連續節奏評分。
		const sequence = trackBarSequence(cache, data.anchorSec, data.bpm, data.meter, 0, duration, tolerance,
			data.onsetProminence * (melody ? .72 : 1), Math.max(.3, data.confirmationThreshold + (melody ? -.06 : 0)));
		const barStartsSec = sequence.map(point => point.timeSec);
		const beatTimes = referenceBeatGrid(barStartsSec, data.bpm, data.meter)
			.map(marker => marker.time).filter(time => time >= 0 && time < duration);
		const beatHarmony = analyzeBeatHarmony(data.audio, 16000, beatTimes, 60 / data.bpm);
		self.postMessage({ result: { bpm: data.bpm, anchorSec: data.anchorSec,
			barStartsSec,
			virtualBarStartsSec: sequence.filter(point => !point.confirmed).map(point => point.timeSec),
			beatHarmony } });
	} catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
