import { referenceBeatGrid } from './reference-beat-grid';
import type { ReferenceRhythm } from '../analysis/reference-cache';

/** 單一參考音軌的逐拍紀錄；時間均為主時間軸上的秒數。 */
export interface ReferenceBeatRecord {
	timeSec: number;
	beatInBar: number;
	firstBeatSec: number;
	/** 未在使用者設定的 BPM 容許範圍找到可信起音時保留的虛擬小節起點。 */
	virtual?: boolean;
	/** 該拍頻譜中主要音級，0=C、1=C♯，依序至 11=B。 */
	pitchClasses?: number[];
	/** 與 pitchClasses 對應的可讀音名，例如 C、E、G。 */
	pitchNames?: string[];
	/** 舊版單音欄位，保留讀檔相容。 */
	pitchMidi?: number;
	chord?: string;
	chordConfidence?: 'high' | 'low';
	/** 使用者人工覆寫和弦；originalChord 保留分析器最初結果供顯示與訓練追蹤。 */
	chordEdited?: boolean;
	originalChord?: string;
}

export interface ReferenceBeatRange { start: number; end: number }

/** 節拍範圍一律採 [start,end)，相鄰檢測範圍不會重複命中邊界拍點。 */
export function referenceBeatInRange(timeSec: number, range: ReferenceBeatRange): boolean {
	return Number.isFinite(timeSec) && range.end > range.start && timeSec >= range.start && timeSec < range.end;
}

export function hasReferenceBeatsInRange(rows: readonly ReferenceBeatRecord[], range: ReferenceBeatRange): boolean {
	return rows.some(row => referenceBeatInRange(row.timeSec, range));
}

/** 已保存的逐拍紀錄是持久真實來源；即使畫面重建清除了暫存分析結果，AI 仍可使用和弦。 */
export function referenceRhythmForRange(rows:readonly ReferenceBeatRecord[],range:ReferenceBeatRange,
	bpm:number,meter:string,synced:ReferenceRhythm|null):ReferenceRhythm|undefined{
	const beats=rows.filter(row=>referenceBeatInRange(row.timeSec,range));
	if(!beats.length)return undefined;
	const bars=beats.filter(beat=>beat.beatInBar===1).map(beat=>beat.timeSec);
	return{
		bpm:synced?.bpm??bpm,meter:synced?.meter??meter,anchorSec:synced?.anchorSec??beats[0].firstBeatSec,
		barStartsSec:(synced?.barStartsSec??bars).filter(time=>time>=range.start&&time<=range.end),
		virtualBarStartsSec:(synced?.virtualBarStartsSec??beats.filter(beat=>beat.virtual&&beat.beatInBar===1).map(beat=>beat.timeSec))
			.filter(time=>referenceBeatInRange(time,range)),
		beatTimesSec:beats.map(beat=>beat.timeSec),virtualBeatTimesSec:beats.filter(beat=>beat.virtual).map(beat=>beat.timeSec),
		beatHarmony:beats.map(beat=>({timeSec:beat.timeSec,pitchClasses:[...(beat.pitchClasses??[])],
			pitchNames:[...(beat.pitchNames??[])],chord:beat.chord,chordConfidence:beat.chordConfidence})),
		pitch:synced?.pitch?.filter(point=>point.timeSec>=range.start&&point.timeSec<=range.end),
	};
}

/** 清除檢測範圍內的三角形與虛擬 X，範圍外紀錄與附帶資訊保持不變。 */
export function clearReferenceBeatsInRange(rows: readonly ReferenceBeatRecord[], range: ReferenceBeatRange): ReferenceBeatRecord[] {
	return rows.filter(row => !referenceBeatInRange(row.timeSec, range)).map(row => ({ ...row }));
}

/** 只將本次分析的拍點併入原紀錄，保留其他範圍與已記錄的音樂資料。 */
export function mergeReferenceBeats(
	existing: readonly ReferenceBeatRecord[], bars: readonly number[], bpm: number, meter: string,
	range: { start: number; end: number }, virtualBars: readonly number[] = [],
	beatHarmony: readonly { timeSec: number; pitchClasses: readonly number[]; pitchNames: readonly string[]; chord?: string; chordConfidence?: 'high' | 'low' }[] = [],
	beatTimes: readonly number[] = [], virtualBeatTimes: readonly number[] = [],
): ReferenceBeatRecord[] {
	const next = existing.map(row => ({ ...row }));
	const nominalMarkers = referenceBeatGrid(bars, bpm, meter);
	const markers = beatTimes.length ? beatTimes.slice(0, nominalMarkers.length)
		.map((time, index) => ({ ...nominalMarkers[index], time })) : nominalMarkers;
	for (const marker of markers) {
		if (!referenceBeatInRange(marker.time, range)) continue;
		const firstBeatSec = bars[marker.barIndex];
		const virtual = virtualBeatTimes.length
			? virtualBeatTimes.some(time => Math.abs(time - marker.time) < 0.005)
			: marker.downbeat && virtualBars.some(time => Math.abs(time - firstBeatSec) < 0.005);
		// 明確寫入 false，讓同一位置後續成功命中時能移除舊的虛擬標記。
		const harmony = beatHarmony.reduce<typeof beatHarmony[number] | undefined>((nearest, candidate) =>
			Math.abs(candidate.timeSec - marker.time) < Math.abs((nearest?.timeSec ?? Infinity) - marker.time) ? candidate : nearest, undefined);
		const matchedHarmony = harmony && Math.abs(harmony.timeSec - marker.time) < 0.03 ? harmony : undefined;
		const row = { timeSec: marker.time, beatInBar: marker.beatInBar, firstBeatSec, virtual,
			pitchClasses: matchedHarmony ? [...matchedHarmony.pitchClasses] : undefined,
			pitchNames: matchedHarmony ? [...matchedHarmony.pitchNames] : undefined,
			chord: matchedHarmony?.chord, chordConfidence: matchedHarmony?.chordConfidence };
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
		&& (row.pitchClasses === undefined || Array.isArray(row.pitchClasses)
			&& row.pitchClasses.every((value: unknown) => typeof value === 'number'
				&& Number.isInteger(value) && value >= 0 && value < 12))
		&& (row.pitchNames === undefined || Array.isArray(row.pitchNames)
			&& row.pitchNames.every((value: unknown) => typeof value === 'string'))
		&& (row.pitchMidi === undefined || Number.isFinite(row.pitchMidi))
		&& (row.chord === undefined || typeof row.chord === 'string')
		&& (row.chordConfidence === undefined || row.chordConfidence === 'high' || row.chordConfidence === 'low')
		&& (row.chordEdited === undefined || typeof row.chordEdited === 'boolean')
		&& (row.originalChord === undefined || typeof row.originalChord === 'string'))
		.map(row => ({ ...row, pitchClasses: row.pitchClasses ? [...row.pitchClasses] : undefined,
			pitchNames: row.pitchNames ? [...row.pitchNames] : undefined }))
		.sort((a, b) => a.timeSec - b.timeSec);
}
