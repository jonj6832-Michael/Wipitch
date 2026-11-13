export interface BeatHarmony {
	timeSec: number;
	pitchClasses: number[];
	pitchNames: string[];
	chord?: string;
	chordConfidence?: 'high' | 'low';
}

const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const;
const TEMPLATES = [
	{ intervals: [0, 4, 7], suffix: '' },
	{ intervals: [0, 3, 7], suffix: 'm' },
	{ intervals: [0, 3, 6], suffix: 'dim' },
	{ intervals: [0, 4, 8], suffix: 'aug' },
	{ intervals: [0, 2, 7], suffix: 'sus2' },
	{ intervals: [0, 5, 7], suffix: 'sus4' },
	{ intervals: [0, 4, 7, 10], suffix: '7' },
	{ intervals: [0, 4, 7, 11], suffix: 'maj7' },
	{ intervals: [0, 3, 7, 10], suffix: 'm7' },
] as const;

function median(values: ArrayLike<number>): number {
	const sorted = Array.from(values).sort((a, b) => a - b);
	return (sorted[5] + sorted[6]) / 2;
}

/** Goertzel 音級色度：每拍取三個短窗，累積 C～B 的頻譜能量。 */
function beatChroma(audio: Float32Array, sampleRate: number, startSec: number, endSec: number): Float64Array | null {
	const start = Math.max(0, Math.floor(startSec * sampleRate));
	const end = Math.min(audio.length, Math.ceil(endSec * sampleRate));
	const available = end - start;
	if (available < 256) return null;
	let energy = 0;
	for (let i = start; i < end; i++) energy += audio[i] * audio[i];
	if (Math.sqrt(energy / available) < 1e-4) return null;

	const frameSize = Math.min(2048, available);
	const centers = [0.22, 0.5, 0.78];
	const chroma = new Float64Array(12);
	for (const fraction of centers) {
		const frameStart = Math.max(start, Math.min(end - frameSize,
			Math.round(start + available * fraction - frameSize / 2)));
		for (let midi = 36; midi <= 95; midi++) {
			const frequency = 440 * 2 ** ((midi - 69) / 12);
			if (frequency >= sampleRate / 2) break;
			const omega = 2 * Math.PI * frequency / sampleRate;
			const coefficient = 2 * Math.cos(omega);
			let previous = 0, previous2 = 0;
			for (let i = 0; i < frameSize; i++) {
				const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, frameSize - 1));
				const current = audio[frameStart + i] * window + coefficient * previous - previous2;
				previous2 = previous; previous = current;
			}
			const power = Math.max(0, previous2 * previous2 + previous * previous - coefficient * previous * previous2);
			// 輕微降低高次泛音權重，避免泛音被誤認為額外和弦音。
			chroma[midi % 12] += Math.sqrt(power) / Math.sqrt(Math.max(1, frequency / 110));
		}
	}
	const floor = median(chroma) * 0.55;
	for (let i = 0; i < chroma.length; i++) chroma[i] = Math.max(0, chroma[i] - floor);
	return chroma;
}

function describeChroma(chroma: Float64Array): { pitchClasses: number[]; pitchNames: string[]; chord?: string; chordConfidence?: 'high' | 'low' } {
	const maximum = Math.max(...chroma), total = chroma.reduce((sum, value) => sum + value, 0);
	if (maximum <= 0 || total <= 0) return { pitchClasses: [], pitchNames: [] };
	const pitchClasses = [...chroma.keys()]
		.filter(index => chroma[index] >= maximum * 0.34 && chroma[index] >= total * 0.065)
		.sort((a, b) => chroma[b] - chroma[a]).slice(0, 5).sort((a, b) => a - b);
	const pitchNames = pitchClasses.map(index => PITCH_NAMES[index]);
	if (!pitchClasses.length) return { pitchClasses: [], pitchNames: [] };
	if (pitchClasses.length === 1) return { pitchClasses, pitchNames, chord: PITCH_NAMES[pitchClasses[0]], chordConfidence: 'high' };

	let bestRoot = pitchClasses[0], bestSuffix = '', bestScore = -Infinity;
	for (let root = 0; root < 12; root++) for (const template of TEMPLATES) {
		const members = template.intervals.map(interval => (root + interval) % 12);
		const memberValues = members.map(index => chroma[index] / maximum);
		const memberAverage = memberValues.reduce((sum, value) => sum + value, 0) / memberValues.length;
		const memberMinimum = Math.min(...memberValues);
		let outside = 0;
		for (let index = 0; index < 12; index++) if (!members.includes(index)) outside += chroma[index] / maximum;
		const activeMatches = pitchClasses.filter(index => members.includes(index)).length;
		const missing = members.length - activeMatches;
		const extra = pitchClasses.length - activeMatches;
		const score = memberAverage * 0.56 + memberMinimum * 0.18 + chroma[root] / maximum * 0.14
			- outside * 0.018 - missing * 0.10 - extra * 0.07 - Math.max(0, members.length - 3) * 0.025;
		if (score > bestScore) { bestScore = score; bestRoot = root; bestSuffix = template.suffix; }
	}
	if (bestScore >= 0.34) return { pitchClasses, pitchNames, chord: `${PITCH_NAMES[bestRoot]}${bestSuffix}`, chordConfidence: 'high' };
	const triads = TEMPLATES.filter(template => template.suffix === '' || template.suffix === 'm').map(template => {
		const root = bestRoot;
		const members = template.intervals.map(interval => (root + interval) % 12);
		return { template, root, score: members.reduce((sum, index) => sum + chroma[index] / Math.max(1, Math.max(...chroma)), 0) / 3 };
	}).sort((a, b) => b.score - a.score);
	const low = triads[0], runner = triads[1];
	if (low && low.score >= 0.22 && (!runner || low.score - runner.score >= 0.025)) {
		const rootValue = chroma[low.root] / Math.max(1, Math.max(...chroma));
		const third = chroma[(low.root + (low.template.suffix === 'm' ? 3 : 4)) % 12] / Math.max(1, Math.max(...chroma));
		const fifth = chroma[(low.root + 7) % 12] / Math.max(1, Math.max(...chroma));
		if (rootValue >= 0.45 && third >= 0.25 && fifth >= 0.20)
			return { pitchClasses, pitchNames, chord: `${PITCH_NAMES[low.root]}${low.template.suffix}`, chordConfidence: 'low' };
	}
	return { pitchClasses, pitchNames };
}

/** 逐拍分析音高組成；每拍的分析窗以該拍開始，到下一拍前為止。 */
export function analyzeBeatHarmony(audio: Float32Array, sampleRate: number, beatTimes: readonly number[],
	fallbackBeatDuration: number): BeatHarmony[] {
	return beatTimes.map((timeSec, index) => {
		const next = beatTimes[index + 1] ?? Math.min(audio.length / sampleRate, timeSec + fallbackBeatDuration);
		const duration = Math.max(0.08, next - timeSec);
		const chroma = beatChroma(audio, sampleRate, timeSec + Math.min(0.02, duration * 0.08),
			Math.min(audio.length / sampleRate, timeSec + duration * 0.92));
		return { timeSec, ...(chroma ? describeChroma(chroma) : { pitchClasses: [], pitchNames: [] }) };
	});
}
