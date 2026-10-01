import assert from 'node:assert/strict';
import { NotePreview } from '../src/audio/note-preview.ts';

const oscillators = [], gains = [];
let created = 0, resume;
const context = {
	currentTime: 1, destination: {}, resume: () => Promise.resolve(),
	createOscillator: () => {
		const node = { frequency: { setValueAtTime(hz) { node.hz = hz; } }, connect(to) { node.to = to; },
			start() { node.started = true; }, stop(at) { node.stopped = at; }, disconnect() { node.disconnected = true; } };
		oscillators.push(node); return node;
	},
	createGain: () => {
		const node = { gain: { setValueAtTime() {}, linearRampToValueAtTime(value) { node.level = value; }, cancelAndHoldAtTime() {} },
			connect(to) { node.to = to; }, disconnect() { node.disconnected = true; } };
		gains.push(node); return node;
	},
};
const synth = new NotePreview(() => { created++; return context; });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const fail = error => { throw error; };
let stop = synth.start(69, fail); await tick();
assert.equal(oscillators[0].hz, 440); assert.equal(oscillators[0].started, true);
assert.equal(oscillators[0].to, gains[0]); assert.equal(gains[0].to, context.destination);
stop(); stop(); assert.equal(gains[0].level, 0); assert.equal(oscillators[0].stopped, 1.05);
oscillators[0].onended(); assert.ok(oscillators[0].disconnected && gains[0].disconnected);
stop = synth.start(60, fail); await tick();
assert.ok(Math.abs(oscillators[1].hz - 261.6255653) < 1e-6);
synth.start(61, fail); await tick(); assert.ok(oscillators[1].stopped);
assert.ok(Math.abs(oscillators[2].hz - 277.182631) < 1e-6);
assert.equal(created, 1); // 全部琴鍵共用同一 AudioContext。
context.resume = () => new Promise(resolve => resume = resolve);
stop = synth.start(72, fail); stop(); resume(); await tick();
assert.equal(oscillators.length, 3); // 快速放開後，延遲完成的 resume 不可再發聲。
context.resume = async () => { throw new Error('audio unavailable'); };
let error;
synth.start(72, e => error = e); await tick(); assert.equal(error.message, 'audio unavailable');
for (const midi of [-1, 128, NaN, 60.5]) synth.start(midi, fail);
assert.equal(oscillators.length, 3);
console.log('PASS: A4/C4/C#4 frequencies, speaker routing, release envelope, disconnect, retrigger, delayed resume cancellation, errors and MIDI bounds');
