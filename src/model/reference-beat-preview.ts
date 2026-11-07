/** 預覽只依設定推算，不讀取音訊，也不受檢測範圍影響。BPM 以拍號分母為拍值。 */
export function referenceBeatPreview(anchor: number, bpm: number, meter: string, start: number, end: number): number[] {
	const beats = Number(meter.split('/')[0]);
	if (!Number.isFinite(anchor) || !Number.isFinite(bpm) || bpm < 30 || bpm > 300 || ![2, 3, 4].includes(beats)) return [];
	const bar = 60 / bpm * beats;
	return Array.from({ length: 9 }, (_, i) => anchor + (i - 4) * bar).filter(t => t >= start && t <= end);
}
