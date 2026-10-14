import assert from 'node:assert/strict';
import { Curves, CURVE_HOP_SEC } from '../src/model/curves.ts';
import { History } from '../src/model/history.ts';
import { KEY_OPTIONS } from '../src/model/keys.ts';
import { correctionNotes, applyCorrection, validateDecisions } from '../src/model/auto-pitch.ts';
import { suggestCorrections, endpoint, listAIModels } from '../src/analysis/ai-correction.ts';
import { AISettingsView } from '../src/ui/ai-settings.ts';

const key = KEY_OPTIONS.find(k => k.id === 'major-0');
const base = new Curves(2000), midi = new Float32Array(2000), voiced = new Uint8Array(2000).fill(1);
for (let i = 0; i < midi.length; i++) midi[i] = 60.3 + .06 * Math.sin(i * CURVE_HOP_SEC * 2 * Math.PI * 5);
base.gainDb.fill(2); base.formant.fill(-.5);
const range = { start: .5, end: 2.5 };
const notes = correctionNotes(base, midi, voiced, key, range);
assert.equal(notes.length, 1); assert.equal(notes[0].defaultTarget, 60);
const decisions = notes.map(n => ({ id: n.id, targetMidi: 60 }));
let previous = Infinity;
for (let level = 1; level <= 10; level++) {
	const { curves, count } = applyCorrection(base, notes, decisions, key, level, voiced);
	assert.equal(count, 1);
	const delta = curves.pitch[500];
	assert.ok(Math.abs(delta - (60 - notes[0].center) * level / 10) < 1e-6);
	assert.ok(delta < previous); previous = delta;
	assert.equal(curves.pitch[501], delta); // 中心偏移一致，保留原始顫音。
	for (let i = 0; i < curves.length; i++) if (i * CURVE_HOP_SEC < range.start || i * CURVE_HOP_SEC >= range.end) assert.equal(curves.pitch[i], base.pitch[i]);
	assert.deepEqual(curves.gainDb, base.gainDb); assert.deepEqual(curves.formant, base.formant);
}
assert.ok(base.pitch.every(x => x === 0));

// 傳統模式：等級只控制入選門檻，入選後完整修正到目標中心。
const sensitivityNotes = [{ ...notes[0], id: 0, center: 60.32, targets: [60], defaultTarget: 60 }];
assert.equal(applyCorrection(base, sensitivityNotes, [{ id: 0, targetMidi: 60 }], key, 4, voiced, 'sensitivity').count, 0); // 35c 門檻
const sensitive = applyCorrection(base, sensitivityNotes, [{ id: 0, targetMidi: 60 }], key, 5, voiced, 'sensitivity'); // 30c 門檻
assert.equal(sensitive.count, 1);
assert.ok(Math.abs(sensitive.curves.pitch[500] + .32) < 1e-6);
const history = new History(); history.push(base);
const corrected = applyCorrection(base, notes, decisions, key, 10, voiced).curves;
assert.deepEqual(history.undo(corrected).pitch, base.pitch);
assert.deepEqual(history.redo(base).pitch, corrected.pitch);

// 伸縮後的檢測時間必須映回來源；範圍外逐格完全不變。
const anchor = base.timeMap.add(2); base.timeMap.move(anchor.id, 4);
const stretched = correctionNotes(base, midi, voiced, key, { start: 1, end: 3 });
assert.equal(stretched[0].from, 250); assert.equal(stretched.at(-1).to, 750);
base.timeMap.remove(anchor.id);
voiced.fill(0); assert.equal(correctionNotes(base, midi, voiced, key, range).length, 0); voiced.fill(1);
assert.equal(correctionNotes(base, midi, voiced, key, { start: 1, end: 1.05 }).length, 0);
midi.fill(61); // C 與 D 等距，內建模式不可自行推測。
assert.equal(correctionNotes(base, midi, voiced, key, range)[0].defaultTarget, null);
for (const targetMidi of [61, 72, NaN, '60']) assert.throws(() => validateDecisions({ decisions: [{ id: 0, targetMidi }] }, notes, key));
assert.throws(() => validateDecisions({ decisions: [] }, notes, key));
assert.throws(() => validateDecisions({ decisions: [{ id: 99, targetMidi: 60 }] }, notes, key));

const signal = new AbortController().signal;
for (const provider of ['ollama', 'openai']) {
	const settings = { provider, baseUrl: provider === 'ollama' ? 'http://localhost:11434' : 'https://example.test/v1', model: 'test-model', apiKey: 'test-secret' };
	let calls = 0;
	const mockFetch = async (url, init) => {
		calls++;
		assert.equal(url, endpoint(settings));
		assert.equal(init.headers.Authorization, 'Bearer test-secret');
		assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
		assert.ok(!init.body.includes('test-secret'));
		const body = JSON.parse(init.body);
		assert.equal(body.model, 'test-model'); assert.equal(body.stream, false);
		assert.ok(provider === 'ollama' ? body.format.properties.decisions : body.response_format.type === 'json_object');
		const content = JSON.stringify({ decisions });
		return { ok: true, json: async () => provider === 'ollama' ? { message: { content } } : { choices: [{ message: { content } }] } };
	};
	assert.deepEqual(await suggestCorrections(settings, notes, key, signal, () => {}, mockFetch), decisions);
	assert.equal(calls, 1);
	await assert.rejects(suggestCorrections(settings, notes, key, signal, () => {}, async () => ({ ok: false, status: 401 })), /401/);
	const cancel = new AbortController(); cancel.abort();
	await assert.rejects(suggestCorrections(settings, notes, key, cancel.signal, () => {}, mockFetch), /取消/);
	assert.equal(calls, 1);
}
const builtin = { provider: 'rules', baseUrl: '', model: '', apiKey: '' };
assert.deepEqual(await suggestCorrections(builtin, notes, key, signal, () => {}, () => assert.fail()), decisions);
assert.throws(() => endpoint({ ...builtin, provider: 'openai', baseUrl: 'https://user:secret@example.test/v1' }));
assert.throws(() => endpoint({ ...builtin, provider: 'openai', baseUrl: 'http://example.test/v1' }));
assert.deepEqual(await listAIModels({ ...builtin, provider: 'ollama', baseUrl: 'http://localhost:11434' }, signal,
	async () => ({ ok: true, json: async () => ({ models: [{ name: 'model-a' }] }) })), ['model-a']);
console.log('PASS: ten levels, exact range containment/time stretch, vibrato preservation, silence/short/ambiguous notes, undo/redo, target validation, Ollama/OpenAI payloads, auth errors, cancellation, no-network builtin');

// 長區間分批：最後一批失敗時整次拒絕，不回傳部分修正。
const many = Array.from({ length: 25 }, (_, id) => ({ ...notes[0], id }));
let batchCalls = 0;
const external = { provider: 'openai', baseUrl: 'https://example.test/v1', model: 'test', apiKey: '' };
await assert.rejects(suggestCorrections(external, many, key, signal, () => {}, async (_url, init) => {
	batchCalls++;
	const batch = JSON.parse(JSON.parse(init.body).messages[1].content).notes;
	return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ decisions:
		batch.map(n => ({ id: n.id, targetMidi: batchCalls === 2 ? 61 : 60 })) }) } }] }) };
}), /調內音/);
assert.equal(batchCalls, 2);
assert.throws(() => validateDecisions({ decisions: [{ id: 0, targetMidi: 60 }, { id: 0, targetMidi: 60 }] }, many.slice(0, 2), key));

// 設定中的 API Key 僅留記憶體；關閉再開仍在，重新建立分頁設定時必須為空。
let stored = null;
globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => stored = value };
function fakeDialog() {
	const nodes = new Map();
	const node = () => ({ value: '', disabled: false, textContent: '', events: {}, addEventListener(type, fn) { this.events[type] = fn; }, replaceChildren() {} });
	return { nodes, ...node(), querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); }, close() {}, showModal() {} };
}
const dialog = fakeDialog();
const view = new AISettingsView(dialog, () => {});
view.open();
dialog.nodes.get('#ai-provider').value = 'openai';
dialog.nodes.get('#ai-url').value = 'https://example.test/v1';
dialog.nodes.get('#ai-model').value = 'test-model';
dialog.nodes.get('#ai-api-key').value = 'do-not-persist';
dialog.nodes.get('form').events.submit({ preventDefault() {} });
assert.equal(view.settings.apiKey, 'do-not-persist');
assert.ok(!stored.includes('do-not-persist')); assert.ok(!stored.includes('apiKey'));
assert.equal(new AISettingsView(fakeDialog(), () => {}).settings.apiKey, '');
view.open(); assert.equal(dialog.nodes.get('#ai-api-key').value, 'do-not-persist');
dialog.nodes.get('#ai-provider').value = 'ollama';
dialog.nodes.get('#ai-provider').events.change();
assert.equal(dialog.nodes.get('#ai-api-key').value, '');
console.log('PASS: batched response atomicity, duplicate rejection, API Key memory-only storage/provider reset');
