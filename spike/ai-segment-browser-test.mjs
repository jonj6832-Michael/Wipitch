import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded' });
	const result = await page.evaluate(async () => {
		const [{ collectCorrectionNotesParallel }, { Curves }, { KEY_OPTIONS }, segmentsModule] = await Promise.all([
			import('/src/analysis/ai-candidate-pool.ts'), import('/src/model/curves.ts'), import('/src/model/keys.ts'),
			import('/src/analysis/audio-segments.ts'),
		]);
		const duration=80,curves = new Curves(duration*500);
		const midi = new Float32Array(curves.length).fill(69.4);
		const voiced = new Uint8Array(curves.length).fill(1);
		const key = KEY_OPTIONS.find(option => option.id === 'major-0');
		const audio=new Float32Array(duration*1000).fill(1);
		const workerCount=segmentsModule.availableParallelWorkers('cpu');
		const ranges=segmentsModule.planBalancedAudioSegments([audio],1000,{segmentCount:workerCount});
		let progress = 0;
		const notes = await collectCorrectionNotesParallel({ curves, midi, voiced, key, range: { start: 0, end: duration },
			segments: ranges, level: 5, settings: { provider: 'rules', baseUrl: '', model: '', apiKey: '' } },
			ranges, new AbortController().signal, done => { progress = done; });
		return { noteCount: notes.length, progress, segmentCount:ranges.length,workerCount,ids: notes.map(note => note.id) };
	});
	assert.ok(result.noteCount >= result.segmentCount, `noteCount=${result.noteCount}`);
	assert.equal(result.segmentCount,Math.min(result.workerCount,4));
	assert.equal(result.progress,result.segmentCount);
	assert.deepEqual(result.ids, Array.from({ length: result.noteCount }, (_, id) => id));
	assert.equal(errors.length, 0, errors.join('\n'));
	console.log(`PASS: AI used the shared CPU-balanced planner and completed ${result.segmentCount} segments (${result.noteCount} notes)`);
} finally {
	await browser.close();
}
