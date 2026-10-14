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
		const [{ collectCorrectionNotesParallel }, { Curves }, { KEY_OPTIONS }] = await Promise.all([
			import('/src/analysis/ai-candidate-pool.ts'), import('/src/model/curves.ts'), import('/src/model/keys.ts'),
		]);
		const curves = new Curves(15500); // 31 seconds at the 2ms curve rate.
		const midi = new Float32Array(curves.length).fill(69.4);
		const voiced = new Uint8Array(curves.length).fill(1);
		const key = KEY_OPTIONS.find(option => option.id === 'major-0');
		const ranges = [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }, { start: 30, end: 31 }];
		let progress = 0;
		const notes = await collectCorrectionNotesParallel({ curves, midi, voiced, key, range: { start: 0, end: 31 },
			segments: ranges, level: 5, settings: { provider: 'rules', baseUrl: '', model: '', apiKey: '' } },
			ranges, new AbortController().signal, done => { progress = done; });
		return { noteCount: notes.length, progress, ids: notes.map(note => note.id) };
	});
	assert.ok(result.noteCount >= 4, `noteCount=${result.noteCount}`);
	assert.equal(result.progress, 4);
	assert.deepEqual(result.ids, Array.from({ length: result.noteCount }, (_, id) => id));
	assert.equal(errors.length, 0, errors.join('\n'));
	console.log(`PASS: browser loaded parallel AI Workers and completed four segments (${result.noteCount} notes)`);
} finally {
	await browser.close();
}
