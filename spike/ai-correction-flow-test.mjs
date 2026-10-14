import assert from 'node:assert/strict';
import { WorkState } from '../src/application/work-state.ts';
import { AICorrectionFlow } from '../src/application/ai-correction-flow.ts';
import { Curves } from '../src/model/curves.ts';
import { History } from '../src/model/history.ts';
import { KEY_OPTIONS } from '../src/model/keys.ts';

const deferred = () => {
	let resolve;
	const promise = new Promise(r => resolve = r);
	return { promise, resolve };
};
function setup(overrides = {}) {
	const events = [], updates = [], history = new History();
	const workState = new WorkState();
	let locked = false;
	workState.subscribe(state => {
		if (locked !== state.blocksEditing) {
			locked = state.blocksEditing;
			events.push(locked ? 'lock' : 'unlock');
		}
	});
	const initial = new Curves(2000);
	let current = initial;
	const input = {
		curves: initial, midi: new Float32Array(2000).fill(60.4), voiced: new Uint8Array(2000).fill(1),
		key: KEY_OPTIONS.find(k => k.id === 'major-0'), range: { start: .5, end: 2.5 }, level: 5,
		settings: { provider: 'rules', baseUrl: '', model: '', apiKey: '' },
	};
	const flow = new AICorrectionFlow({
		workState,
		pausePlayback: () => events.push('pause'),
		sameCurves: (a, b) => a.pitch.every((v, i) => v === b.pitch[i]),
		render: async (next, range) => { events.push('render'); assert.equal(history.depth, 0); assert.equal(current, initial); assert.deepEqual(range, { start: .5, end: 2.5 }); },
		pushHistory: before => { events.push('history'); history.push(before); },
		commitCurves: next => { events.push('commit'); current = next; },
		updatePlayback: () => events.push('playback'),
		scheduleBackground: () => events.push('background'),
		...overrides,
	});
	return { flow, workState, input, events, updates, history, current: () => current, run: () => flow.run(input, u => updates.push(u)) };
}

const success = setup();
assert.equal((await success.run()).status, 'completed');
assert.deepEqual(success.events, ['lock', 'pause', 'render', 'history', 'commit', 'playback', 'background', 'unlock']);
assert.equal(success.history.depth, 1);
assert.ok(success.current().pitch[500] < 0);
assert.equal(success.current().pitch[0], 0);
assert.equal(success.current().pitch[1500], 0);
assert.deepEqual(success.history.undo(success.current()).pitch, success.input.curves.pitch);
assert.equal(success.flow.running, false);

for (const kind of ['request', 'render', 'unchanged', 'empty']) {
	const error = new Error(kind);
	const test = setup(kind === 'request' ? { suggest: async () => { throw error; } }
		: kind === 'render' ? { render: async () => { throw error; } } : {});
	if (kind === 'unchanged') test.input.midi.fill(60);
	if (kind === 'empty') test.input.voiced.fill(0);
	assert.equal((await test.run()).status, kind === 'unchanged' ? 'unchanged' : 'failed');
	assert.equal(test.history.depth, 0);
	assert.equal(test.current(), test.input.curves);
	assert.equal(test.events.at(-1), 'unlock');
	assert.equal(test.flow.running, false);
}

// 即使服務忽略 AbortSignal，取消後也不可開始算繪或提交。
const request = deferred();
const cancelled = setup({ suggest: async (_s, notes) => { await request.promise; return notes.map(n => ({ id: n.id, targetMidi: 60 })); } });
const pending = cancelled.run();
assert.equal((await cancelled.run()).status, 'busy');
assert.equal(cancelled.flow.cancel(), true);
request.resolve();
assert.equal((await pending).status, 'cancelled');
assert.deepEqual(cancelled.events, ['lock', 'pause', 'unlock']);
assert.equal(cancelled.history.depth, 0);
assert.equal(cancelled.flow.cancel(), false);

// 算繪階段不接受取消；成功後只提交一次。
const rendering = deferred(), entered = deferred();
const renderTest = setup({ render: async () => { entered.resolve(); await rendering.promise; } });
const rendered = renderTest.run();
await entered.promise;
assert.equal(renderTest.updates.at(-1).cancellable, false);
assert.equal(renderTest.flow.cancel(), false);
assert.equal(renderTest.history.depth, 0);
rendering.resolve();
assert.equal((await rendered).status, 'completed');
assert.equal(renderTest.history.depth, 1);

// 請求開始後，原來的範圍／設定被改動也不能影響此次操作。
const snapshotGate = deferred();
const snapshot = setup({ suggest: async (_s, notes) => { await snapshotGate.promise; return notes.map(n => ({ id: n.id, targetMidi: 60 })); } });
const snapshotRun = snapshot.run();
snapshot.input.range.end = 3;
snapshot.input.settings.provider = 'ollama';
snapshotGate.resolve();
const outcome = await snapshotRun;
assert.equal(outcome.status, 'completed');
assert.equal(outcome.input.range.end, 2.5);
assert.equal(outcome.input.settings.provider, 'rules');

// 不依靠按鈕 disabled 或進度條，應用層直接拒絕衝突工作。
const conflict = setup();
const loading = conflict.workState.tryBegin('load', '讀取音檔');
assert.equal((await conflict.run()).status, 'busy');
assert.equal(conflict.workState.has('load'), true);
assert.equal(conflict.workState.has('ai'), false);
assert.equal(conflict.history.depth, 0);
loading.finish('載入完成');
assert.equal((await conflict.run()).status, 'completed');
assert.equal(conflict.workState.isBusy, false);
console.log('PASS: AI workflow commit order, undo, range, no-op, request/render failures, cancellation, duplicate start and snapshots');
