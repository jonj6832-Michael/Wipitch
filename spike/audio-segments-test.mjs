import assert from 'node:assert/strict';
import { planAudioSegments } from '../src/analysis/audio-segments.ts';

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

console.log('PASS: 10–15 second audio jobs cut at the minimum multi-channel RMS point');
