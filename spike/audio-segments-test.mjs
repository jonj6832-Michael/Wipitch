import assert from 'node:assert/strict';
import { planAudioSegments, planBalancedAudioSegments } from '../src/analysis/audio-segments.ts';

const sampleRate = 1000;
const channel = new Float32Array(35 * sampleRate).fill(1);
for (const center of [12.3, 24.6]) {
	const at = Math.round(center * sampleRate);
	channel.fill(0, at - 40, at + 40);
}
const segments = planAudioSegments([channel], sampleRate);
assert.equal(segments.length, 3);
assert.ok(Math.abs(segments[0].end - 12.3) <= .02, `first cut=${segments[0].end}`);
assert.ok(Math.abs(segments[1].end - 24.6) <= .02, `second cut=${segments[1].end}`);
assert.deepEqual(segments.map(segment => segment.start), [0, segments[0].end, segments[1].end]);
assert.equal(segments.at(-1).end, 35);
for (const segment of segments.slice(0, -1)) {
	assert.ok(segment.end - segment.start >= 10 && segment.end - segment.start <= 15);
	assert.equal(segment.cutRms, 0);
}

const short = planAudioSegments([new Float32Array(7 * sampleRate)], sampleRate);
assert.deepEqual(short, [{ start: 0, end: 7, cutRms: null }]);
assert.deepEqual(planAudioSegments([], sampleRate), []);
assert.throws(() => planAudioSegments([channel], sampleRate, { minSeconds: 15, maxSeconds: 10 }), /參數無效/);

// 不可一律每 10 秒切，否則 64 秒會留下 4 秒尾巴；尾端要回推到 10–15 秒。
const long = planAudioSegments([new Float32Array(64 * sampleRate).fill(1)], sampleRate);
assert.ok(long.every(segment => segment.end - segment.start >= 10 && segment.end - segment.start <= 15),
	long.map(segment => segment.end - segment.start).join(','));

// 音高分析與 AI 修音共用：依 Worker 數平均分配，切點取完整一秒最低 RMS 的中點。
const balanced = new Float32Array(130 * sampleRate).fill(1);
balanced.fill(0, 38 * sampleRate, 39 * sampleRate);
balanced.fill(0, 86 * sampleRate, 87 * sampleRate);
const parallel = planBalancedAudioSegments([balanced], sampleRate, { segmentCount: 3 });
assert.equal(parallel.length, 3);
assert.ok(Math.abs(parallel[0].end - 38.5) <= .02, `balanced first cut=${parallel[0].end}`);
assert.ok(Math.abs(parallel[1].end - 86.5) <= .02, `balanced second cut=${parallel[1].end}`);
assert.equal(planBalancedAudioSegments([new Float32Array(39 * sampleRate)], sampleRate, { segmentCount: 10 }).length, 1);

console.log('PASS: legacy and shared CPU-balanced audio jobs use verified minimum-RMS cut points');
