import assert from 'node:assert/strict';
import { NotePreview } from '../src/audio/note-preview.ts';

const events = [], loading = [];
let created = 0, loads = 0, resume, finishLoad, failLoad;
const context = { resume: () => Promise.resolve(), close: () => Promise.resolve() };
const piano = { attack: midi => events.push(['on', midi]), release: midi => events.push(['off', midi]) };
const synth = new NotePreview(() => { created++; return context; }, () => {
	loads++;
	return new Promise((resolve, reject) => { finishLoad = resolve; failLoad = reject; });
}, value => loading.push(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const fail = error => { throw error; };

// 預載與按鍵共用載入；在音色就緒前放開，不可延遲發聲。
const prepared = synth.prepare();
let stop = synth.start(69, fail);
await tick(); stop(); finishLoad(piano); await prepared; await tick();
assert.deepEqual(events, []);
assert.equal(loads, 1); assert.equal(created, 1);
assert.deepEqual(loading, [true, false]);

stop = synth.start(69, fail); await tick(); stop(); stop();
assert.deepEqual(events, [['on', 69], ['off', 69]]);
synth.start(60, fail); await tick();
stop = synth.start(61, fail); await tick(); stop();
assert.deepEqual(events.slice(2), [['on', 60], ['off', 60], ['on', 61], ['off', 61]]);
assert.equal(loads, 1);

context.resume = () => new Promise(resolve => resume = resolve);
stop = synth.start(72, fail); stop(); resume(); await tick();
assert.equal(events.length, 6);
context.resume = async () => { throw new Error('audio unavailable'); };
let error;
synth.start(72, e => error = e); await tick(); assert.equal(error.message, 'audio unavailable');
for (const midi of [-1, 128, NaN, 60.5]) synth.start(midi, fail);
assert.equal(events.length, 6);

// 載入失敗後可重試；載入期間換鍵只播放最後仍按住的一鍵。
context.resume = () => Promise.resolve();
const retry = new NotePreview(() => context, () => new Promise((resolve, reject) => {
	finishLoad = resolve; failLoad = reject;
}));
retry.start(60, e => error = e); await tick(); failLoad(new Error('missing sample')); await tick();
assert.equal(error.message, 'missing sample');
retry.start(60, fail); await tick();
stop = retry.start(62, fail); finishLoad(piano); await tick(); stop();
assert.deepEqual(events.slice(6), [['on', 62], ['off', 62]]);
console.log('PASS: shared preload, MIDI notes, release/retrigger, delayed load/resume cancellation, errors, retry and MIDI bounds');
