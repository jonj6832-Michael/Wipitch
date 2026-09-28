import puppeteer from 'puppeteer';
const dpr = Number(process.argv[2] || 1);
const params = process.argv[3] || '';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
if (process.env.LISTEN) {
	const problems = [];
	page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) problems.push('console: ' + m.text()); });
	page.on('pageerror', e => problems.push('pageerror: ' + e.message));
}
await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: dpr });
const t0 = Date.now();
try {
	await page.goto(`http://localhost:5180/?autoload=/Vocal.wav${params}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
	console.log(`dpr=${dpr} params="${params}" → goto 成功 (${Date.now() - t0}ms)`);
	await new Promise(r => setTimeout(r, 12000));
	console.log('   hint:', (await page.$eval('#hint', e => e.textContent)).slice(0, 40));
} catch (e) {
	console.log(`dpr=${dpr} params="${params}" → goto 失敗: ${e.message.split('\n')[0]}`);
}
await browser.close();
