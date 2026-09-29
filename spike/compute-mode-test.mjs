import assert from 'node:assert/strict';
import { withWasmFallback } from '../src/analysis/compute-mode.ts';
import { installSwiftF0Worker } from '../src/analysis/swiftf0-engine.ts';
import { ComputeModeControl } from '../src/ui/compute-mode.ts';
import { ProgressView } from '../src/ui/progress.ts';

let calls = [];
assert.equal(await withWasmFallback('gpu', async backend => { calls.push(backend); return 1; }, () => assert.fail()), 1);
assert.deepEqual(calls, ['webgpu']);
for (const failure of ['GPU 初始化失敗', 'device lost during inference']) {
	calls = []; let reported;
	const value = await withWasmFallback('gpu', async backend => {
		calls.push(backend); if (backend === 'webgpu') throw new Error(failure); return 2;
	}, reason => reported = reason);
	assert.equal(value, 2); assert.equal(reported, failure); assert.deepEqual(calls, ['webgpu', 'wasm']);
}
calls = [];
await assert.rejects(withWasmFallback('wasm', async backend => { calls.push(backend); throw new Error('bad model'); }, () => assert.fail()), /bad model/);
assert.deepEqual(calls, ['wasm']);
calls = [];
await assert.rejects(withWasmFallback('gpu', async backend => { calls.push(backend); throw new Error(backend); }, () => {}), /wasm/);
assert.deepEqual(calls, ['webgpu', 'wasm']);

// Worker 假後端：測試缺少 GPU、推論失敗、資源釋放與兩種 provider 組態。
async function workerCase(backend, gpuAvailable, failRun = false) {
	const messages = []; let released = 0, disposed = 0, providers;
	globalThis.self = { navigator: gpuAvailable ? {gpu:{}} : {}, postMessage: message => messages.push(message) };
	const fakeOrt = {
		env:{webgpu:{device:Promise.resolve({})}},
		Tensor:class {dispose(){disposed++;}},
		InferenceSession:{create:async (_url, options) => {
			providers = options.executionProviders;
			return {inputNames:['audio'],outputNames:['f0','confidence'],release:async()=>released++,run:async()=>{
				if(failRun) throw new Error('device lost');
				return {f0:{data:Float32Array.of(440),dispose(){disposed++;}},confidence:{data:Float32Array.of(1),dispose(){disposed++;}}};
			}};
		}},
	};
	installSwiftF0Worker(fakeOrt,backend);
	await self.onmessage({data:{audio:new Float32Array(256),modelUrl:'test.onnx'}});
	return {messages,released,disposed,providers};
}
let result = await workerCase('webgpu',false);
assert.equal(result.messages.at(-1).ok,false);assert.equal(result.providers,undefined);
result = await workerCase('webgpu',true,true);
assert.equal(result.messages.at(-1).ok,false);assert.equal(result.released,1);assert.equal(result.disposed,1);
for(const backend of ['wasm','webgpu']) {
	result=await workerCase(backend,true);
	assert.deepEqual(result.providers,backend==='wasm'?['wasm']:['webgpu','wasm']);
	assert.equal(result.messages.at(-1).f0[0],440);assert.equal(result.released,1);assert.equal(result.disposed,3);
}

// 前景與背景任務重疊時，必須等所有工作完成才可切換。
const store = new Map();globalThis.localStorage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
let change;
const select = {value:'',disabled:false,addEventListener:(_event,fn)=>change=fn};
const status = {textContent:'',title:''};
const nodes = new Map(['progress','#progress-label','.progress-value'].map(k=>[k,{removeAttribute(){}}]));
const progress = new ProgressView({querySelector:k=>nodes.get(k),classList:{toggle(){}},setAttribute(){}});
const control = new ComputeModeControl(select,status,()=>progress.isBusy);
progress.onBusyChange=()=>control.sync();
assert.equal(select.value,'gpu');
const foreground=progress.begin('讀取');const background=progress.begin('精算',0);
assert.equal(select.disabled,true);select.value='wasm';change();assert.equal(control.mode,'gpu');
foreground.finish('完成');assert.equal(select.disabled,true);
background.finish('失敗',true);assert.equal(select.disabled,false);
select.value='wasm';change();assert.equal(control.mode,'wasm');assert.equal(store.get('wipitch.compute-mode'),'wasm');
control.start();control.report({backend:'wasm',fallback:true,reason:'device lost'});control.finish(true);
assert.match(status.textContent,/上次：CPU（GPU 回退）/);assert.equal(status.title,'device lost');
console.log('PASS: GPU success, initialization/inference fallback, CPU-only, terminal error, resource cleanup, overlapping busy locks, persistence and status');
