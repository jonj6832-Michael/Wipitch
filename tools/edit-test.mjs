// 自動測試編輯流程：選取一段 → 上下拖曳改音高 → 確認有算繪、聲音真的變了。
import puppeteer from 'puppeteer';
const step = (m) => { process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${m}\n`); };

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 2 });
const problems = [];
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) problems.push('console: ' + m.text()); });
page.on('pageerror', e => problems.push('pageerror: ' + e.message));

step('goto…');
await page.goto('http://localhost:5180/?autoload=/Vocal.wav&t=45&span=6', { waitUntil: 'domcontentloaded' });
// 等到音高偵測完成：__debug() 在曲線建好之前回傳 null
await page.waitForFunction(
	() => !!window.__debug?.() || /失敗/.test(document.getElementById('status')?.textContent || ''),
	{ timeout: 120000, polling: 500 },
);
step('載入完成');
console.log('載入完成:', await page.$eval('#status', e => e.textContent));

step('開始選取');
const roll = await page.$('#pianoroll');
const box = await roll.boundingBox();
const midY = box.y + box.height * 0.45;

// 1) 左右拖曳選一段（約 1.5 秒）
await page.mouse.move(box.x + 300, midY);
await page.mouse.down();
await page.mouse.move(box.x + 650, midY, { steps: 12 });
await page.mouse.up();
console.log('選取後:', await page.$eval('#hint', e => e.textContent));

// 2) 在選取區內往上拖，改音高
const insideX = box.x + 470;
await page.mouse.move(insideX, midY);
await page.mouse.down();
for (const dy of [20, 40, 60, 80]) await page.mouse.move(insideX, midY - dy, { steps: 4 });
await page.mouse.up();
await page.waitForFunction(() => /完成|失敗/.test(document.getElementById('hint')?.textContent || ''), { timeout: 60000, polling: 200 });
console.log('拖曳後:', await page.$eval('#hint', e => e.textContent));

await page.screenshot({ path: 'edit.png' });

// 3) 確認 delta 曲線真的改了、算繪 buffer 真的變了
const check = await page.evaluate(() => (window).__debug?.() ?? null);
console.log('內部狀態:', check);

console.log(problems.length ? '\n⚠ ' + problems.join('\n  ') : '\n沒有 console 錯誤');
await browser.close();
