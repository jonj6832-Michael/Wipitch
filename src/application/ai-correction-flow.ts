import { selectRuleNotes } from '../model/rule-selection';
import { contextCorrectionNotes } from '../model/context-correction';
import type { ReferenceRhythm } from '../analysis/reference-cache';
import { applyCorrection, type CorrectionNote } from '../model/auto-pitch';
import { suggestCorrections, type AISettings } from '../analysis/ai-correction';
import { CURVE_HOP_SEC, type Curves } from '../model/curves';
import type { KeySignature } from '../model/keys';
import type { WorkState } from './work-state';
import { applyReferenceHarmony } from '../model/reference-harmony';

export interface CorrectionInput {
	curves: Curves;
	midi: Float32Array;
	voiced: Uint8Array;
	key: KeySignature;
	/** 輸出時間軸上的獨立檢測範圍。 */
	range: { start: number; end: number };
	/** 低音壓切開的分析工作段；未提供時沿用單一 range。 */
	segments?: { start: number; end: number }[];
	level: number;
	settings: AISettings;
	referenceRhythm?: ReferenceRhythm;
	/** 0 = 引擎已保留原音色；大於 0 時 AI 以反向 Formant 曲線抵銷移調造成的音色位移。 */
	formantFollow?: number;
}

export interface CorrectionUpdate {
	message: string;
	label: string;
	fraction?: number;
	cancellable: boolean;
}

export type CorrectionOutcome =
	| { status: 'completed'; count: number; input: CorrectionInput; regions: CorrectionNote[]; segmentCount: number }
	| { status: 'unchanged' }
	| { status: 'cancelled' | 'failed'; message: string }
	| { status: 'busy' };

export interface CorrectionDependencies {
	workState: WorkState;
	pausePlayback(): void;
	sameCurves(before: Curves, after: Curves): boolean;
	render(curves: Curves, range: CorrectionInput['range']): Promise<void>;
	pushHistory(before: Curves): void;
	commitCurves(curves: Curves): void;
	updatePlayback(): void;
	scheduleBackground(range: CorrectionInput['range']): void;
	suggest?: typeof suggestCorrections;
	collectNotes?(input: CorrectionInput, ranges: { start: number; end: number }[], signal: AbortSignal,
		progress: (done: number, total: number) => void): Promise<CorrectionNote[]>;
}

/** 不依賴 DOM；統一控制取消、算繪成功後提交與工作鎖定。 */
export class AICorrectionFlow {
	private controller: AbortController | null = null;
	private cancellable = false;
	constructor(private dependencies: CorrectionDependencies) {}
	get running() { return this.dependencies.workState.has('ai'); }

	cancel(): boolean {
		if (!this.controller || !this.cancellable) return false;
		this.cancellable = false;
		this.controller.abort();
		return true;
	}

	async run(input: CorrectionInput, report: (update: CorrectionUpdate) => void): Promise<CorrectionOutcome> {
		const task = this.dependencies.workState.tryBegin('ai', '準備修正音符');
		if (!task) return { status: 'busy' };
		let finishLabel = '音高修正完成，可逐框審核或取消整次 AI 修改';
		let failed = false;
		const notify = (update: CorrectionUpdate) => {
			task.update(update.label, update.fraction ?? null);
			report(update);
		};
		const controller = this.controller = new AbortController();
		const d = this.dependencies;
		this.cancellable = true;
		try {
			d.pausePlayback();
			// 開始時固定設定與曲線；服務等待期間不重新讀取 UI。
			const snapshot = { ...input, curves: input.curves.clone(), range: { ...input.range },
				segments: input.segments?.map(segment => ({ ...segment })), settings: { ...input.settings } };
			const { curves: before, midi, voiced, key, range, level, settings } = snapshot;
			if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) throw new Error('請先設定有效的檢測範圍');
			const ranges = snapshot.segments?.length ? snapshot.segments : [range];
			if (ranges.some(segment => !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
				|| segment.start < range.start - 1e-6 || segment.end > range.end + 1e-6 || segment.end <= segment.start)) {
				throw new Error('AI 音訊分段超出檢測範圍');
			}
			notify({ message: `整理 ${ranges.length} 個低音壓分段內的穩定音符…`, label: '平行分析修正候選', fraction: 0, cancellable: true });
			let notes: CorrectionNote[];
			if (d.collectNotes) {
				notes = await d.collectNotes(snapshot, ranges, controller.signal, (done, total) => {
					notify({ message: `平行分析 ${done} / ${total} 段`, label: '平行分析修正候選', fraction: total ? done / total : 0, cancellable: true });
				});
			} else {
				notes = ranges.flatMap(segment => contextCorrectionNotes(before, midi, voiced, key, segment))
					.sort((a, b) => a.from - b.from).map((note, id) => ({ ...note, id }));
			}
			if (controller.signal.aborted) throw new Error('AI 修正已取消，未套用變更');
			if (!notes.length) {
				const hasVoiced = ranges.some(segment => {
					const from = Math.max(0, Math.ceil(before.timeMap.outToSrc(segment.start) / CURVE_HOP_SEC));
					const to = Math.min(midi.length, voiced.length, Math.ceil(before.timeMap.outToSrc(segment.end) / CURVE_HOP_SEC));
					for (let i = from; i < to; i++) if (voiced[i] && Number.isFinite(midi[i])) return true;
					return false;
				});
				if (hasVoiced) { finishLabel = '沒有足夠可靠且需要修正的候選，保留原音'; return { status: 'unchanged' }; }
				throw new Error('檢測範圍內沒有足夠可靠的修正候選；缺少穩定參考的起音及不確定段落會保留');
			}
			if (settings.provider === 'rules') {
				notes = selectRuleNotes(before, notes, midi, voiced, level);
				if (!notes.length) { finishLabel = '沒有符合持續時間的偏離區段'; return { status: 'unchanged' }; }
			}
			const decisions = await (d.suggest ?? suggestCorrections)(settings, notes, key, controller.signal, (done, total) => {
				notify({ message: `AI 建議 ${done} / ${total} 批（${notes.length} 個音符）`, label: 'AI 分析音符摘要', fraction: total ? done / total : 0, cancellable: !controller.signal.aborted });
			}, fetch);
			if (controller.signal.aborted) throw new Error('AI 修正已取消，未套用變更');
			let result = applyCorrection(before, notes, decisions, key, level, voiced,
				settings.provider === 'rules' ? 'sensitivity' : 'strength', snapshot.formantFollow ?? 0);
			if (!result.count || d.sameCurves(before, result.curves)) { finishLabel = '沒有套用修正'; return { status: 'unchanged' }; }
			// 黃框完全由原本 AI 結果決定；參考和弦只能改變已入選框內的目標。
			const regions = notes.filter(n => {
				for (let i = n.from; i < n.to; i++) if (result.curves.pitch[i] !== before.pitch[i]) return true;
				return false;
			});
			const directed = applyReferenceHarmony(regions, before, snapshot.referenceRhythm);
			for (const note of directed) {
				if (!note.referenceDirection || note.referenceDirection === 'none') continue;
				const adjusted = applyCorrection(before, [note], [{ id: note.id, targetMidi: note.defaultTarget }],
					key, level, voiced, settings.provider === 'rules' ? 'sensitivity' : 'strength', snapshot.formantFollow ?? 0);
				// 無有效替代修正時保留原本結果，不能讓參考和弦消除黃框。
				if (!adjusted.count || !adjusted.curves.pitch.subarray(note.from, note.to)
					.some((value, index) => value !== before.pitch[note.from + index])) continue;
				result.curves.pitch.set(adjusted.curves.pitch.subarray(note.from, note.to), note.from);
				result.curves.formant.set(adjusted.curves.formant.subarray(note.from, note.to), note.from);
			}
			this.cancellable = false;
			notify({ message: '正在套用修正音訊…', label: '算繪修正音訊', cancellable: false });
			await d.render(result.curves, range);
			d.pushHistory(before);
			d.commitCurves(result.curves);
			d.updatePlayback();
			d.scheduleBackground(range);
			return { status: 'completed', count: result.count, input: snapshot, segmentCount: ranges.length,
				regions };
		} catch (error) {
			failed = !controller.signal.aborted;
			finishLabel = controller.signal.aborted ? 'AI 修正已取消，未套用變更' : error instanceof Error ? error.message : '修正失敗';
			return { status: failed ? 'failed' : 'cancelled', message: finishLabel };
		} finally {
			this.controller = null;
			this.cancellable = false;
			task.finish(finishLabel, failed);
		}
	}
}
