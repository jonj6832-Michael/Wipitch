import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

if (!isMainThread) {
	globalThis.self = { postMessage: value => parentPort.postMessage(value), onmessage: null };
	await import('../src/analysis/reference-rhythm.worker.ts');
	parentPort.on('message', data => self.onmessage({ data }));
	parentPort.postMessage('ready');
} else {
	const { referenceBeatPreview } = await import('../src/model/reference-beat-preview.ts');
	assert.deepEqual(referenceBeatPreview(20, 120, '4/4', 0, 100), [12, 14, 16, 18, 20, 22, 24, 26, 28]);
	assert.deepEqual(referenceBeatPreview(20, 60, '4/4', 0, 100), [4, 8, 12, 16, 20, 24, 28, 32, 36]);
	assert.deepEqual(referenceBeatPreview(20, 120, '3/4', 0, 100), [14, 15.5, 17, 18.5, 20, 21.5, 23, 24.5, 26]);
	assert.deepEqual(referenceBeatPreview(20, 120, '2/2', 0, 100), [16, 17, 18, 19, 20, 21, 22, 23, 24]);
	assert.deepEqual(referenceBeatPreview(1, 120, '4/4', 0, 6), [1, 3, 5]);
	const { findOnset } = await import('../src/analysis/reference-cache.ts');
	const anchorOnsets = new Float32Array(1000); anchorOnsets[477] = 1;
	const snapped = findOnset({ mono16k: new Float32Array(), onsets: anchorOnsets, duration: 10 }, 4.97, 0.5);
	assert.equal(snapped, 4.77);
	assert.equal(referenceBeatPreview(snapped, 120, '4/4', 0, 10).length, 5, '無檢測範圍亦可由吸附錨點產生可見的小節預覽');
	const { concurrentAnalysis } = await import('../src/application/concurrent-analysis.ts');
	const started = [], release = [];
	const job = name => () => new Promise(resolve => { started.push(name); release.push(() => resolve(name)); });
	const pending = concurrentAnalysis({ mainPitch: job('main'), referencePitch: job('reference'), rhythm: job('rhythm') });
	await Promise.resolve();
	assert.deepEqual(started, ['main', 'reference', 'rhythm'], '全部工作應在等待任何一項結果之前啟動');
	release.forEach(resolve => resolve());
	assert.deepEqual(await pending, { mainPitch: 'main', referencePitch: 'reference', rhythm: 'rhythm' });
	let finishOther, settled = false;
	const failure = concurrentAnalysis({ mainPitch: async () => { throw Error('pool failure'); },
		referencePitch: () => new Promise(resolve => { finishOther = resolve; }), rhythm: async () => 1 });
	const handled = failure.catch(error => { settled = true; return error; });
	await Promise.resolve(); await Promise.resolve();
	assert.equal(settled, false, '一組失敗時仍需等另一組清理完畢');
	finishOther(1); assert.match((await handled).message, /pool failure/);
	const worker = new Worker(new URL(import.meta.url));
	try {
		await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); });
		const audio = new Float32Array(12 * 16000);
		const response = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); });
		worker.postMessage({ audio, anchorSec: 1.2, bpm: 120, meter: '4/4', bpmTolerance: 0.05 });
		const { result, error } = await response;
		assert.equal(error, undefined);
		assert.equal(result.anchorSec, 1.2, 'Worker must preserve the user-confirmed anchor');
		assert.deepEqual(result.barStartsSec, [1.2, 3.2, 5.2, 7.2, 9.2, 11.2]);
		assert.deepEqual(result.virtualBarStartsSec, [3.2, 5.2, 7.2, 9.2, 11.2], 'silence keeps every predicted point as a virtual marker');
		const { trackBarSequence } = await import('../src/analysis/reference-cache.ts');
		const missingOnsets = new Float32Array(1200);
		for (const t of [3.1, 7.25]) missingOnsets[Math.round(t * 100)] = 1;
		assert.deepEqual(trackBarSequence({ mono16k: audio, onsets: missingOnsets, duration: 12 }, 1, 120, '4/4', 0, 12), [
			{ timeSec: 1, confirmed: true }, { timeSec: 3.1, confirmed: true },
			{ timeSec: 5.2, confirmed: false }, { timeSec: 7.25, confirmed: true },
			{ timeSec: 9.3, confirmed: false }, { timeSec: 11.350000000000001, confirmed: false },
		], 'a miss inside the BPM-derived sequence is retained as a virtual beat and remains the next prediction cursor');
		const outsideWindow = new Float32Array(800); outsideWindow[311] = 1;
		assert.deepEqual(trackBarSequence({ mono16k: new Float32Array(8 * 16000), onsets: outsideWindow, duration: 8 }, 1, 120, '4/4', 0, 8), [
			{ timeSec: 1, confirmed: true }, { timeSec: 3, confirmed: false },
			{ timeSec: 5, confirmed: false }, { timeSec: 7, confirmed: false },
		], '113.7 BPM is just outside the 120 BPM -5% boundary, but every missed point remains marked');
		const slowing=new Float32Array(1200);for(const time of [3,5.1,7.31])slowing[Math.round(time*100)]=2;
		assert.deepEqual(trackBarSequence({mono16k:audio,onsets:slowing,duration:10},1,120,'4/4',0,10,.10),[
			{timeSec:1,confirmed:true},{timeSec:3,confirmed:true},{timeSec:5.1,confirmed:true},{timeSec:7.31,confirmed:true},{timeSec:9.52,confirmed:false},
		], 'bar two uses initial BPM and each later bar carries the previous measured interval for gradual slowing');
		console.log('PASS: fixed anchor, sequential BPM ±5% search, missing-beat carry-forward and virtual markers');
	} finally { await worker.terminate(); }
}
