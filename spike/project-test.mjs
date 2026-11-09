import assert from 'node:assert/strict';
import { Curves } from '../src/model/curves.ts';
import { deserialize, inspectProject, serialize } from '../src/model/project.ts';

const curves = new Curves(1000);
curves.pitch[20] = .25;
const audioPath = '/Users/test/Music/song.wav';
const text = serialize(curves, 'song.wav', audioPath, 48000, 2, 0);
const metadata = inspectProject(text);
assert.deepEqual(metadata, { version: 5, audioName: 'song.wav', audioPath, sampleRate: 48000, duration: 2 });
assert.equal(deserialize(text, 48000, 125).curves.pitch[20], .25);

const multiAnchorText = serialize(curves, 'song.wav', audioPath, 48000, 2, 0, {
	name: 'reference.wav', gainDb: 0, muted: false, offsetSec: 0,
	beatAnchorSec: 3, beatAnchorSecs: [1, 3], tempoTolerancePercent: 8,
	onsetProminenceThreshold: 0.75, beatConfirmationThreshold: 0.62,
});
assert.deepEqual(deserialize(multiAnchorText, 48000, 125).background?.beatAnchorSecs, [1, 3]);
assert.equal(deserialize(multiAnchorText, 48000, 125).background?.tempoTolerancePercent, 8);
assert.equal(deserialize(multiAnchorText, 48000, 125).background?.onsetProminenceThreshold, 0.75);
assert.equal(deserialize(multiAnchorText, 48000, 125).background?.beatConfirmationThreshold, 0.62);

const legacyData = JSON.parse(text);
legacyData.version = 4;
delete legacyData.audioPath;
const legacyText = JSON.stringify(legacyData);
assert.equal(inspectProject(legacyText).audioPath, undefined);
assert.equal(deserialize(legacyText, 48000, 125).curves.pitch[20], .25);

const invalid = { ...legacyData, version: 5, audioPath: 'relative/song.wav' };
assert.throws(() => inspectProject(JSON.stringify(invalid)), /絕對路徑無效/);
const missing = { ...legacyData, version: 5 };
assert.throws(() => inspectProject(JSON.stringify(missing)), /缺少原始音訊的絕對路徑/);
console.log('project: v5 absolute audio path, settings restore, legacy compatibility and invalid-path rejection passed');
