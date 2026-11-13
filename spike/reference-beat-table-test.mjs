import assert from 'node:assert/strict';
import { clearReferenceBeatsInRange, hasReferenceBeatsInRange, mergeReferenceBeats, referenceBeatInRange, referenceRhythmForRange } from '../src/model/reference-beat-table.ts';

const rows = [
	{ timeSec: 1, beatInBar: 1, firstBeatSec: 1, chord: 'C' },
	{ timeSec: 2, beatInBar: 2, firstBeatSec: 1 },
	{ timeSec: 3, beatInBar: 3, firstBeatSec: 1 },
];
assert.equal(referenceBeatInRange(1, { start: 1, end: 3 }), true);
assert.equal(referenceBeatInRange(3, { start: 1, end: 3 }), false, 'end boundary belongs to the adjacent range');
assert.equal(hasReferenceBeatsInRange(rows, { start: 1.5, end: 2.5 }), true);
assert.equal(hasReferenceBeatsInRange(rows, { start: 3, end: 4 }), true);
assert.equal(hasReferenceBeatsInRange(rows, { start: 3.1, end: 4 }), false);
assert.deepEqual(clearReferenceBeatsInRange(rows, { start: 1, end: 3 }), [rows[2]], 'clear keeps the end-boundary beat');
assert.equal(clearReferenceBeatsInRange(rows, { start: 0, end: 0 }).length, rows.length, 'empty range changes nothing');
const merged = mergeReferenceBeats([], [1, 3], 120, '4/4', { start: 1, end: 3 });
assert.deepEqual(merged.map(row => row.timeSec), [1, 1.5, 2, 2.5], 'merge excludes the end boundary');
const virtual = mergeReferenceBeats([], [1, 3], 120, '4/4', { start: 1, end: 4 }, [3]);
assert.equal(virtual.find(row => row.timeSec === 3)?.virtual, true, 'missed downbeat is persisted as a virtual marker');
assert.equal(virtual.find(row => row.timeSec === 3.5)?.virtual, false, 'only the virtual downbeat is marked as X');
const confirmed = mergeReferenceBeats(virtual, [1, 3], 120, '4/4', { start: 1, end: 4 });
assert.equal(confirmed.find(row => row.timeSec === 3)?.virtual, false, 'a later confirmed onset removes the old virtual flag');
const snapped = mergeReferenceBeats([], [1, 3], 120, '4/4', { start: 1, end: 3 }, [], [],
	[1, 1.46, 2.04, 2.48], [2.04]);
assert.deepEqual(snapped.map(row => row.timeSec), [1, 1.46, 2.04, 2.48],
	'Librosa per-beat times replace evenly divided interior markers');
assert.deepEqual(snapped.map(row => row.beatInBar), [1, 2, 3, 4]);
assert.equal(snapped.find(row => row.timeSec === 2.04)?.virtual, true,
	'a missed interior onset remains identifiable without moving it back to the grid');
const stored=[{timeSec:1,beatInBar:1,firstBeatSec:1,chord:'F',pitchClasses:[5,9,0],pitchNames:['F','A','C']},
	{timeSec:1.5,beatInBar:2,firstBeatSec:1,chord:'Am',pitchClasses:[9,0,4],pitchNames:['A','C','E']}];
const restoredRhythm=referenceRhythmForRange(stored,{start:1,end:2},120,'4/4',null);
assert.equal(restoredRhythm.beatHarmony[0].chord,'F','stored harmony remains available after transient rhythm state is cleared');
assert.deepEqual(restoredRhythm.beatTimesSec,[1,1.5]);
assert.equal(referenceRhythmForRange(stored,{start:2,end:3},120,'4/4',null),undefined);
console.log('PASS: reference beat overlap, half-open boundaries, clearing and merge containment');
