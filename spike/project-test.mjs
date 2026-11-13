import assert from 'node:assert/strict';
import { Curves } from '../src/model/curves.ts';
import { deserialize, inspectProject, serialize } from '../src/model/project.ts';

const curves = new Curves(1000);
curves.pitch[20] = .25;
const audioPath = '/Users/test/Music/song.wav';
const text = serialize(curves, 'song.wav', audioPath, 48000, 2, 0);
const metadata = inspectProject(text);
assert.deepEqual(metadata, { version: 6, audioName: 'song.wav', audioPath, audioWritebackPath:audioPath, sampleRate: 48000, duration: 2 });
assert.equal(deserialize(text, 48000, 125).curves.pitch[20], .25);

const multiAnchorText = serialize(curves, 'song.wav', audioPath, 48000, 2, 0, {
	name: 'reference.wav', gainDb: 0, muted: false, offsetSec: 0,
	beatAnchorSec: 3, beatAnchorSecs: [1, 3], tempoTolerancePercent: 8,
	instrumentProfile:'melody',
	onsetProminenceThreshold: 0.75, beatConfirmationThreshold: 0.62,
});
assert.deepEqual(deserialize(multiAnchorText, 48000, 125).background?.beatAnchorSecs, [1, 3]);
assert.equal(deserialize(multiAnchorText, 48000, 125).background?.tempoTolerancePercent, 8);
assert.equal(deserialize(multiAnchorText,48000,125).background?.instrumentProfile,'melody');
assert.equal(deserialize(multiAnchorText, 48000, 125).background?.onsetProminenceThreshold, 0.75);
assert.equal(deserialize(multiAnchorText, 48000, 125).background?.beatConfirmationThreshold, 0.62);

const region={id:7,from:10,to:12,kind:'center',enabled:true,edited:false,offset:0,formantOffset:0,
	original:new Float32Array([0,0]),ai:new Float32Array([.2,.2]),adjusted:new Float32Array([.2,.2]),
	originalFormant:new Float32Array([0,0]),aiFormant:new Float32Array([0,0]),adjustedFormant:new Float32Array([0,0]),recordId:'record-7'};
const inspectionText=serialize(curves,'song.wav',audioPath,48000,2,0,{name:'reference.wav',gainDb:0,muted:false,offsetSec:0,
	beatRecords:[{timeSec:.5,beatInBar:1,firstBeatSec:.5,pitchClasses:[0,4,7],pitchNames:['C','E','G'],chord:'Am',originalChord:'C',chordEdited:true,chordConfidence:'high'}]},
	{detectionRange:{start:.25,end:1.25},aiRegions:[region]},audioPath);
const restored=deserialize(inspectionText,48000,125);
assert.equal(restored.inspection.aiRegions[0].id,7);assert.ok(restored.inspection.aiRegions[0].ai instanceof Float32Array);
assert.deepEqual(restored.inspection.detectionRange,{start:.25,end:1.25});
assert.equal(restored.background.beatRecords[0].chord,'Am');assert.equal(restored.background.beatRecords[0].originalChord,'C');assert.equal(restored.background.beatRecords[0].chordEdited,true);
assert.equal(inspectProject(inspectionText).audioWritebackPath,audioPath);

const backedUpText=serialize(curves,'song.wav','/Users/test/Music/song.wipitch-original.wav',48000,2,0,
	undefined,undefined,audioPath);
assert.equal(inspectProject(backedUpText).audioWritebackPath,audioPath);
const unrelated=JSON.parse(text);unrelated.audioWritebackPath='/Users/test/Music/other.wav';
assert.throws(()=>inspectProject(JSON.stringify(unrelated)),/回存音訊路徑與來源檔案不相符/);
for(const field of ['pitch','gainDb','formant']){
	const damaged=JSON.parse(text);delete damaged[field];
	assert.throws(()=>deserialize(JSON.stringify(damaged),48000,125),new RegExp(`缺少 ${field} 曲線`));
	const truncated=JSON.parse(text);truncated[field]=truncated[field].slice(8);
	assert.throws(()=>deserialize(JSON.stringify(truncated),48000,125),new RegExp(`${field} 曲線長度不完整`));
}

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
console.log('project: v6 detection regions, beat/chord data, writeback path, legacy compatibility and invalid-path rejection passed');
