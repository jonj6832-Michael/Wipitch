/** 十二平均律的音級；自然小調採用關係大調的相同七個音。 */
export const KEY_MODES = [
	{ id: 'major', label: '大調', intervals: [0, 2, 4, 5, 7, 9, 11] },
	{ id: 'minor', label: '自然小調', intervals: [0, 2, 3, 5, 7, 8, 10] },
] as const;
export const KEY_ROOTS = ['C', 'C♯ / D♭', 'D', 'D♯ / E♭', 'E', 'F', 'F♯ / G♭', 'G', 'G♯ / A♭', 'A', 'A♯ / B♭', 'B'];
export const KEY_OPTIONS = KEY_MODES.flatMap(mode => KEY_ROOTS.map((name, root) => ({
	id: `${mode.id}-${root}`, mode: mode.id, label: `${name} ${mode.label}`,
	pitchClasses: mode.intervals.map(interval => (root + interval) % 12),
})));
export type KeySignature = typeof KEY_OPTIONS[number];
export function isInKey(midi: number, key: KeySignature | null): boolean {
	return key === null || key.pitchClasses.includes(((midi % 12) + 12) % 12);
}
