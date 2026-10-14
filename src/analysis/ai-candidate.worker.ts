import { contextCorrectionNotes } from '../model/context-correction';
import { TimeMap, type Anchor } from '../model/timemap';
import type { KeySignature } from '../model/keys';

type CurveView = {
	length: number;
	pitch: Float32Array;
	timeMap: TimeMap;
};

let curves: CurveView | null = null;
let midi: Float32Array | null = null;
let voiced: Uint8Array | null = null;
let key: KeySignature | null = null;

self.onmessage = (event: MessageEvent) => {
	const data = event.data;
	try {
		if (data.type === 'init') {
			curves = { length: data.pitch.length, pitch: data.pitch, timeMap: new TimeMap(data.anchors as Anchor[]) };
			midi = data.midi;
			voiced = data.voiced;
			key = data.key;
			postMessage({ type: 'ready' });
			return;
		}
		if (data.type !== 'analyse' || !curves || !midi || !voiced || !key) throw new Error('AI 分析 Worker 尚未初始化');
		const notes = contextCorrectionNotes(curves, midi, voiced, key, data.range);
		postMessage({ type: 'result', id: data.id, notes });
	} catch (error) {
		postMessage({ type: 'error', id: data.id, error: error instanceof Error ? error.message : String(error) });
	}
};
