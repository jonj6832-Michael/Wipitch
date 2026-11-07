import { findOnset, trackBars, type ReferenceCache } from './reference-cache';
import { estimateReferenceTempo } from './reference-tempo';

export interface RhythmRequest {
	audio: Float32Array;
	onsets: Float32Array;
	anchorSec: number;
	bpm: number;
	meter: string;
	estimate: boolean;
}
export interface RhythmResult { bpm: number; anchorSec: number; barStartsSec: number[] }

// 單一 Worker 依時間順序追蹤整個範圍，不把有前後依賴的小節切給不同 Worker。
self.onmessage = ({ data }: MessageEvent<RhythmRequest>) => {
	try {
		const duration = data.audio.length / 16000;
		const cache: ReferenceCache = { mono16k: data.audio, onsets: data.onsets, duration };
		// 正式檢測才搜尋錨點；錨點在範圍外時保留其相位，不讀取範圍外音訊。
		const anchorSec = data.anchorSec >= 0 && data.anchorSec <= duration
			? findOnset(cache, data.anchorSec, 0.5) ?? data.anchorSec : data.anchorSec;
		const beat = 60 / data.bpm;
		const phase = ((anchorSec % beat) + beat) % beat;
		const bpm = data.estimate ? estimateReferenceTempo([data.audio], 16000, phase, data.bpm) : data.bpm;
		if (bpm === null) throw new Error('參考音軌沒有足夠的節奏訊號');
		self.postMessage({ result: { bpm, anchorSec, barStartsSec: trackBars(cache, anchorSec, bpm, data.meter, 0, duration) } });
	} catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
