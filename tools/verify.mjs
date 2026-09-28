// 完整驗收：照計畫的驗證清單跑一遍。
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'wipitch-dl-'));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800 });
const client = await page.createCDPSession();
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });

const problems = [];
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', e => problems.push('pageerror: ' + e.message));

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
};
const hintDone = () => page.waitForFunction(
	() => /：完成|失敗|已復原|已匯出|已存檔|讀檔完成/.test(document.getElementById('hint')?.textContent || ''),
	{ timeout: 120000, polling: 200 });
const dbg = () => page.evaluate(() => window.__debug());

await page.goto('http://localhost:5180/?autoload=/Vocal.wav&t=45&span=6', { waitUntil: 'domcontentloaded' });
const t0 = Date.now();
await page.waitForFunction(() => /拖曳|失敗/.test(document.getElementById('hint')?.textContent || ''), { timeout: 120000, polling: 500 });
check('載入並偵測音高', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);

const box = await (await page.$('#pianoroll')).boundingBox();
const midY = box.y + box.height * 0.45;
const select = async (x0, x1) => {
	await page.mouse.move(box.x + x0, midY);
	await page.mouse.down();
	await page.mouse.move(box.x + x1, midY, { steps: 10 });
	await page.mouse.up();
};

// 1) 選取 + 拖曳改音高
await select(300, 620);
await page.mouse.move(box.x + 460, midY);
await page.mouse.down();
for (const dy of [30, 60, 90]) await page.mouse.move(box.x + 460, midY - dy, { steps: 4 });
await page.mouse.up();
await hintDone();
let d = await dbg();
check('拖曳改音高', d.maxDelta > 0.5 && d.renderDiffRatio > 0.05,
	`maxDelta=${d.maxDelta} 半音，音訊差異比=${d.renderDiffRatio}`);

// 2) 連續 5 次編輯後全部復原，必須逐 sample 回到原始
for (let i = 0; i < 4; i++) {
	await page.$$eval('[data-nudge]', btns => btns.find(b => b.dataset.nudge === '0.1').click());
	await hintDone();
}
const depth = (await dbg()).historyDepth;
for (let i = 0; i < depth; i++) {
	await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
	await hintDone();
}
d = await dbg();
check('連續 5 次編輯後全部復原 → 完全回到原始', d.maxDelta === 0 && d.renderDiffRatio === 0,
	`maxDelta=${d.maxDelta}，與原始差異比=${d.renderDiffRatio}`);

// 3) 壓平抖音
await select(950, 1250);
const before = (await dbg()).wobble;
await page.$eval('#flatten', el => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
await hintDone();
const afterDbg = await dbg();
const after = afterDbg.wobble;
check('壓平抖音', after < before * 0.4, `抖動幅度 ${before} → ${after} 半音（減少 ${((1 - after / before) * 100).toFixed(0)}%）`);
// α=0 的語意是「整段壓成同一個音高」，所以連旋律走向都要被抹平
check('α=0 壓成單一音高', afterDbg.spread < 0.05, `選取範圍內音高標準差 ${afterDbg.spread} 半音`);

// 4) 音量
await page.$eval('#gain', el => { el.value = '-12'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
await hintDone();
check('音量調整', /音量：完成/.test(await page.$eval('#hint', e => e.textContent)), await page.$eval('#hint', e => e.textContent));

// 4.5) 歸零選取段落
await select(300, 620);
await page.$$eval('[data-nudge]', btns => btns.find(b => b.dataset.nudge === '1').click());
await hintDone();
const edited = await dbg();
await page.click('[data-reset="all"]');
await hintDone();
const reset = await dbg();
// 只看選取範圍內：maxDelta 是整個檔案的，會被前面留下的編輯干擾
check('歸零選取段落', edited.selMaxDelta > 0.5 && reset.selMaxDelta < 1e-6,
	`選取範圍內 maxDelta ${edited.selMaxDelta} → ${reset.selMaxDelta}（檔案其他地方的編輯應保留：${reset.maxDelta}）`);

// 重新做一次編輯給後面的存檔測試用
await select(950, 1250);
await page.$eval('#flatten', el => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
await hintDone();

// 5) 存檔 → 讀檔往返
const deltaBefore = await page.evaluate(() => Array.from(window.__debug().selection ? [] : []).length || window.__debug().maxDelta);
await page.click('#save');
await new Promise(r => setTimeout(r, 1500));
const projFile = fs.readdirSync(dl).find(f => f.endsWith('.json'));
check('存檔', !!projFile, projFile ? `${projFile}（${(fs.statSync(path.join(dl, projFile)).size / 1024).toFixed(0)} KB）` : '沒有產生檔案');

if (projFile) {
	const input = await page.$('#open-project');
	await input.uploadFile(path.join(dl, projFile));
	await page.waitForFunction(() => /讀檔完成|讀檔失敗/.test(document.getElementById('hint')?.textContent || ''), { timeout: 180000, polling: 300 });
	const txt = await page.$eval('#hint', e => e.textContent);
	const d2 = await dbg();
	check('讀檔還原曲線', /讀檔完成/.test(txt) && Math.abs(d2.maxDelta - deltaBefore) < 1e-6,
		`${txt}，maxDelta ${deltaBefore} → ${d2.maxDelta}`);
}

// 5.5) Formant
await select(950, 1250);
await page.$eval('#formant', el => { el.value = '-4'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
await hintDone();
const fd = await dbg();
check('Formant 調整', fd.selMaxFormant > 3.9 && /Formant：完成/.test(await page.$eval('#hint', e => e.textContent)),
	`選取範圍內 |formant| = ${fd.selMaxFormant} 半音`);

// 5.6) 滑桿回到中性值要逐位元回到選取當下的狀態（非破壞性參數）
await page.$eval('#formant', el => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
await hintDone();
check('滑桿回中性 → 完全還原', (await dbg()).selMaxFormant < 1e-9,
	`|formant| = ${(await dbg()).selMaxFormant}`);

// 6) 匯出 WAV
await page.click('#export');
await new Promise(r => setTimeout(r, 4000));
const wav = fs.readdirSync(dl).find(f => f.endsWith('.wav'));
if (wav) {
	const buf = fs.readFileSync(path.join(dl, wav));
	const sr = buf.readUInt32LE(24), bits = buf.readUInt16LE(34), ch = buf.readUInt16LE(22);
	const frames = buf.readUInt32LE(40) / (ch * bits / 8);
	check('匯出 WAV', sr === 48000 && bits === 24 && Math.abs(frames / sr - 100.381) < 0.01,
		`${sr}Hz / ${bits}-bit / ${ch}ch / ${(frames / sr).toFixed(3)}s`);
} else check('匯出 WAV', false, '沒有產生檔案');

console.log(`\n${results.filter(r => r.pass).length}/${results.length} 項通過`);
console.log(problems.length ? '⚠ console 錯誤:\n  ' + problems.join('\n  ') : '沒有 console 錯誤');
fs.rmSync(dl, { recursive: true, force: true });
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
