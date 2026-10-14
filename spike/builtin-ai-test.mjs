import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { updateBuiltinAIModel } from '../tools/builtin-ai-model.mjs';
import { builtinAIDecisions, setBuiltinAIModelForTest } from '../src/analysis/builtin-ai.ts';

const root = await mkdtemp(path.join(tmpdir(), 'wipitch-model-'));
const points = (midi, offset = 0) => Array.from({ length: 20 }, (_, index) => ({ time: 1 + index * .01, midi, offset }));
async function record(category, before, after, review = null) {
 const asset = randomUUID(), id = randomUUID();
 const categoryPath = category === 'manual' ? [] : ['AI修正調整', category === 'rejected' ? '取消修正' : '人工調整'];
 const dir = path.join(root, ...categoryPath, asset, id); await mkdir(dir, { recursive: true });
 await writeFile(path.join(dir, 'record.json'), JSON.stringify({ editRange: { start: 1, end: 1.2 }, correctionKind: 'onset',
  key: { pitchClasses: [0, 2, 4, 5, 7, 9, 11] }, beforePoints: points(before), afterPoints: points(after) }));
 if (review) await writeFile(path.join(dir, 'review.json'), JSON.stringify({ status: review }));
}
try {
 for (let i = 0; i < 10; i++) await record('manual', 60.35, 60.02);
 await record('rejected', 60.02, 60.35);
 await record('adjusted', 60.3, 60.01);
 await record('manual', 60.4, 60.01, 'excluded');
 const first = await updateBuiltinAIModel(root);
 assert.equal(first.updated, true); assert.deepEqual(first.model.counts, { manual: 11, rejected: 1, adjusted: 1, excluded: 1, invalid: 0, used: 12 });
 assert.equal((await updateBuiltinAIModel(root)).updated, false);
 assert.equal(JSON.parse(await readFile(path.join(root, '模型', '內建AI.json'))).examples.length, 12);
 setBuiltinAIModelForTest(first.model);
 const decisions = builtinAIDecisions([{ id: 0, kind: 'onset', from: 0, to: 100, center: 60.35, spread: 0, targets: [60], defaultTarget: 60 }]);
 assert.deepEqual(decisions, [{ id: 0, targetMidi: 60 }]);
 console.log('builtin AI: scans manual/rejected/adjusted data, honors exclusion, caches fingerprint, returns an allowed target');
} finally { setBuiltinAIModelForTest(null); await rm(root, { recursive: true, force: true }); }
