import assert from 'node:assert/strict';
import { KEY_OPTIONS } from '../src/model/keys.ts';
import { pitchDeviation } from '../src/model/pitch-deviation.ts';

const cMajor = KEY_OPTIONS.find(key => key.id === 'major-0');
const gMajor = KEY_OPTIONS.find(key => key.id === 'major-7');
assert.equal(pitchDeviation(60.249, cMajor).direction, 'near');
assert.equal(pitchDeviation(60.25, cMajor).direction, 'sharp');
assert.equal(pitchDeviation(61.75, cMajor).direction, 'flat');
assert.equal(pitchDeviation(61.751, cMajor).direction, 'near');
assert.equal(pitchDeviation(61, cMajor).targetMidi, 60); // 等距固定取較低音
assert.equal(pitchDeviation(66, gMajor).direction, 'near');
assert.equal(pitchDeviation(66, cMajor).direction, 'sharp');
assert.equal(pitchDeviation(60, null), null);
assert.equal(pitchDeviation(NaN, cMajor), null);
assert.equal(pitchDeviation(Infinity, cMajor), null);
for (const key of KEY_OPTIONS) {
	for (const pc of key.pitchClasses) {
		for (const octave of [-2, 0, 5, 10]) {
			assert.equal(pitchDeviation(pc + octave * 12, key).direction, 'near');
		}
	}
}
console.log('PASS: ±25 cent thresholds, nearest scale note, ties, key changes, all 24 keys across octaves');
