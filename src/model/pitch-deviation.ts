import type { KeySignature } from './keys';

export type PitchDeviation = {
	targetMidi: number;
	cents: number;
	direction: 'near' | 'sharp' | 'flat';
};

/**
 * 以最近的調內音作為參考，不推測旋律原本應唱哪個音。
 * 距離完全相同時固定採較低音，避免結果取決於音階陣列的排列。
 */
export function pitchDeviation(midi: number, key: KeySignature | null): PitchDeviation | null {
	if (!key || !key.pitchClasses.length || !Number.isFinite(midi)) return null;
	let targetMidi = Infinity;
	let distance = Infinity;
	for (const pitchClass of key.pitchClasses) {
		const lower = Math.floor((midi - pitchClass) / 12) * 12 + pitchClass;
		for (const candidate of [lower, lower + 12]) {
			const delta = Math.abs(midi - candidate);
			if (delta < distance || (delta === distance && candidate < targetMidi)) {
				distance = delta;
				targetMidi = candidate;
			}
		}
	}
	const cents = (midi - targetMidi) * 100;
	return { targetMidi, cents, direction: cents >= 50 ? 'sharp' : cents <= -50 ? 'flat' : 'near' };
}
