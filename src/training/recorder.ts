import { Curves, CURVE_HOP_SEC } from '../model/curves';
import { encodeWav24 } from '../audio/wav';
import { pitchDeviation } from '../model/pitch-deviation';
import type { KeySignature } from '../model/keys';
import type { Samples } from '../types';

const base64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
 const reader = new FileReader(); reader.onerror = () => reject(reader.error);
 reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(blob);
});
export function pitchPoints(curves: Curves, midi: Float32Array, voiced: Uint8Array, start: number, end: number) {
 const points: { time: number; sourceTime: number; midi: number | null; offset: number }[] = [];
 for (let t = start; t < end; t += CURVE_HOP_SEC) {
  const sourceTime = curves.timeMap.outToSrc(t), i = Curves.timeToFrame(sourceTime);
  points.push({ time: t, sourceTime, midi: voiced[i] && Number.isFinite(midi[i]) ? midi[i] + curves.pitch[i] : null, offset: curves.pitch[i] ?? 0 });
 }
 return points;
}
type Points = ReturnType<typeof pitchPoints>;
export function compactImageLayout(before: Points, after: Points, start: number, end: number) {
 const changed = after.filter((p, i) => p.midi !== null && before[i]?.midi !== null && Math.abs(p.offset - (before[i]?.offset ?? p.offset)) > 1e-6);
 const from = start;
 const to = end;
 const values = [...before, ...after].filter(p => p.time >= from && p.time <= to && p.midi !== null).map(p => p.midi!);
 const lo = values.length ? Math.floor(values.reduce((a, b) => Math.min(a, b), Infinity)) - 1 : 59;
 const hi = values.length ? Math.ceil(values.reduce((a, b) => Math.max(a, b), -Infinity)) + 1 : 61;
 const width = Math.max(64, Math.min(480, Math.ceil((to - from) * 160)));
 const height = Math.max(48, Math.min(256, (hi - lo) * 12 + 8));
 const y = (m: number) => 4 + (hi - m) / (hi - lo) * (height - 8);
 return { width, height, start: from, end: to, midiMin: lo, midiMax: hi,
  plot: { left: 4, right: width - 4, top: 4, bottom: height - 4 },
  hasVisibleChange: changed.length > 0,
  rows: Array.from({ length: hi - lo + 1 }, (_, i) => {
   const midi = hi - i;
   const pitchClass = ((midi % 12) + 12) % 12;
   return { midi, note: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][pitchClass] + (Math.floor(midi / 12) - 1),
    frequencyHz: 440 * 2 ** ((midi - 69) / 12), y: y(midi) };
  }),
  colors: { before: '#9299a3', near: '#66c9ec', sharp: '#ef6666', flat: '#60ce91' },
  description: 'Full edit range with three-second context on both sides; gray before, colored after; axes in metadata',
 };
}
function picture(before: Points, after: Points, layout: ReturnType<typeof compactImageLayout>, key: KeySignature | null) {
 const { width, height, start, end, midiMin: lo, midiMax: hi, colors } = layout;
 const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
 const c = canvas.getContext('2d')!;
 c.fillStyle = '#13171e'; c.fillRect(0, 0, width, height);
 const x = (t: number) => 4 + (t - start) / (end - start) * (width - 8);
 const y = (m: number) => 4 + (hi - m) / (hi - lo) * (height - 8);
 for (const row of layout.rows) {
  c.strokeStyle = '#303640'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(4, row.y); c.lineTo(width - 4, row.y); c.stroke();
 }
 for (const [points, original] of [[before, true], [after, false]] as const) {
  c.lineWidth = original ? 2 : 1.5;
  for (let i = 1; i < points.length; i++) {
   const a = points[i - 1], b = points[i];
   if (a.midi === null || b.midi === null || a.time < start || b.time > end) continue;
   const direction = pitchDeviation(b.midi, key)?.direction ?? 'near';
   c.strokeStyle = original ? colors.before : colors[direction];
   c.beginPath(); c.moveTo(x(a.time), y(a.midi)); c.lineTo(x(b.time), y(b.midi)); c.stroke();
  }
 }
 return canvas.toDataURL('image/png').split(',')[1];
}
export async function prepareTrainingPair(input: {
 before: Curves; after: Curves; beforeAudio: Samples[]; afterAudio: Samples[];
 midi: Float32Array; voiced: Uint8Array; start: number; end: number; sampleRate: number;
 key: KeySignature | null; metadata: Record<string, unknown>;
}) {
 const { start, end, key } = input;
 const before = pitchPoints(input.before, input.midi, input.voiced, start, end);
 const after = pitchPoints(input.after, input.midi, input.voiced, start, end);
 const layout = compactImageLayout(before, after, start, end);
 const payload = {
  metadata: { schemaVersion: 3, ...input.metadata, recordId: String(crypto.randomUUID()), createdAt: new Date().toISOString(), kind: 'manual-pitch', approval: 'unreviewed',
   clip: { start, end, duration: end - start }, sampleRate: input.sampleRate, key: key ?? null,
   image: layout,
   beforePoints: before, afterPoints: after },
  overlayPng: picture(before, after, layout, key),
  beforeWav: await base64(encodeWav24(input.beforeAudio, input.sampleRate)),
  afterWav: await base64(encodeWav24(input.afterAudio, input.sampleRate)),
 };
 return payload;
}

export type TrainingPair = Awaited<ReturnType<typeof prepareTrainingPair>>;
async function trainingRequest(action: 'stage' | 'store-rejected' | 'reset' | 'commit', payload: unknown) {
 const config = await fetch('/__training/config'); if (!config.ok) throw new Error('請使用本機啟動檔執行訓練記錄');
 const { token } = await config.json();
 const response = await fetch(`/__training/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Training-Token': token }, body: JSON.stringify(payload) });
 const result = await response.json(); if (!response.ok) throw new Error(result.error || '儲存失敗');
 return result;
}
export async function stageTrainingPair(payload: TrainingPair): Promise<string> {
 return (await trainingRequest('stage', payload)).id;
}
/** 取消 AI 修正屬於明確負例，按下「取消AI修正標示」時直接保存至正式資料庫。 */
export async function storeRejectedTrainingPair(payload: TrainingPair): Promise<string> {
 return (await trainingRequest('store-rejected', payload)).id;
}
export async function resetTrainingStaging(assetId: string): Promise<void> {
 await trainingRequest('reset', { assetId });
}
export interface TrainingCommitResult { count:number; categories:{ manual:number; adjusted:number; rejected:number } }
export async function commitTrainingStaging(assetId: string): Promise<TrainingCommitResult> {
 const result=await trainingRequest('commit', { assetId });
 return { count:Number(result.count)||0, categories:{ manual:Number(result.categories?.manual)||0, adjusted:Number(result.categories?.adjusted)||0, rejected:Number(result.categories?.rejected)||0 } };
}
