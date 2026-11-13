import { CURVE_HOP_SEC, CURVE_SUB, Curves } from './curves';
import { isInKey, type KeySignature } from './keys';

export interface CorrectionNote {
	id: number;
 kind?: 'onset' | 'drift' | 'center';
	/** 原始時間軸上的曲線格，半開區間。模型不可改寫。 */
	from: number;
	to: number;
	center: number;
	spread: number;
	targets: number[];
	defaultTarget: number | null;
	referenceDirection?: 'up' | 'down' | 'none';
}
export interface CorrectionDecision { id: number; targetMidi: number | null }
export type CorrectionStrategy = 'strength' | 'sensitivity';
type CorrectionCurveView = Pick<Curves, 'length' | 'pitch' | 'timeMap'>;

const median = (values: number[]) => {
	const a = [...values].sort((x, y) => x - y);
	return a[Math.floor(a.length / 2)];
};

/** 使用目前編輯後音高，以短視窗中位數與遲滯分音，低可信度格由 voiced 排除。 */
export function correctionNotes(curves: CorrectionCurveView, midi: Float32Array, voiced: Uint8Array, key: KeySignature,
	range: { start: number; end: number }): CorrectionNote[] {
	const from = Math.max(0, Math.ceil(curves.timeMap.outToSrc(range.start) / CURVE_HOP_SEC));
	const to = Math.min(curves.length, midi.length, voiced.length, Math.ceil(curves.timeMap.outToSrc(range.end) / CURVE_HOP_SEC));
	const points: { frame: number; value: number }[] = [];
	for (let i = from; i < to; i += CURVE_SUB) {
		if (!voiced[i] || !Number.isFinite(midi[i])) { points.push({ frame: i, value: NaN }); continue; }
		const local: number[] = [];
		for (let j = Math.max(from, i - 2 * CURVE_SUB); j < Math.min(to, i + 3 * CURVE_SUB); j += CURVE_SUB) {
			if (voiced[j] && Number.isFinite(midi[j] + curves.pitch[j])) local.push(midi[j] + curves.pitch[j]);
		}
		points.push({ frame: i, value: median(local) });
	}
	const notes: CorrectionNote[] = [];
	let start = 0;
	const emit = (end: number) => {
		if (end - start < 6) return; // 少於約 96ms 的音符／過渡先不修正。
		const nearestKeyTarget = (value: number): number | null => {
			let best: number | null = null, distance = Infinity;
			for (let n = Math.max(0, Math.floor(value) - 2); n <= Math.min(127, Math.ceil(value) + 2); n++) {
				if (!isInKey(n, key)) continue;
				const nextDistance = Math.abs(n - value);
				if (nextDistance < distance || (nextDistance === distance && (best === null || n < best))) {
					best = n; distance = nextDistance;
				}
			}
			return best;
		};
		const addSegment = (segmentStart: number, segmentEnd: number) => {
			if (segmentEnd - segmentStart < 6) return; // 至少約 96ms 的連續偏離。
			const segmentValues = points.slice(segmentStart, segmentEnd).map(point => point.value).filter(Number.isFinite);
			if (segmentValues.length < 6) return;
			const ordered = [...segmentValues].sort((a, b) => a - b);
			const center = median(ordered);
			const spread = ordered[Math.floor((ordered.length - 1) * .9)] - ordered[Math.floor((ordered.length - 1) * .1)];
			if (!Number.isFinite(center) || spread > .9) return; // 保留長音內的穩定偏離，排除滑音。
			const targets: number[] = [];
			for (let n = Math.max(0, Math.ceil(center - 1.5)); n <= Math.min(127, Math.floor(center + 1.5)); n++) {
				if (isInKey(n, key)) targets.push(n);
			}
			targets.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
			const defaultTarget = nearestKeyTarget(center);
			if (!targets.length || defaultTarget === null) return;
			const ambiguous = targets.length > 1 && Math.abs(targets[1] - center) - Math.abs(targets[0] - center) < .15;
			notes.push({ id: notes.length, from: points[segmentStart].frame,
				to: Math.min(to, points[segmentEnd - 1].frame + CURVE_SUB), center, spread, targets,
				defaultTarget: ambiguous ? null : defaultTarget });
		};
			let segmentStart = -1, segmentSign = 0;
		for (let i = start; i <= end; i++) {
			const value = i < end ? points[i].value : NaN;
			const target = Number.isFinite(value) ? nearestKeyTarget(value) : null;
			const error = target === null ? 0 : value - target;
				const errorSign = Math.sign(error);
				if (segmentSign !== 0 && errorSign === segmentSign && Math.abs(error) >= .12) continue;
				if (segmentStart >= 0) addSegment(segmentStart, i);
				if (Math.abs(error) >= .25) { segmentStart = i; segmentSign = errorSign; }
				else { segmentStart = -1; segmentSign = 0; }
		}
	};
	while (start < points.length) {
		if (!Number.isFinite(points[start].value)) { start++; continue; }
		let end = start + 1;
		const anchor = Math.round(points[start].value);
		while (end < points.length && Number.isFinite(points[end].value)) {
			// 至少連續三格跨過遲滯門檻，才視為換音，避免顫音逐格跳音。
			if (end + 2 < points.length && [0, 1, 2].every(k =>
				Number.isFinite(points[end + k].value) && Math.abs(points[end + k].value - anchor) > .7)) break;
			end++;
		}
		emit(end); start = end;
	}
	return notes;
}

export function validateDecisions(value: unknown, notes: CorrectionNote[], key: KeySignature): CorrectionDecision[] {
	const decisions = (value as { decisions?: unknown })?.decisions;
	if (!Array.isArray(decisions) || decisions.length !== notes.length) throw new Error('AI 回覆的音符數量不正確，未套用修正');
	const ids = new Set<number>();
	const byId = new Map(notes.map(note => [note.id, note]));
	return decisions.map(item => {
		if (!item || !Number.isInteger(item.id) || ids.has(item.id)) throw new Error('AI 回覆含重複或無效音符，未套用修正');
		const note = byId.get(item.id);
		if (!note || (item.targetMidi !== null && (!Number.isInteger(item.targetMidi) || !note.targets.includes(item.targetMidi) || !isInKey(item.targetMidi, key)))) {
			throw new Error('AI 建議超出允許的調內音，未套用修正');
		}
		ids.add(item.id);
		return { id: item.id, targetMidi: item.targetMidi };
	});
}

/** 只新增音符中心偏移，不壓平顫音；淡入淡出完全位於檢測範圍內。 */
export function applyCorrection(base: Curves, notes: CorrectionNote[], decisions: CorrectionDecision[],
	key: KeySignature, level: number, voiced: Uint8Array, strategy: CorrectionStrategy = 'strength',
	formantFollow = 0): { curves: Curves; count: number } {
	if (!Number.isInteger(level) || level < 1 || level > 10) throw new Error('修正程度必須為 1～10 級');
	const checked = validateDecisions({ decisions }, notes, key);
	const byId = new Map(notes.map(note => [note.id, note]));
	const out = base.clone();
	let count = 0;
	for (const decision of checked) {
		const note = byId.get(decision.id)!;
		if (decision.targetMidi === null) continue;
		const error = decision.targetMidi - note.center;
		// 傳統模式的時間資格已於候選選取階段判斷；入選後完整修正中心。
		const delta = strategy === 'sensitivity' ? error : error * level / 10;
		if (Math.abs(delta) < .005) continue;
		count++;
		const fade = Math.max(1, Math.min(Math.round(.03 / CURVE_HOP_SEC), Math.floor((note.to - note.from) / 4)));
		const maxStep = base.pitchSlopeLimit > 0 ? base.pitchSlopeLimit * CURVE_HOP_SEC : Infinity;
		for (let i = note.from; i < note.to; i++) {
			if (!voiced[i]) continue;
			const edge = Math.min(i - note.from, note.to - 1 - i);
			const weight = .5 - .5 * Math.cos(Math.PI * Math.min(1, edge / fade));
			const amount = Math.sign(delta) * Math.min(Math.abs(delta) * weight, edge * maxStep);
			out.pitch[i] = base.pitch[i] + amount;
			// 引擎最後的音色位移 = formant 曲線 + formantFollow × pitch。
			// 用反向補償抵銷這次 AI 移調，讓修正後的共振峰維持在原始位置。
			out.formant[i] = base.formant[i] - formantFollow * amount;
		}
	}
	return { curves: out, count };
}
