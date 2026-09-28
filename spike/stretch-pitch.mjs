// 伸縮之後的聲音，實際音高跟「原本的音高曲線沒有重算、直接照時間對應拉長」差多少？
//
// 用來決定：伸縮過的音訊要不要重新偵測音高當作新的 ground truth，
// 以及使用者調過的音高在伸縮後要怎麼處理。
//
// 在真正的 App 裡量（真正的 SwiftF0、真正的算繪路徑）。需要先 npm run dev，根目錄要有 Vocal.wav。
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800 });
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto('http://localhost:5180/?autoload=/Vocal.wav', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /拖曳|失敗/.test(document.getElementById('hint')?.textContent || ''), { timeout: 120000, polling: 500 });

const cmp = (a, b) => page.evaluate((a, b) => window.__pitchCompare(a, b), a, b);
const stretch = pairs => page.evaluate(p => window.__stretchForTest(p), pairs);
const undo = async () => { await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await new Promise(r => setTimeout(r, 1500)); };
const fmt = r => r.mapped
	? `中位數 ${String(r.mapped.median).padStart(5)}¢  p90 ${String(r.mapped.p90).padStart(5)}¢  >50¢ ${(r.mapped.over50 * 100).toFixed(1).padStart(4)}%  偏差 ${String(r.mapped.bias).padStart(5)}¢  (n=${r.mapped.n}；對照組 中位數 ${r.control?.median ?? '-'}¢；發聲 ${r.voicing.both}/原有新無 ${r.voicing.origOnly}/新有原無 ${r.voicing.newOnly})`
	: JSON.stringify(r);

// 找幾段發聲比較多的樂句：各 4 秒
const phrases = [[45, 49], [60, 64], [72, 76]];

console.log('音高誤差（伸縮後重新偵測 vs 原本曲線照時間對應拉長），單位 cents\n');
for (const [s, e] of phrases) {
	console.log(`── 樂句 ${s}~${e}s ──`);
	console.log(`  沒有伸縮（基準）    ${fmt(await cmp(s, e))}`);
	for (const ratio of [2, 1.5, 0.5]) {
		const out = s + (e - s) * ratio;
		await stretch([[s, s], [e, out]]);
		console.log(`  ${String(ratio + '×').padEnd(6)}             ${fmt(await cmp(s, out))}`);
		await undo();
	}
}

// 使用者先調過音高（+2 半音、5.5Hz ±0.6 半音抖音），再拉長 2×
console.log('\n── 有編輯的樂句 45~49s：+2 半音 + 5.5Hz 抖音，再伸縮 ──');
await page.evaluate(() => window.__pitchEditForTest(45, 49, 2, 0.6, 5.5));
await new Promise(r => setTimeout(r, 500));
console.log(`  只編輯、沒伸縮      ${fmt(await cmp(45, 49))}`);
for (const ratio of [2, 0.5]) {
	const out = 45 + 4 * ratio;
	await stretch([[45, 45], [49, out]]);
	console.log(`  編輯後 ${String(ratio + '×').padEnd(6)}      ${fmt(await cmp(45, out))}`);
	await undo();
}

await browser.close();
