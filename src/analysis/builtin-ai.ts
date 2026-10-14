import type { CorrectionDecision, CorrectionNote } from '../model/auto-pitch';
import { CURVE_HOP_SEC } from '../model/curves';

export interface BuiltinAIExample {
	duration: number;
	spread: number;
	targetDelta: number;
	kind: 'onset' | 'drift' | 'center';
	accepted: boolean;
	strength: number;
	weight: number;
}
export interface BuiltinAIModel {
	schemaVersion: 1;
	trainerVersion: number;
	sourceFingerprint: string;
	trainedAt: string;
	counts: { manual: number; rejected: number; adjusted: number; excluded: number; invalid: number; used: number };
	examples: BuiltinAIExample[];
}
export interface BuiltinAIUpdate { updated: boolean; model: BuiltinAIModel }

let activeModel: BuiltinAIModel | null = null;

export async function updateBuiltinAIModel(fetcher: typeof fetch = fetch): Promise<BuiltinAIUpdate> {
	const config = await fetcher('/__training/config');
	if (!config.ok) throw new Error('內建 AI 只能在本機啟動服務中更新');
	const { token } = await config.json();
	const response = await fetcher('/__training/model', {
		method: 'POST', credentials: 'same-origin',
		headers: { 'Content-Type': 'application/json', 'X-Training-Token': token }, body: '{}',
	});
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || '內建 AI 模型更新失敗');
	if (result.model?.schemaVersion !== 1 || !Array.isArray(result.model.examples)) throw new Error('內建 AI 模型格式不正確');
	if (result.model.examples.length < 10) throw new Error(`可用訓練資料只有 ${result.model.examples.length} 筆，至少需要 10 筆`);
	activeModel = result.model;
	return result;
}

export function setBuiltinAIModelForTest(model: BuiltinAIModel | null) { activeModel = model; }

function distance(note: CorrectionNote, target: number, example: BuiltinAIExample) {
	const duration = Math.max(CURVE_HOP_SEC, (note.to - note.from) * CURVE_HOP_SEC);
	const kind = note.kind ?? 'center';
	return Math.abs(Math.log(duration / Math.max(.002, example.duration))) / 1.2
		+ Math.abs(note.spread - example.spread) / .6
		+ Math.abs((target - note.center) - example.targetDelta) / .45
		+ (kind === example.kind ? 0 : .75);
}

/** 小型近鄰模型只選擇已允許的調內目標或不修正，不能改寫範圍與曲線。 */
export function builtinAIDecisions(notes: CorrectionNote[]): CorrectionDecision[] {
	if (!activeModel) throw new Error('內建 AI 模型尚未完成更新');
	return notes.map(note => {
		let best: { target: number; confidence: number; evidence: number } | null = null;
		for (const target of note.targets) {
			const neighbors = activeModel!.examples.map(example => ({ example, distance: distance(note, target, example) }))
				.sort((a, b) => a.distance - b.distance).slice(0, 24);
			let accepted = 0, rejected = 0;
			for (const neighbor of neighbors) {
				const vote = Math.exp(-neighbor.distance * neighbor.distance) * neighbor.example.weight;
				if (neighbor.example.accepted) accepted += vote; else rejected += vote;
			}
			const evidence = accepted + rejected;
			const confidence = evidence ? accepted / evidence : 0;
			if (!best || confidence > best.confidence || (confidence === best.confidence && Math.abs(target - note.center) < Math.abs(best.target - note.center))) {
				best = { target, confidence, evidence };
			}
		}
		return { id: note.id, targetMidi: best && best.evidence >= .05 && best.confidence >= .55 ? best.target : null };
	});
}
