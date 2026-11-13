import { CURVE_HOP_SEC, type Curves } from './curves';
import type { CorrectionNote } from './auto-pitch';
import type { ReferenceRhythm } from '../analysis/reference-cache';

export type ReferenceCorrectionDirection = 'up' | 'down' | 'none';

const ROOTS: Record<string, number> = { C: 0, 'C♯': 1, 'D♭': 1, D: 2, 'D♯': 3, 'E♭': 3, E: 4,
	F: 5, 'F♯': 6, 'G♭': 6, G: 7, 'G♯': 8, 'A♭': 8, A: 9, 'A♯': 10, 'B♭': 10, B: 11 };

export function chordPitchClasses(chord: string | undefined): number[] {
	if (!chord) return [];
	const normalized = chord.trim().replace(/^([A-G])#/i, '$1♯').replace(/^([A-G])b/i, '$1♭');
	const rootMatch = normalized.match(/^(C♯|D♭|D♯|E♭|F♯|G♭|G♯|A♭|A♯|B♭|[A-G])/i);
	if (!rootMatch) return [];
	const rootName = rootMatch[1][0].toUpperCase() + rootMatch[1].slice(1);
	const root = ROOTS[rootName], suffix = normalized.slice(rootMatch[1].length);
	if (root === undefined) return [];
	const intervals = suffix === 'm7' ? [0, 3, 7, 10] : suffix === 'maj7' ? [0, 4, 7, 11]
		: suffix === '7' ? [0, 4, 7, 10] : suffix === 'm' ? [0, 3, 7] : suffix === 'dim' ? [0, 3, 6]
		: suffix === 'aug' ? [0, 4, 8] : suffix === 'sus2' ? [0, 2, 7] : suffix === 'sus4' ? [0, 5, 7]
		: suffix === 'add9' ? [0, 2, 4, 7] : suffix === '' ? [0, 4, 7] : null;
	if (!intervals) return [];
	return intervals.map(interval => (root + interval) % 12);
}

/** 只將參考和弦轉成既有 AI 候選的修正方向，不建立新的候選位置。 */
export function applyReferenceHarmony(notes: readonly CorrectionNote[], curves: Pick<Curves, 'timeMap'>,
	rhythm?: ReferenceRhythm): CorrectionNote[] {
	const harmony = rhythm?.beatHarmony?.filter(beat => !!beat.chord && beat.pitchClasses.length)
		.sort((a, b) => a.timeSec - b.timeSec) ?? [];
	if (!harmony.length) return notes.map(note => ({ ...note }));
	return notes.map(note => {
		const timeSec = curves.timeMap.srcToOut(note.from * CURVE_HOP_SEC);
		let nearest = harmony[0];
		for (const candidate of harmony) {
			if (Math.abs(candidate.timeSec - timeSec) < Math.abs(nearest.timeSec - timeSec)) nearest = candidate;
		}
		const pitchClasses = chordPitchClasses(nearest.chord);
		const targetCandidates: number[] = [];
		for (const pitchClass of (pitchClasses.length ? pitchClasses : nearest.pitchClasses)) {
			const octave = Math.floor(note.center / 12);
			for (const shift of [-1, 0, 1]) targetCandidates.push((octave + shift) * 12 + pitchClass);
		}
		const target = targetCandidates
			.filter(value => value >= 0 && value <= 127)
			.sort((a, b) => Math.abs(a - note.center) - Math.abs(b - note.center) || a - b)[0];
		if (target === undefined) return { ...note };
		const distance = target - note.center;
		const direction: ReferenceCorrectionDirection = Math.abs(distance) < 0.15 ? 'none' : distance > 0 ? 'up' : 'down';
		// 參考軌只提供既有候選段落的方向；不能把原本不需修正的音符變成候選。
		const existingCandidate = note.defaultTarget !== null && Math.abs(note.defaultTarget - note.center) >= 0.05;
		if (!existingCandidate || direction === 'none') return { ...note };
		const directionalTargets = note.targets.filter(value => direction === 'up' ? value >= note.center : value <= note.center);
		const directionalTarget = directionalTargets.sort((a, b) =>
			Math.abs(a - note.center) - Math.abs(b - note.center) || a - b)[0];
		return { ...note,
			defaultTarget: directionalTarget ?? note.defaultTarget,
			referenceDirection: direction,
		};
	});
}

