import assert from 'node:assert/strict';
import { AICorrectionFlow } from '../src/application/ai-correction-flow.ts';
import { WorkState } from '../src/application/work-state.ts';
import { Curves } from '../src/model/curves.ts';
import { KEY_OPTIONS } from '../src/model/keys.ts';
import { chordPitchClasses } from '../src/model/reference-harmony.ts';

assert.deepEqual(chordPitchClasses('F#m'),[6,9,1]);
assert.deepEqual(chordPitchClasses('Bb'),[10,2,5]);
assert.deepEqual(chordPitchClasses('C#maj7'),chordPitchClasses('C♯maj7'));
assert.deepEqual(chordPitchClasses('Cadd9'),[0,2,4,7]);
assert.deepEqual(chordPitchClasses('Cfoo'),[]);
assert.deepEqual(chordPitchClasses('H7'),[]);

async function run(referenceRhythm, provider = 'rules', reject = false) {
 const base = new Curves(2000);
 let committed;
 const candidates = [
  { id: 0, from: 300, to: 600, center: 62.4, spread: 0, targets: [62, 64], defaultTarget: 62 },
  { id: 1, from: 800, to: 1100, center: 62.4, spread: 0, targets: [62, 64], defaultTarget: 62 },
 ];
 const flow = new AICorrectionFlow({
  workState: new WorkState(), pausePlayback() {},
  sameCurves: (a, b) => a.pitch.every((v, i) => v === b.pitch[i]),
  render: async () => {}, pushHistory() {}, commitCurves: c => { committed = c; },
  updatePlayback() {}, scheduleBackground() {}, collectNotes: async () => candidates,
  suggest: async (_s, notes, _k, _signal, _progress, _fetch, rhythm) => {
   assert.equal(rhythm, undefined, 'candidate decisions must not receive reference harmony');
   assert.ok(notes.every(n => !n.referenceDirection));
   return notes.map(n => ({ id: n.id, targetMidi: reject || provider !== 'rules' && n.id === 1 ? null : n.defaultTarget }));
  },
 });
 const result = await flow.run({ curves: base, midi: new Float32Array(2000).fill(62.4),
  voiced: new Uint8Array(2000).fill(1), key: KEY_OPTIONS.find(k => k.id === 'major-0'),
  range: { start: .5, end: 2.5 }, level: 5,
  settings: { provider, baseUrl: '', model: '', apiKey: '' }, referenceRhythm }, () => {});
 return { result, committed };
}
const harmony = { bpm: 120, meter: '4/4', anchorSec: .5, barStartsSec: [.5],
 beatHarmony: [{ timeSec: .5, chord: 'E', pitchClasses: [4, 8, 11], pitchNames: ['E', 'A♭', 'B'] }] };
for (const provider of ['rules', 'builtin-ai', 'ollama']) {
 const baseline = await run(undefined, provider);
 const referenced = await run(harmony, provider);
 assert.equal(baseline.result.status, 'completed');
 assert.equal(referenced.result.status, 'completed');
 assert.deepEqual(referenced.result.regions, baseline.result.regions, 'yellow frames stay identical');
 assert.equal(referenced.result.count, baseline.result.count);
 assert.ok(baseline.committed.pitch[400] < 0);
 assert.ok(referenced.committed.pitch[400] > 0, 'harmony can change direction inside an accepted frame');
 for (let i = 0; i < 2000; i++) {
  if (!baseline.result.regions.some(n => i >= n.from && i < n.to)) {
   assert.equal(referenced.committed.pitch[i], 0, 'no edits outside original frames');
  }
 }
 assert.equal((await run(harmony, provider, true)).result.status, 'unchanged', 'harmony cannot revive rejected notes');
 const empty = await run({ ...harmony, beatHarmony: [] }, provider);
 assert.deepEqual(empty.committed.pitch, baseline.committed.pitch);
}
console.log('PASS: reference harmony preserves AI-selected frames, rejected notes, gaps and range boundaries');
