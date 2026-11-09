import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const audioPath = process.argv[2];
if (!audioPath) throw new Error('usage: node spike/reference-beat-controls-browser-test.mjs <audio.wav>');

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (message.type() === 'error' && !message.text().includes('[W:onnxruntime:')) errors.push(message.text()); });
	await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded' });
	await (await page.$('#file')).uploadFile(audioPath);
	await page.waitForFunction(() => !document.querySelector('#export')?.disabled, { timeout: 240000, polling: 500 });
	await (await page.$('#bg-file')).uploadFile(audioPath);
	await page.waitForFunction(() => !document.querySelector('#bg-name')?.hidden, { timeout: 240000, polling: 500 });
	await page.click('#detection-all');
	await page.waitForFunction(() => !document.querySelector('#ref-anchor-set')?.disabled, { timeout: 10000, polling: 100 });
	assert.equal(await page.$eval('#ref-anchor-set', button => button.disabled), false);
	assert.equal(await page.$eval('#ref-beat-clear', button => button.disabled), true);

	await page.click('#ref-anchor-set');
	assert.equal(await page.$eval('#ref-beat-clear', button => button.disabled), false, 'first anchor creates a preview in a clean range');
	await page.click('#ref-anchor-set');
	assert.equal(await page.$eval('#ref-beat-clear', button => button.disabled), false, 're-anchor clears the range and immediately creates its replacement preview');
	assert.match(await page.$eval('#hint', element => element.textContent || ''), /清除檢測範圍原有拍點並重新錨定/);
	await page.click('#ref-beat-clear');
	assert.equal(await page.$eval('#ref-beat-clear', button => button.disabled), true, 'Clear removes every triangle in the detection range');
	assert.match(await page.$eval('#hint', element => element.textContent || ''), /已清除檢測範圍內所有節拍標記/);
	assert.deepEqual(errors, []);
	console.log('PASS: clean-range anchor, immediate range replacement and detection-range Clear button');
} finally {
	await browser.close();
}
