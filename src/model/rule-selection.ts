import { CURVE_HOP_SEC } from './curves';
import type { Curves } from './curves';
import type { CorrectionNote } from './auto-pitch';

/** 固定容許帶，不隨程度改變；避免修正極小波動。 */
export const RULE_TOLERANCE_SEMITONES = .05;
export function ruleMinimumDurationMs(level: number): number {
	if (!Number.isInteger(level) || level < 1 || level > 10) throw new Error('修正程度必須為 1～10 級');
	return 48 * (11 - level);
}

/** 在既有可靠候選內找連續同方向偏離；無聲、回準或反向都會中斷。 */
export function selectRuleNotes(base: Curves, notes: readonly CorrectionNote[], midi: Float32Array,
	voiced: Uint8Array, level: number): CorrectionNote[] {
	const minimum = ruleMinimumDurationMs(level) / 1000;
	const result: CorrectionNote[] = [];
	for (const note of notes) {
		const target = note.defaultTarget;
		if (target === null) continue;
		// 參考和弦已確認這是同一個長音的單方向修正；保留完整區段，
		// 不因中間短暫回到容許帶而拆成多個黃框。
		if (note.referenceDirection && note.referenceDirection !== 'none') {
			const end = Math.min(note.to, base.length, midi.length, voiced.length);
			const values: number[] = [];
			for (let i = note.from; i < end; i++) if (voiced[i] && Number.isFinite(midi[i])) values.push(midi[i] + base.pitch[i]);
			values.sort((a, b) => a - b);
			if (values.length && base.timeMap.srcToOut(end * CURVE_HOP_SEC) - base.timeMap.srcToOut(note.from * CURVE_HOP_SEC) + 1e-9 >= minimum) {
				const center = values[Math.floor(values.length / 2)];
				result.push({ ...note, id: result.length, to: end, center,
					spread: values[Math.floor((values.length - 1) * .9)] - values[Math.floor((values.length - 1) * .1)] });
			}
			continue;
		}
		let start = note.from, direction = 0;
		const emit = (end: number) => {
			if (!direction || end <= start) return;
			const duration = base.timeMap.srcToOut(end * CURVE_HOP_SEC)
				- base.timeMap.srcToOut(start * CURVE_HOP_SEC);
			if (duration + 1e-9 < minimum) return;
			const values: number[] = [];
			for (let i = start; i < end; i++) values.push(midi[i] + base.pitch[i]);
			values.sort((a, b) => a - b);
			result.push({ ...note, id: result.length, from: start, to: end,
				center: values[Math.floor(values.length / 2)],
				spread: values[Math.floor((values.length - 1) * .9)] - values[Math.floor((values.length - 1) * .1)] });
		};
		const end = Math.min(note.to, base.length, midi.length, voiced.length);
		for (let i = note.from; i < end; i++) {
			const error = midi[i] + base.pitch[i] - target;
			const next = voiced[i] && Number.isFinite(error) && Math.abs(error) + 1e-7 >= RULE_TOLERANCE_SEMITONES
				? Math.sign(error) : 0;
			if (next !== direction) { emit(i); start = i; direction = next; }
		}
		emit(end);
	}
	return result;
}
