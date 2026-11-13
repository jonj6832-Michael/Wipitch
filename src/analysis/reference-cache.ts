export interface ReferenceCache {
	mono16k: Float32Array;
	onsets: Float32Array;
	duration: number;
}
export interface ReferenceRhythm {
	bpm: number;
	meter: string;
	anchorSec: number;
	barStartsSec: number[];
	virtualBarStartsSec?: number[];
	beatTimesSec?: number[];
	virtualBeatTimesSec?: number[];
	beatHarmony?: { timeSec: number; pitchClasses: number[]; pitchNames: string[]; chord?: string; chordConfidence?: 'high' | 'low' }[];
	pitch?: { timeSec: number; midi: number }[];
}

const RHYTHM_RATE = 16000;
const RHYTHM_HOP = 160; // 10ms
const SPECTRAL_FFT = 256;
const SPECTRAL_BANDS = 24;
const SPECTRAL_COS = Float32Array.from({ length: SPECTRAL_FFT / 2 }, (_, i) => Math.cos(-2 * Math.PI * i / SPECTRAL_FFT));
const SPECTRAL_SIN = Float32Array.from({ length: SPECTRAL_FFT / 2 }, (_, i) => Math.sin(-2 * Math.PI * i / SPECTRAL_FFT));

/** 面積平均降採樣，保留 16k 單聲道供後續音高偵測；節奏特徵每 10ms 一格。 */
export function createReferenceCache(channels: Float32Array[], rate: number): ReferenceCache {
	const duration = channels[0].length / rate;
	const mono16k = new Float32Array(Math.floor(duration * 16000));
	for (let i = 0; i < mono16k.length; i++) {
		const a = i * rate / 16000, b = (i + 1) * rate / 16000;
		let sum = 0;
		for (let s = Math.floor(a); s < Math.ceil(b); s++) {
			const weight = Math.max(0, Math.min(b, s + 1) - Math.max(a, s));
			for (const ch of channels) sum += (ch[s] ?? 0) * weight / channels.length;
		}
		mono16k[i] = sum / (b - a);
	}
	const energy = new Float32Array(Math.floor(mono16k.length / 160));
	for (let i = 0; i < energy.length; i++) {
		let sum = 0;
		for (let k = 0; k < 160; k++) sum += mono16k[i * 160 + k] ** 2;
		energy[i] = Math.sqrt(sum / 160);
	}
	const onsets = new Float32Array(energy.length);
	for (let i = 2; i < energy.length; i++) onsets[i] = Math.max(0, energy[i] - energy[i - 2]);
	return { mono16k, onsets, duration };
}

function fftInPlace(real: Float32Array, imag: Float32Array): void {
	const n = real.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[real[i], real[j]] = [real[j], real[i]];
			[imag[i], imag[j]] = [imag[j], imag[i]];
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1, rootStep = n / size;
		for (let start = 0; start < n; start += size) {
			for (let k = 0; k < half; k++) {
				const root = k * rootStep, cos = SPECTRAL_COS[root], sin = SPECTRAL_SIN[root];
				const even = start + k, odd = even + half;
				const tr = real[odd] * cos - imag[odd] * sin;
				const ti = real[odd] * sin + imag[odd] * cos;
				real[odd] = real[even] - tr; imag[odd] = imag[even] - ti;
				real[even] += tr; imag[even] += ti;
			}
		}
	}
}

/**
 * 以 24 個對數頻帶建立 SuperFlux 類起音包絡：比較目前頻帶能量與前一幀鄰頻帶最大值，
 * 再以局部平均與標準差正規化。持續和弦、顫音及錄音音量差異較不容易形成假起音。
 */
export function createSpectralFluxOnsets(mono16k: Float32Array): Float32Array {
	const frames = Math.ceil(mono16k.length / RHYTHM_HOP);
	const raw = new Float32Array(frames);
	const real = new Float32Array(SPECTRAL_FFT), imag = new Float32Array(SPECTRAL_FFT);
	const window = Float32Array.from({ length: SPECTRAL_FFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (SPECTRAL_FFT - 1)));
	const bandOfBin = new Int16Array(SPECTRAL_FFT / 2 + 1).fill(-1);
	const bandCounts = new Uint16Array(SPECTRAL_BANDS);
	const minHz = 80, maxHz = RHYTHM_RATE / 2, logSpan = Math.log(maxHz / minHz);
	for (let bin = 1; bin <= SPECTRAL_FFT / 2; bin++) {
		const hz = bin * RHYTHM_RATE / SPECTRAL_FFT;
		if (hz < minHz) continue;
		const band = Math.min(SPECTRAL_BANDS - 1, Math.floor(Math.log(hz / minHz) / logSpan * SPECTRAL_BANDS));
		bandOfBin[bin] = band; bandCounts[band]++;
	}
	let previous = new Float32Array(SPECTRAL_BANDS), current = new Float32Array(SPECTRAL_BANDS);
	for (let frame = 0; frame < frames; frame++) {
		real.fill(0); imag.fill(0); current.fill(0);
		const first = frame * RHYTHM_HOP - SPECTRAL_FFT / 2;
		for (let i = 0; i < SPECTRAL_FFT; i++) real[i] = (mono16k[first + i] ?? 0) * window[i];
		fftInPlace(real, imag);
		for (let bin = 1; bin <= SPECTRAL_FFT / 2; bin++) {
			const band = bandOfBin[bin];
			if (band >= 0) current[band] += Math.hypot(real[bin], imag[bin]);
		}
		let flux = 0;
		for (let band = 0; band < SPECTRAL_BANDS; band++) {
			current[band] = Math.log1p(current[band] / Math.max(1, bandCounts[band]));
			const reference = Math.max(previous[band - 1] ?? 0, previous[band], previous[band + 1] ?? 0);
			flux += Math.max(0, current[band] - reference);
		}
		raw[frame] = flux / SPECTRAL_BANDS;
		[previous, current] = [current, previous];
	}
	// 約 1 秒的局部統計量形成相對門檻，避免固定音量門檻隨錄音增益失效。
	const radius = 50, prefix = new Float64Array(frames + 1), prefixSq = new Float64Array(frames + 1);
	for (let i = 0; i < frames; i++) { prefix[i + 1] = prefix[i] + raw[i]; prefixSq[i + 1] = prefixSq[i] + raw[i] ** 2; }
	const onsets = new Float32Array(frames);
	for (let i = 0; i < frames; i++) {
		const from = Math.max(0, i - radius), to = Math.min(frames, i + radius + 1), count = to - from;
		const mean = (prefix[to] - prefix[from]) / count;
		const variance = Math.max(0, (prefixSq[to] - prefixSq[from]) / count - mean * mean);
		const scale = Math.sqrt(variance) + 1e-7;
		onsets[i] = Math.max(0, (raw[i] - mean) / scale - 0.5);
	}
	return onsets;
}

export function findOnset(cache: ReferenceCache, center: number, radius: number, start = 0, end = cache.duration,
	onsetProminence = DEFAULT_ONSET_PROMINENCE_THRESHOLD,
	confirmationThreshold = DEFAULT_BEAT_CONFIRMATION_THRESHOLD): number | null {
	return findOnsetInWindow(cache, center - radius, center + radius, center, start, end,
		onsetProminence, confirmationThreshold);
}

/** 在非對稱時間窗內找起音；BPM 百分比窗換算成秒數後，前後邊界並不等距。 */
export interface OnsetCandidate { timeSec: number; strength: number; score: number }

export const DEFAULT_ONSET_PROMINENCE_THRESHOLD = 0.65;
export const DEFAULT_BEAT_CONFIRMATION_THRESHOLD = 0.58;

function onsetEnvelopeThreshold(prominence: number): number {
	// 起音包絡建立時已先扣除 0.5 個局部標準差；換回使用者看到的完整突出值。
	const safe = Number.isFinite(prominence) ? prominence : DEFAULT_ONSET_PROMINENCE_THRESHOLD;
	return Math.max(0, safe - 0.5);
}

export function findOnsetCandidates(cache: ReferenceCache, from: number, to: number, preferred: number,
	start = 0, end = cache.duration, limit = 6,
	onsetProminence = DEFAULT_ONSET_PROMINENCE_THRESHOLD): OnsetCandidate[] {
	const found: { index: number; value: number }[] = [];
	const distanceScale = Math.max(0.01, preferred - from, to - preferred);
	const minimumPeak = onsetEnvelopeThreshold(onsetProminence);
	for (let i = Math.max(1, Math.ceil(Math.max(start, from) * 100)); i <= Math.min(cache.onsets.length - 2, Math.floor(Math.min(end, to) * 100)); i++) {
		if (cache.onsets[i] < cache.onsets[i - 1] || cache.onsets[i] < cache.onsets[i + 1]) continue;
		if (cache.onsets[i] >= minimumPeak) found.push({ index: i, value: cache.onsets[i] });
	}
	if (!found.length) return [];
	// 同一次撥弦／琴鍵攻擊可能連續產生數個峰；30ms 內只保留最強者。
	const merged: { index: number; value: number }[] = [];
	for (const candidate of found.sort((a, b) => b.value - a.value)) {
		if (!merged.some(previous => Math.abs(previous.index - candidate.index) <= 3)) merged.push(candidate);
	}
	const strongest = Math.max(...merged.map(candidate => candidate.value));
	return merged.map(candidate => {
		const timeSec = candidate.index / 100;
		const relativeStrength = candidate.value / strongest;
		const absoluteEvidence = Math.min(1, candidate.value / 1.5);
		const strength = 0.6 * absoluteEvidence + 0.4 * relativeStrength;
		const proximity = Math.max(0, 1 - Math.abs(timeSec - preferred) / distanceScale);
		return { timeSec, strength, score: 0.72 * strength + 0.28 * proximity };
	}).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function findOnsetInWindow(cache: ReferenceCache, from: number, to: number, preferred: number,
	start = 0, end = cache.duration, onsetProminence = DEFAULT_ONSET_PROMINENCE_THRESHOLD,
	confirmationThreshold = DEFAULT_BEAT_CONFIRMATION_THRESHOLD): number | null {
	const candidate = findOnsetCandidates(cache, from, to, preferred, start, end, 1, onsetProminence)[0];
	return candidate && candidate.score >= confirmationThreshold ? candidate.timeSec : null;
}

export interface TrackedBar { timeSec: number; confirmed: boolean }

export const REFERENCE_BPM_SEARCH_TOLERANCE = 0.05;

function futureRhythmSupport(cache: ReferenceCache, first: number, interval: number, tolerance: number,
	start: number, end: number, onsetProminence: number, confirmationThreshold: number, depth = 3): number {
	let current = first, currentInterval = interval, support = 0;
	for (let step = 0; step < depth; step++) {
		const expected = current + currentInterval;
		const candidates = findOnsetCandidates(cache, current + currentInterval / (1 + tolerance),
			current + currentInterval / (1 - tolerance), expected, start, end, 3, onsetProminence);
		if (!candidates.length || candidates[0].score < Math.max(0, confirmationThreshold - 0.08)) { current = expected; continue; }
		const candidate = candidates[0];
		support += candidate.score;
		currentInterval = candidate.timeSec - current;
		current = candidate.timeSec;
	}
	return support / depth;
}

export function trackBarSequence(cache: ReferenceCache, anchor: number, bpm: number, meter: string, start: number, end: number,
	bpmTolerance = REFERENCE_BPM_SEARCH_TOLERANCE, onsetProminence = DEFAULT_ONSET_PROMINENCE_THRESHOLD,
	confirmationThreshold = DEFAULT_BEAT_CONFIRMATION_THRESHOLD): TrackedBar[] {
	const beats = Number(meter.split('/')[0]); // BPM 以拍號分母所指音符為一拍。
	const initialInterval = 60 / bpm * beats;
	if (!Number.isFinite(anchor) || !Number.isFinite(initialInterval) || initialInterval <= 0 || end <= start) return [];
	const tolerance = Math.max(0.01, Math.min(0.10, bpmTolerance));
	const points: TrackedBar[] = [];
	if (anchor >= start && anchor < end) points.push({ timeSec: anchor, confirmed: true });
	let current = anchor, interval = initialInterval;
	while (true) {
		const expected = current + interval;
		// 下一點的 BPM 必須落在使用者設定的容許範圍。時間差與 BPM 成反比，
		// 所以換算出的秒數搜尋窗不是固定秒數，也不是左右等寬。
		const earliest = current + interval / (1 + tolerance);
		if (earliest > cache.duration || earliest >= end) break;
		const candidates = findOnsetCandidates(cache, earliest, current + interval / (1 - tolerance), expected,
			start, end, 6, onsetProminence);
		const ranked = candidates.map(candidate => ({ candidate,
			// 當前小節的第一拍證據是主體；後續節奏只作加分，不能因後面暫時無拍而否決本拍。
			score: candidate.score + 0.15 * futureRhythmSupport(cache, candidate.timeSec,
				candidate.timeSec - current, tolerance, start, end, onsetProminence, confirmationThreshold),
		})).sort((a, b) => b.score - a.score);
		const best = ranked[0], ambiguous = !!best && !!ranked[1] && best.score - ranked[1].score < 0.08;
		if (best && best.score >= confirmationThreshold && !ambiguous && best.candidate.timeSec > current + 0.05) {
			// 命中後以最新時間差換算本次 BPM，下一輪再套用相同百分比範圍搜尋。
			interval = best.candidate.timeSec - current;
			current = best.candidate.timeSec;
			if (current >= start && current < end) points.push({ timeSec: current, confirmed: true });
		} else {
			// BPM 範圍內沒命中時保留綠色 X，並沿用前一次 BPM。
			current = expected;
			if (current >= start && current < end) points.push({ timeSec: current, confirmed: false });
		}
	}
	return points;
}

/** 相容既有分析工具：回傳確認與虛擬位置的完整時間序列。 */
export function trackBars(cache: ReferenceCache, anchor: number, bpm: number, meter: string, start: number, end: number): number[] {
	return trackBarSequence(cache, anchor, bpm, meter, start, end).map(point => point.timeSec);
}
