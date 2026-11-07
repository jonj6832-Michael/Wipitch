/** 從相鄰且合理的確認小節起點，算選定範圍內的小節平均速度。 */
export function averageBarBpm(barStarts: readonly number[], bpm: number, meter: string): number | null {
	const beats = Number(meter.split('/')[0]);
	if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(beats) || beats <= 0) return null;
	const expected = 60 * beats / bpm;
	let sum = 0, count = 0;
	for (let i = 1; i < barStarts.length; i++) {
		const interval = barStarts[i] - barStarts[i - 1];
		// 跳過漏判小節或錯誤起音，避免將兩小節當成一小節平均。
		if (interval < expected * 0.75 || interval > expected * 1.25) continue;
		sum += 60 * beats / interval;
		count++;
	}
	return count ? sum / count : null;
}
