import assert from 'node:assert/strict';
import { planPitchAnalysisSegments, mergePitchSegments, PITCH_CONTEXT_SAMPLES } from '../src/analysis/pitch-segments.ts';
import { HOP, SR } from '../src/analysis/swiftf0.ts';

const audio = new Float32Array(130 * SR).fill(1);
// 候選區間內完整一秒靜音；切點必須落在該秒正中央，而非靜音起點。
audio.fill(0, 38 * SR, 39 * SR);
audio.fill(0, 86 * SR, 87 * SR);
const segments = planPitchAnalysisSegments(audio, 3);
assert.equal(segments.length, 3);
assert.equal(segments[0].coreFrom, 0);
assert.ok(Math.abs(segments[0].coreTo / SR - 38.5) <= HOP / SR, segments[0].coreTo / SR);
assert.ok(Math.abs(segments[1].coreTo / SR - 86.5) <= HOP / SR, segments[1].coreTo / SR);
assert.equal(segments.at(-1).coreTo, audio.length);
for (let i = 0; i < segments.length; i++) {
	const segment = segments[i];
	assert.equal(segment.coreFrom % HOP, 0);
	if (i + 1 < segments.length) assert.equal(segment.coreTo, segments[i + 1].coreFrom);
	assert.equal(segment.coreFrom - segment.readFrom, i === 0 ? 0 : PITCH_CONTEXT_SAMPLES);
	assert.equal(segment.readTo - segment.coreTo, i === segments.length - 1 ? 0 : PITCH_CONTEXT_SAMPLES);
}

// 每段含重疊上下文；合併後每一個全域 frame 只能出現一次且不能漏格。
const results = segments.map(segment => {
	const length = Math.max(1, Math.floor((segment.readTo - segment.readFrom - HOP) / HOP) + 1);
	const f0 = new Float32Array(length), confidence = new Float32Array(length), voiced = new Uint8Array(length).fill(1);
	for (let i = 0; i < length; i++) {
		const globalFrame = (segment.readFrom + i * HOP) / HOP;
		f0[i] = 1000 + globalFrame; confidence[i] = .95;
	}
	return { f0, confidence, voiced, length };
});
const merged = mergePitchSegments(audio.length, segments, results);
for (let i = 0; i < merged.length; i++) {
	assert.equal(merged.f0[i], 1000 + i, `missing/duplicate frame ${i}`);
	assert.ok(Math.abs(merged.confidence[i] - .95) < 1e-6);
	assert.equal(merged.voiced[i], 1);
}
console.log('PASS: pitch segments use the midpoint of the quietest full second, aligned overlap and lossless frame merge');
