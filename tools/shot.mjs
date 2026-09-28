// 開發用截圖工具：開瀏覽器、等音檔載入完、截圖、把 console 錯誤印出來。
//
//   node tools/shot.mjs [輸出檔名] [額外的網址參數]
//
// 之所以需要它：音檔解碼是非同步的，firefox --headless --screenshot 會在
// 解碼完成前就拍照，只拍到空畫面。
import puppeteer from 'puppeteer';

const out = process.argv[2] || 'shot.png';
const extra = process.argv[3] || '';
const url = `http://localhost:5180/?autoload=/Vocal.wav${extra}`;

const browser = await puppeteer.launch({
	headless: true,
	args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 2 });

const problems = [];
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('pageerror', e => problems.push('pageerror: ' + e.message));

await page.goto(url, { waitUntil: 'domcontentloaded' });

// 等到音高偵測完成（提示列出現操作說明「拖曳選取…」）或狀態列顯示失敗為止。
// 不能只等解碼完成——音高偵測是之後才在 Worker 裡跑的。
// 跟 verify.mjs 用同一個完成訊號；狀態列完成後只剩檔名資訊，沒有可以辨認的字。
const t0 = Date.now();
try {
	await page.waitForFunction(
		() => /拖曳/.test(document.getElementById('hint')?.textContent || '')
			|| /失敗|解不開/.test(document.getElementById('status')?.textContent || ''),
		{ timeout: 300000, polling: 500 },
	);
} catch {
	problems.push('等不到分析完成，狀態列停在：' + await page.$eval('#status', e => e.textContent));
}
console.log(`分析耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await new Promise(r => setTimeout(r, 600));   // 多等幾個 frame，讓 canvas 畫完

await page.screenshot({ path: out });
console.log('狀態列:', await page.$eval('#status', e => e.textContent));
if (problems.length) { console.log('\n⚠ 問題:'); problems.forEach(p => console.log('  ' + p)); }
else console.log('沒有 console 錯誤');
await browser.close();
