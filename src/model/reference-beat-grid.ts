export interface BeatMarker { time: number; downbeat: boolean; barIndex: number; beatInBar: number }

/** 每個小節起點為紅色第一拍；其餘拍點依拍號插在相鄰小節之間。 */
export function referenceBeatGrid(bars: readonly number[], bpm: number, meter: string): BeatMarker[] {
	const beats = Number(meter.split('/')[0]);
	if (!Number.isFinite(bpm) || bpm <= 0 || ![2, 3, 4].includes(beats)) return [];
	const nominalBar = beats * 60 / bpm;
	const markers: BeatMarker[] = [];
	for (let i = 0; i < bars.length; i++) {
		const start = bars[i], next = bars[i + 1];
		markers.push({ time: start, downbeat: true, barIndex: i, beatInBar: 1 });
		const duration = next !== undefined && next - start >= nominalBar * 0.65 && next - start <= nominalBar * 1.4
			? next - start : nominalBar;
		for (let beat = 1; beat < beats; beat++) {
			const time = start + duration * beat / beats;
			if (next === undefined || time < next) markers.push({ time, downbeat: false, barIndex: i, beatInBar: beat + 1 });
		}
	}
	return markers;
}

/** 拖動某個第一拍後，後續小節保持原來的間距一起平移。 */
export function moveDownbeatAndFollowing(bars: readonly number[], index: number, delta: number, duration: number): number[] {
	if (index < 0 || index >= bars.length || !Number.isFinite(delta)) return [...bars];
	const minimum = index > 0 ? bars[index - 1] + 0.05 - bars[index] : -bars[index];
	const maximum = duration - bars[bars.length - 1];
	const shift = Math.max(minimum, Math.min(maximum, delta));
	return bars.map((time, i) => i < index ? time : time + shift);
}
