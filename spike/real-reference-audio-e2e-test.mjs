import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const [mainPath, referencePath, baseUrl = 'http://127.0.0.1:5180/'] = process.argv.slice(2);
if (!mainPath || !referencePath) throw new Error('usage: node spike/real-reference-audio-e2e-test.mjs main.wav reference.wav [url]');

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
async function run(withReference) {
	const page = await browser.newPage();
	const errors = [], failedRequests = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => {
		if (message.type() === 'error' && !message.text().includes('[W:onnxruntime:')) errors.push(message.text());
	});
	page.on('requestfailed', request => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
	await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
	await (await page.$('#file')).uploadFile(mainPath);
	await page.waitForFunction(() => !document.querySelector('#export')?.disabled, { timeout: 300000, polling: 500 });
	if (withReference) {
		await (await page.$('#bg-file')).uploadFile(referencePath);
		await page.waitForFunction(() => !document.querySelector('#bg-name')?.hidden, { timeout: 120000, polling: 250 });
	}
	await page.select('#key-filter', 'major-7');
	await page.$eval('#ai-strength', input => {
		input.value = '10'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await page.$eval('#tempo-bpm', input => {
		input.value = '102'; input.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await page.$eval('#detection-all', button => button.click());
	assert.match(await page.$eval('#detection-status', element => element.textContent || ''), /~/);
	if (withReference) {
		const box = await (await page.$('#refwave')).boundingBox();
		assert.ok(box);
		// 60 秒測試片段的 Librosa 第一個拍點約在 0.288 秒。
		await page.mouse.click(box.x + box.width * 0.288 / 60, box.y + box.height / 2);
		await page.click('#ref-anchor-set');
		assert.match(await page.$eval('#hint', element => element.textContent || ''), /錨定|吸附/);
		await page.click('#sync-reference');
		await page.waitForFunction(() => /已記錄 \d+ 拍/.test(document.querySelector('#ref-beat-status')?.textContent || ''), { timeout: 300000, polling: 500 });
	}
	try {
		await page.waitForFunction(() => !document.querySelector('#ai-correct')?.disabled, { timeout: 60000, polling: 200 });
	} catch (error) {
		const state = await page.evaluate(() => ({
			buttonDisabled: document.querySelector('#ai-correct')?.disabled,
			buttonTitle: document.querySelector('#ai-correct')?.title,
			key: document.querySelector('#key-filter')?.value,
			detection: document.querySelector('#detection-status')?.textContent,
			status: document.querySelector('#status')?.textContent,
			aiStatus: document.querySelector('#ai-status')?.textContent,
		}));
		throw new Error(`AI button did not enable: ${JSON.stringify(state)}; ${error}`);
	}
	await page.click('#ai-correct');
	await page.waitForFunction(() => {
		const text = document.querySelector('#ai-status')?.textContent || '';
		return /完成|沒有需要修正|修正失敗|分析失敗/.test(text);
	}, { timeout: 300000, polling: 500 });
	const result = await page.evaluate(() => ({
		aiStatus: document.querySelector('#ai-status')?.textContent || '',
		hint: document.querySelector('#hint')?.textContent || '',
		beatStatus: document.querySelector('#ref-beat-status')?.textContent || '',
		regions: [...document.querySelectorAll('.ai-region:not(.manual-selection-region)')].map(element => ({
			left: element.style.left, width: element.style.width,
			pitchOffset: window.__laneAtX?.('pitch', Number.parseFloat(element.style.left) + Number.parseFloat(element.style.width) / 2)?.v ?? null,
		})),
		debug: window.__debug?.() ?? null,
	}));
	await page.close();
	return { ...result, errors, failedRequests };
}

try {
	const baseline = await run(false);
	const referenced = await run(true);
	assert.doesNotMatch(baseline.aiStatus, /失敗/);
	assert.doesNotMatch(referenced.aiStatus, /失敗/);
	assert.ok(baseline.regions.length > 0, 'real vocal should produce review frames');
	const geometry = result => result.regions.map(({ left, width }) => ({ left, width }));
	assert.deepEqual(geometry(referenced), geometry(baseline), 'reference harmony must not change yellow frame selection');
	assert.ok(baseline.debug?.editedFrames > 0 && referenced.debug?.editedFrames > 0, 'pitch curve must actually change');
	assert.ok(baseline.debug?.renderDiffRatio > 0 && referenced.debug?.renderDiffRatio > 0, 'rendered audio must actually change');
	assert.match(referenced.beatStatus, /已記錄 \d+ 拍.*\d+ 拍和弦/);
	assert.deepEqual(baseline.errors, []); assert.deepEqual(referenced.errors, []);
	assert.deepEqual(baseline.failedRequests, []); assert.deepEqual(referenced.failedRequests, []);
	console.log(JSON.stringify({ baseline, referenced }, null, 2));
	console.log('PASS: real vocal/piano analysis, Librosa rhythm/chords and invariant yellow frames');
} finally {
	await browser.close();
}
