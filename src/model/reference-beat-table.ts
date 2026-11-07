import { referenceBeatGrid } from './reference-beat-grid';

/** 單一參考音軌的逐拍紀錄；時間均為主時間軸上的秒數。 */
export interface ReferenceBeatRecord {
	timeSec: number;
	beatInBar: number;
	firstBeatSec: number;
	/** 預留給後續的參考音高與和弦分析。 */
	pitchMidi?: number;
	chord?: string;
}

/** 只將本次分析的拍點併入原紀錄，保留其他範圍與已記錄的音樂資料。 */
export function mergeReferenceBeats(
	existing: readonly ReferenceBeatRecord[], bars: readonly number[], bpm: number, meter: string,
	range: { start: number; end: number },
): ReferenceBeatRecord[] {
	const next = existing.map(row => ({ ...row }));
	for (const marker of referenceBeatGrid(bars, bpm, meter)) {
		if (marker.time < range.start || marker.time > range.end) continue;
		const firstBeatSec = bars[marker.barIndex];
		const row = { timeSec: marker.time, beatInBar: marker.beatInBar, firstBeatSec };
		const index = next.findIndex(previous => previous.beatInBar === row.beatInBar
			&& Math.abs(previous.timeSec - row.timeSec) < 0.05);
		if (index < 0) next.push(row);
		else next[index] = { ...next[index], ...row };
	}
	return next.sort((a, b) => a.timeSec - b.timeSec);
}

export function shiftReferenceBeats(rows: readonly ReferenceBeatRecord[], delta: number, from = -Infinity): ReferenceBeatRecord[] {
	return rows.map(row => row.timeSec < from ? { ...row } : {
		...row, timeSec: row.timeSec + delta,
		firstBeatSec: row.firstBeatSec >= from ? row.firstBeatSec + delta : row.firstBeatSec,
	});
}

/** 專案檔屬外部資料，略過格式錯誤的拍點，避免畫面與拖動操作讀到非數值。 */
export function restoreReferenceBeats(value: unknown): ReferenceBeatRecord[] {
	if (!Array.isArray(value)) return [];
	return value.filter((row): row is ReferenceBeatRecord => row !== null && typeof row === 'object'
		&& Number.isFinite(row.timeSec)
		&& Number.isInteger(row.beatInBar) && row.beatInBar > 0
		&& Number.isFinite(row.firstBeatSec)
		&& (row.pitchMidi === undefined || Number.isFinite(row.pitchMidi))
		&& (row.chord === undefined || typeof row.chord === 'string'))
		.map(row => ({ ...row })).sort((a, b) => a.timeSec - b.timeSec);
}
