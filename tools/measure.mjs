import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800 });
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('requestfailed', r => errs.push('failed: ' + r.url()));
page.on('response', r => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });
await page.goto('http://localhost:5180/?autoload=/Vocal.wav', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (document.getElementById('status')?.textContent || '').includes('Hz'), { timeout: 60000 });
console.log(await page.evaluate(() => {
	const ids = ['stage', 'pitch-track', 'wave-track', 'pianoroll', 'waveform'];
	return ids.map(id => {
		const e = document.getElementById(id);
		const r = e.getBoundingClientRect();
		const cs = getComputedStyle(e);
		return `${id.padEnd(12)} ${Math.round(r.width)}x${Math.round(r.height)}  flex=${cs.flex}  display=${cs.display}`;
	}).join('\n');
}));
console.log('\n問題:', errs.length ? errs.join('\n  ') : '無');
await browser.close();
