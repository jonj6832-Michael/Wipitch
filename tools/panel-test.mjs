// 測試控制面板：壓平抖音滑桿、音量滑桿、復原、匯出。
import puppeteer from 'puppeteer';
const step = m => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 2 });
const problems = [];
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('pageerror', e => problems.push('pageerror: ' + e.message));

await page.goto('http://localhost:5180/?autoload=/Vocal.wav&t=45&span=6', { waitUntil: 'domcontentloaded' });
// 等到音高偵測完成：__debug() 在曲線建好之前回傳 null
await page.waitForFunction(() => !!window.__debug?.() || /失敗/.test(document.getElementById('status')?.textContent || ''), { timeout: 120000, polling: 500 });
step('載入完成');

const box = await (await page.$('#pianoroll')).boundingBox();
const midY = box.y + box.height * 0.45;

// 選一段有抖音的（畫面右側那段抖得最明顯）
await page.mouse.move(box.x + 950, midY);
await page.mouse.down();
await page.mouse.move(box.x + 1250, midY, { steps: 12 });
await page.mouse.up();
step('選取: ' + await page.$eval('#sel-info', e => e.textContent));

const dbg = () => page.evaluate(() => window.__debug());
console.log('  壓平前的抖動幅度:', (await dbg()).wobble, '半音');

// 把抖動滑桿拉到 0（完全壓平）
await page.$eval('#flatten', el => {
	el.value = '0';
	el.dispatchEvent(new Event('input', { bubbles: true }));
	el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForFunction(() => /完成|失敗/.test(document.getElementById('hint')?.textContent || ''), { timeout: 60000, polling: 200 });
step('抖音: ' + await page.$eval('#hint', e => e.textContent));
const after = await dbg();
console.log('  壓平後的抖動幅度:', after.wobble, '半音');
await page.screenshot({ path: 'flatten.png' });

// 音量 −12 dB
await page.$eval('#gain', el => {
	el.value = '-12';
	el.dispatchEvent(new Event('input', { bubbles: true }));
	el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForFunction(() => /音量：完成|失敗/.test(document.getElementById('hint')?.textContent || ''), { timeout: 60000, polling: 200 });
step('音量: ' + await page.$eval('#hint', e => e.textContent));

// 復原兩次
for (let i = 0; i < 2; i++) {
	await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
	await page.waitForFunction(() => /：完成|沒有東西|已復原/.test(document.getElementById('hint')?.textContent || ''), { timeout: 60000, polling: 200 });
}
const undone = await dbg();
step('復原後: ' + await page.$eval('#hint', e => e.textContent));
console.log('  復原後 maxDelta =', undone.maxDelta, ' 編輯格數 =', undone.editedFrames, ' 與原始的差異比 =', undone.renderDiffRatio);

console.log(problems.length ? '\n⚠ ' + problems.join('\n  ') : '\n沒有 console 錯誤');
await browser.close();
