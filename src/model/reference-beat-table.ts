import { referenceBeatGrid } from './reference-beat-grid';

/** 單一參考音軌的逐拍紀錄；時間均為主時間軸上的秒數。 */
export interface ReferenceBeatRecord {
	timeSec: number;
	beatInBar: number;
	firstBeatSec: number;
	/** 未在使用者設定的 BPM 容許範圍找到可信起音時保留的虛擬小節起點。 */
	virtual?: boolean;
	/** 預留給後續的參考音高與和弦分析。 */
	pitchMidi?: number;
	chord?: string;
}

export interface ReferenceBeatRange { start: number; end: number }

/** 節拍範圍一律採 [start,end)，相鄰檢測範圍不會重複命中邊界拍點。 */
export function referenceBeatInRange(timeSec: number, range: ReferenceBeatRange): boolean {
	return Number.isFinite(timeSec) && range.end > range.start && timeSec >= range.start && timeSec < range.end;
}

export function hasReferenceBeatsInRange(rows: readonly ReferenceBeatRecord[], range: ReferenceBeatRange): boolean {
	return rows.some(row => referenceBeatInRange(row.timeSec, range));
}

/** 清除檢測範圍內的三角形與虛擬 X，範圍外紀錄與附帶資訊保持不變。 */
export function clearReferenceBeatsInRange(rows: readonly ReferenceBeatRecord[], range: ReferenceBeatRange): ReferenceBeatRecord[] {
	return rows.filter(row => !referenceBeatInRange(row.timeSec, range)).map(row => ({ ...row }));
}

/** 只將本次分析的拍點併入原紀錄，保留其他範圍與已記錄的音樂資料。 */
export function mergeReferenceBeats(
	existing: readonly ReferenceBeatRecord[], bars: readonly number[], bpm: number, meter: string,
	range: { start: number; end: number }, virtualBars: readonly number[] = [],
): ReferenceBeatRecord[] {
	const next = existing.map(row => ({ ...row }));
	for (const marker of referenceBeatGrid(bars, bpm, meter)) {
		if (!referenceBeatInRange(marker.time, range)) continue;
		const firstBeatSec = bars[marker.barIndex];
		const virtual = marker.downbeat && virtualBars.some(time => Math.abs(time - firstBeatSec) < 0.005);
		// 明確寫入 false，讓同一位置後續成功命中時能移除舊的虛擬標記。
		const row = { timeSec: marker.time, beatInBar: marker.beatInBar, firstBeatSec, virtual };
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
		&& (row.virtual === undefined || typeof row.virtual === 'boolean')
		&& (row.pitchMidi === undefined || Number.isFinite(row.pitchMidi))
		&& (row.chord === undefined || typeof row.chord === 'string'))
		.map(row => ({ ...row })).sort((a, b) => a.timeSec - b.timeSec);
}
