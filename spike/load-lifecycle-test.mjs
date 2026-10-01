import assert from 'node:assert/strict';
import { LoadGuard, LoadTimings, analyseSource } from '../src/loading.ts';
import { withWasmFallback } from '../src/analysis/compute-mode.ts';
import { registerHooks } from 'node:module';

// 選檔、拖放及自動載入共用的互斥入口；失敗及成功都必須恢復操作。
const guard = new LoadGuard();
const states = [];
let finish;
const first = guard.run(() => new Promise(resolve => finish = resolve), busy => states.push(busy));
assert.equal(guard.busy, true);
assert.equal(await guard.run(async () => assert.fail('duplicate load started'), () => assert.fail()), false);
finish();
assert.equal(await first, true);
assert.deepEqual(states, [true, false]);
await assert.rejects(guard.run(async () => { throw new Error('decode failed'); }, busy => states.push(busy)), /decode failed/);
assert.equal(guard.busy, false);
assert.equal(await guard.run(async () => {}, busy => states.push(busy)), true);
assert.deepEqual(states, [true, false, true, false, true, false]);

// 回退時原始分析資料仍在；最終成功才清除，且不能修改播放聲道或音高結果。
const audio = new Float32Array([0.1, -0.1, 0.2]);
const channels = [new Float32Array([0.3, -0.3])];
const source = { mono16k: audio, channels };
const expected = { f0: Float32Array.of(440), confidence: Float32Array.of(1), voiced: Uint8Array.of(1), length: 1 };
const backends = [];
const result = await analyseSource(source, data => withWasmFallback('gpu', async backend => {
	backends.push(backend);
	assert.equal(data, audio); assert.equal(source.mono16k, audio);
	if (backend === 'webgpu') throw new Error('device lost');
	return expected;
}, () => assert.equal(source.mono16k, audio)));
assert.deepEqual(backends, ['webgpu', 'wasm']);
assert.equal(result.track, expected); assert.equal(result.releasedBytes, 12);
assert.equal(source.mono16k, null); assert.equal(source.channels, channels);
source.mono16k = audio;
await assert.rejects(analyseSource(source, async () => { throw new Error('both backends failed'); }), /both backends failed/);
assert.equal(source.mono16k, audio);

// 進度多次更新不能重置同一階段；GPU 與 WASM 嘗試必須各自留下紀錄。
let now = 0;
const timings = new LoadTimings(() => now);
timings.stage('read'); now = 10; timings.stage('read');
now = 20; timings.stage('gpu'); now = 60; timings.stage('wasm');
now = 110;
assert.deepEqual(timings.finish(), { totalMs: 110, stages: [
	{ stage: 'read', ms: 20 }, { stage: 'gpu', ms: 40 }, { stage: 'wasm', ms: 50 },
] });
console.log('PASS: duplicate loads blocked, failure unlock/retry, fallback retains audio, success releases analysis reference, playback/results unchanged, stage timing');

// 真正的 Renderer.init 必須將 Worker 初始化錯誤傳回載入流程，不能永久等待 ready。
let worker, workerFailure;
globalThis.LoadTestWorker = class {
	constructor() { worker = this; }
	postMessage() {
		queueMicrotask(() => {
			if (workerFailure === 'message') this.onmessage({ data: { type: 'error', error: 'WASM init failed' } });
			else if (workerFailure === 'error') this.onerror({ message: 'worker crashed', preventDefault() {} });
			else if (workerFailure === 'transfer') this.onmessageerror();
			else this.onmessage({ data: { type: 'ready' } });
		});
	}
	terminate() { this.terminated = true; }
};
const hook = registerHooks({ resolve(specifier, context, next) {
	if (specifier.endsWith('.worker?worker')) return { url: 'data:text/javascript,export default globalThis.LoadTestWorker;', shortCircuit: true };
	return next(specifier, context);
} });
try {
	const { Renderer } = await import('../src/engine/renderer.ts');
	for (workerFailure of ['message', 'error', 'transfer']) {
		await assert.rejects(new Renderer().init(channels, 48000));
		assert.equal(worker.terminated, true);
	}
	workerFailure = null;
	await new Renderer().init(channels, 48000);
	console.log('PASS: render Worker initialization/message/transfer errors reject, successful initialization remains available');
} finally { hook.deregister(); delete globalThis.LoadTestWorker; }
