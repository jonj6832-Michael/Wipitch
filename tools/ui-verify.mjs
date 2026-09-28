// Automation 區的介面驗收：選取黏著、lane 切換、非破壞性參數、畫筆、redo、循環、ramp。
//
// 跟 verify.mjs 分開是因為那支量的是「聲音對不對」，這支量的是「操作對不對」。
// 需要先 npm run dev。
import puppeteer from 'puppeteer';
const results = [];
const check = (name, pass, detail) => {
	results.push(pass);
	console.log(`${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
};
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800 });
const problems = [];
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
const hintDone = () => page.waitForFunction(() => /：完成|失敗/.test(document.getElementById('hint')?.textContent || ''), { timeout: 120000, polling: 200 });
const dbg = () => page.evaluate(() => window.__debug());
const hint = () => page.$eval('#hint', e => e.textContent);

await page.goto('http://localhost:5180/?autoload=/Vocal.wav&t=45&span=6', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /拖曳|失敗/.test(document.getElementById('hint')?.textContent || ''), { timeout: 120000, polling: 500 });

const box = await (await page.$('#pianoroll')).boundingBox();
const midY = box.y + box.height * 0.45;
const select = async (x0, x1) => {
	await page.mouse.move(box.x + x0, midY); await page.mouse.down();
	await page.mouse.move(box.x + x1, midY, { steps: 10 }); await page.mouse.up();
};

// A) 選取黏著：選一段之後點選取範圍外面，選取要留著、播放頭要動
await select(300, 620);
const selBefore = (await dbg()).selection;
await page.mouse.click(box.x + 1000, midY);
const afterClick = await dbg();
// 播放頭讀 __debug 而不是時鐘的文字——時鐘是下一個動畫幀才更新，會讀到舊值
check('點選取範圍外 → 選取保留、播放頭移動',
	JSON.stringify(afterClick.selection) === JSON.stringify(selBefore) && afterClick.playhead > 48,
	`選取 ${JSON.stringify(afterClick.selection)}、播放頭 ${afterClick.playhead}s`);

// B) Esc 才取消
await page.keyboard.press('Escape');
check('Esc 才取消選取', (await dbg()).selection === null);

// C) lane 快捷鍵
await select(300, 620);
await page.keyboard.press('Digit2');
check('數字鍵切換編輯中的 lane', (await dbg()).activeLane === 'gain', await hint());
// 在選取範圍內垂直拖曳 = 改音量
await page.mouse.move(box.x + 460, midY); await page.mouse.down();
for (const dy of [20, 40]) await page.mouse.move(box.x + 460, midY - dy, { steps: 4 });
await page.mouse.up();
await hintDone();
let d = await dbg();
check('在音量 lane 上垂直拖曳只動音量', d.selMaxGainDb > 0.5 && d.selMaxDelta === 0,
	`音量 ${d.selMaxGainDb} dB、音高 ${d.selMaxDelta} 半音`);

// D) 非破壞性：滑桿來回拉回中性
await select(950, 1250);
for (const v of ['0.2', '3.5', '1']) {
	await page.$eval('#flatten', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
	await hintDone();
}
d = await dbg();
check('抖音滑桿 0.2 → 3.5 → 1.00× 完全還原', d.selMaxDelta < 1e-9, `selMaxDelta=${d.selMaxDelta}`);

// E) 畫筆
await page.keyboard.press('Digit1');
await page.keyboard.press('KeyB');
await page.mouse.move(box.x + 700, midY + 40); await page.mouse.down();
await page.mouse.move(box.x + 800, midY - 10, { steps: 8 });
await page.mouse.move(box.x + 900, midY - 60, { steps: 8 });
await page.mouse.up();
await hintDone();
d = await dbg();
check('畫筆在音高 lane 上畫出上行線', d.maxDelta > 0.5, `maxDelta=${d.maxDelta}，${await hint()}`);

// F) Redo
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await hintDone();
const afterUndo = (await dbg()).maxDelta;
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await hintDone();
const afterRedo = (await dbg()).maxDelta;
check('Ctrl+Shift+Z 重做', afterRedo > afterUndo, `maxDelta ${afterUndo} → ${afterRedo}`);

// F+) 畫筆按住 Shift = 直線。在音量 lane 上畫（沒有未發聲的空洞），
// 中途刻意繞一大圈往上，自由畫的話中段會被拉高；直線的話只剩起點到終點那一條。
const laneAt = (id, x) => page.evaluate((id, x) => window.__laneAtX(id, x), id, x);
await page.keyboard.press('Digit2');
await page.mouse.move(box.x + 300, midY + 30); await page.mouse.down();
await page.keyboard.down('Shift');
await page.mouse.move(box.x + 450, midY - 150, { steps: 8 });
await page.mouse.move(box.x + 600, midY - 30, { steps: 8 });
await page.keyboard.up('Shift');
await page.mouse.up();
await hintDone();
const [g1, g2, g3] = [await laneAt('gain', 340), await laneAt('gain', 450), await laneAt('gain', 560)];
check('Shift 畫直線（中途繞路不留痕跡）',
	Math.abs(g2.v - (g1.v + g3.v) / 2) < 0.3 && g3.v > g1.v + 1,
	`x=340 ${g1.v.toFixed(2)}、x=450 ${g2.v.toFixed(2)}、x=560 ${g3.v.toFixed(2)} dB（中點應 ≈ ${((g1.v + g3.v) / 2).toFixed(2)}）`);

// F++) Alt 吸附到整數半音
// 音高變化上限會把「偵測音高有跳動處」的 Δ 拉緩，吸附出來的整數就不再精確——這一項只測吸附本身
await page.$eval('#slope', el => { el.value = '0'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await page.keyboard.press('Digit1');
await page.keyboard.down('Alt');
await page.mouse.move(box.x + 700, midY + 20); await page.mouse.down();
await page.mouse.move(box.x + 900, midY - 25, { steps: 12 });
await page.mouse.up();
await page.keyboard.up('Alt');
await hintDone();
let snapped = 0, voicedN = 0;
for (let x = 720; x <= 880; x += 8) {
	const r = await laneAt('pitch', x);
	if (r.abs === null) continue;
	voicedN++;
	if (Math.abs(r.abs - Math.round(r.abs)) < 0.02) snapped++;
}
check('Alt 吸附到整數半音', voicedN > 5 && snapped === voicedN, `${snapped}/${voicedN} 個發聲格落在整數半音上`);
await page.$eval('#slope', el => { el.value = '60'; el.dispatchEvent(new Event('change', { bubbles: true })); });

// G) 循環播放
await page.keyboard.press('KeyS');
await select(300, 620);
await page.keyboard.press('KeyL');
check('L 開啟循環播放', (await dbg()).looping && /循環播放選取範圍/.test(await hint()), await hint());

// H+) 畫筆的自動抖音
await page.keyboard.press('KeyB');
// 預設是關的：先確認畫出來的線真的沒有抖音，再用 V 打開
await page.mouse.move(box.x + 640, midY); await page.mouse.down();
await page.mouse.move(box.x + 700, midY, { steps: 6 }); await page.mouse.up();
await hintDone();
const vibOffState = await dbg();
await page.keyboard.press('KeyV');
const vibOnState = await dbg();
check('抖音開關預設為關、V 可以切換', vibOffState.vibOn === false && vibOnState.vibOn === true,
	`按 V 之前 ${vibOffState.vibOn}、之後 ${vibOnState.vibOn}`);
await page.$eval('#vib-depth', el => { el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await page.$eval('#vib-rate', el => { el.value = '5.5'; el.dispatchEvent(new Event('change', { bubbles: true })); });
// 按住 Shift 畫一條水平直線：抖音是唯一的起伏來源，同時驗證「直線也帶抖音」
await page.mouse.move(box.x + 1000, midY); await page.mouse.down();
await page.keyboard.down('Shift');
await page.mouse.move(box.x + 1200, midY, { steps: 12 });
await page.keyboard.up('Shift');
await page.mouse.up();
await hintDone();
await page.keyboard.press('KeyS');
await select(1000, 1200);
const vib = await dbg();
check('畫筆的自動抖音（Shift 直線也帶抖音）', vib.wobble > 0.2, `畫出來的線抖動幅度 ${vib.wobble} 半音（畫的是水平直線，起伏只能來自抖音）`);

// H++) 起音漸入：抖音要從落筆處長出來，不是一開始就滿幅度。
// 畫一條夠長的水平線，比「前 0.3 秒」與「後段」的抖動幅度。
await page.keyboard.press('KeyB');
await page.$eval('#vib-onset', el => { el.value = '600'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await page.mouse.move(box.x + 200, midY); await page.mouse.down();
await page.mouse.move(box.x + 1300, midY, { steps: 30 });
await page.mouse.up();
await hintDone();
await page.keyboard.press('KeyS');
// 落筆處往右 0.3 秒
await select(200, 270);
const head = (await dbg()).wobble;
await select(1100, 1300);
const tail = (await dbg()).wobble;
check('抖音的起音漸入', head !== null && tail !== null && head < tail * 0.6,
	`落筆後的前段 ${head} → 後段 ${tail} 半音（漸入 600ms）`);

// 關掉漸入之後，落筆處就該是滿幅度
await page.keyboard.down('Shift'); await page.keyboard.press('KeyV'); await page.keyboard.up('Shift');
await page.keyboard.press('KeyB');   // 上面量測時切回選取工具了，要再切回畫筆
await page.mouse.move(box.x + 200, midY); await page.mouse.down();
await page.mouse.move(box.x + 1300, midY, { steps: 30 });
await page.mouse.up();
await hintDone();
await page.keyboard.press('KeyS');
await select(200, 270);
const headNoOnset = (await dbg()).wobble;
check('Shift+V 可以關掉漸入', (await dbg()).vibOnsetOn === false && headNoOnset > head * 2,
	`同樣的前段：有漸入 ${head} → 關掉 ${headNoOnset} 半音`);
await page.keyboard.down('Shift'); await page.keyboard.press('KeyV'); await page.keyboard.up('Shift');

// 收尾：把抖音關回去，後面的測試不要被影響
await page.keyboard.press('KeyV');
await page.$eval('#vib-onset', el => { el.value = '200'; el.dispatchEvent(new Event('change', { bubbles: true })); });

// H++) Voice / Instrument 模式
await page.click('#mode-instrument');
await hintDone();
const inst = await dbg();
await page.click('#mode-voice');
await hintDone();
check('人聲／樂器模式切換', inst.formantFollow === 1 && (await dbg()).formantFollow === 0,
	`切到樂器 = ${inst.formantFollow}、切回人聲 = ${(await dbg()).formantFollow}`);

// H+++) 算繪進度真的有回報
check('算繪進度有回報', (await dbg()).progressTicks > 0,
	`收到 ${(await dbg()).progressTicks} 次進度更新`);

// H++++) 縱向縮放與捲動
await page.keyboard.press('Digit1');
const v0 = (await dbg()).vRange;
// 滾輪：單獨 = 縱向捲動、Shift = 橫向捲動
await page.mouse.move(box.x + 600, midY);
const startBefore = (await dbg()).startSec;
await page.mouse.wheel({ deltaY: 200 });
const vScrolled = (await dbg()).vRange;
check('滾輪縱向捲動',
	vScrolled.lo !== v0.lo
	&& Math.abs((vScrolled.hi - vScrolled.lo) - (v0.hi - v0.lo)) < 1e-6
	&& (await dbg()).startSec === startBefore,
	`${v0.lo.toFixed(1)}~${v0.hi.toFixed(1)} → ${vScrolled.lo.toFixed(1)}~${vScrolled.hi.toFixed(1)}（寬度不變、橫向沒動）`);

const vBeforeH = (await dbg()).vRange;
await page.keyboard.down('Shift');
await page.mouse.wheel({ deltaY: 200 });
await page.keyboard.up('Shift');
const afterH = await dbg();
check('Shift+滾輪橫向捲動',
	afterH.startSec !== startBefore && afterH.vRange.lo === vBeforeH.lo,
	`startSec ${startBefore} → ${afterH.startSec}（縱向沒動）`);

// 範圍捲軸：拖滑塊端點縮放、雙擊還原（取代以前的縮放滑桿）
const edgeBox = async (bar, edge) => (await page.$(`#${bar} .rb-${edge}`)).boundingBox();
const center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const dragBy = async (from, dx, dy) => {
	await page.mouse.move(from.x, from.y); await page.mouse.down();
	await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 }); await page.mouse.up();
};
const settle = () => new Promise(r => setTimeout(r, 120));   // 滑塊在下一個動畫幀才同步
const dblBar = async bar => { await page.$eval(`#${bar}`, el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await settle(); };

await settle();
const thumbV = await (await page.$('#vbar .rb-thumb')).boundingBox();
const trackV = await (await page.$('#vbar')).boundingBox();
// 上端往下拖 = 上限變低 = 放大
await dragBy(center(await edgeBox('vbar', 'hi')), 0, thumbV.height * 0.4);
const vZoomed = (await dbg()).vRange;
await dblBar('vbar');
const vFit = (await dbg()).vRange;
// 兩端拉到軌道盡頭 = 看得到的範圍最大，要比預設視野更寬
await dragBy(center(await edgeBox('vbar', 'hi')), 0, trackV.y - thumbV.y - 20);
await settle();
const loNow = center(await edgeBox('vbar', 'lo'));
await dragBy(loNow, 0, trackV.y + trackV.height - loNow.y + 20);
const vWide = (await dbg()).vRange;
await dblBar('vbar');
check('縱向可以縮得比預設視野更小', (vWide.hi - vWide.lo) > (v0.hi - v0.lo) * 1.5,
	`預設視野 ${(v0.hi - v0.lo).toFixed(1)} → 縮到最小 ${(vWide.hi - vWide.lo).toFixed(1)} 半音`);

check('縱向範圍捲軸縮放與雙擊還原',
	(vZoomed.hi - vZoomed.lo) < (v0.hi - v0.lo) * 0.9
	&& Math.abs(vFit.lo - v0.lo) < 1e-6 && Math.abs(vFit.hi - v0.hi) < 1e-6,
	`寬度 ${(v0.hi - v0.lo).toFixed(1)} → 放大後 ${(vZoomed.hi - vZoomed.lo).toFixed(1)} → 還原 ${(vFit.hi - vFit.lo).toFixed(1)} 半音`);

// 橫向範圍捲軸
const h0 = (await dbg()).hSpanSec;
const thumbH0 = await (await page.$('#hbar .rb-thumb')).boundingBox();
// 右端往左拖 = 可視範圍變短
await dragBy(center(await edgeBox('hbar', 'hi')), -thumbH0.width * 0.6, 0);
const hIn = (await dbg()).hSpanSec;
await dblBar('hbar');
const hFit = (await dbg()).hSpanSec;
check('橫向範圍捲軸縮放與雙擊看全部', hIn < h0 * 0.5 && hFit > h0,
	`可視長度 ${h0}s → 拖右端 → ${hIn}s → 整段 ${hFit}s`);

// 滾輪改視野時，滑塊要跟著動（雙向同步）
await page.evaluate(() => window.__setView(45, 20));
await settle();
const thumbBefore = (await (await page.$('#hbar .rb-thumb')).boundingBox()).width;
await page.mouse.move(box.x + 600, midY);
await page.keyboard.down('Control');
await page.keyboard.down('Shift');
await page.mouse.wheel({ deltaY: -300 });
await page.keyboard.up('Shift');
await page.keyboard.up('Control');
await settle();
const thumbAfter = (await (await page.$('#hbar .rb-thumb')).boundingBox()).width;
check('Ctrl+Shift+滾輪橫向縮放，範圍捲軸跟著動', thumbAfter < thumbBefore - 1,
	`滑塊寬度 ${thumbBefore.toFixed(1)} → ${thumbAfter.toFixed(1)}px`);

// H) 跟隨播放頭
await page.evaluate(() => window.__setView(45, 6));
await page.keyboard.press('KeyF');
const followOn = (await dbg()).following;
// 把播放頭丟到目前視野的右邊很遠處，跟隨應該要把畫面捲過去
const far = (await dbg()).startSec + (await dbg()).hSpanSec * 4;
await page.evaluate(sec => window.__seekForTest(sec), far);
await new Promise(r => setTimeout(r, 150));
const followed = await dbg();
check('跟隨播放頭', followOn && Math.abs(followed.startSec - (far - followed.hSpanSec * 0.15)) < 0.5,
	`播放頭 ${far.toFixed(2)}s → 視野起點 ${followed.startSec}s（應落在 15% 處）`);
await page.keyboard.press('KeyF');

// I-) 畫筆橫跨未發聲區、音高變化上限
{
	await page.keyboard.press('Escape');
	await page.keyboard.press('Digit1');
	// 先關掉變化上限，確認「畫筆本身」在發聲交界不留階梯
	await page.$eval('#slope', el => { el.value = '0'; el.dispatchEvent(new Event('change', { bubbles: true })); });
	check('音高變化上限可以設成 0（不限制）', (await dbg()).pitchSlopeLimit === 0, await hint());
	await page.keyboard.press('KeyB');
	// 畫一條很長的水平線，橫跨整個視野（6 秒裡一定有換氣或子音）
	await page.mouse.move(box.x + 60, box.y + box.height * 0.3); await page.mouse.down();
	await page.mouse.move(box.x + box.width - 60, box.y + box.height * 0.3, { steps: 40 });
	await page.mouse.up();
	await hintDone();
	await page.keyboard.press('KeyS');
	await select(160, box.width - 160);
	// 只量筆畫內部：筆畫頭尾各有 20ms 的斜坡，那裡本來就會陡
	let s0 = (await dbg()).selPitchStep;
	check('畫筆橫跨未發聲區：發聲交界沒有階梯', s0.unvoiced > 10 && s0.max < 0.3,
		`相鄰格最大差 ${s0.max} 半音（範圍內 ${s0.unvoiced} 個未發聲格）`);
	await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
	await hintDone();

	// 設回 60：把一段往上拉 +12，邊界的斜坡不能比每秒 60 半音還陡
	await page.$eval('#slope', el => { el.value = '60'; el.dispatchEvent(new Event('change', { bubbles: true })); });
	await page.$eval('#ramp', el => { el.value = '5'; el.dispatchEvent(new Event('change', { bubbles: true })); });
	await select(500, 800);
	await page.$eval('#shift', el => { el.value = '12'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
	await hintDone();
	s0 = (await dbg()).selPitchStep;
	// 2ms 一格，60 半音/秒 = 0.12 半音/格
	check('音高變化上限：+12 半音、5ms 邊界過渡仍被拉緩到 60 半音/秒', s0.max <= 0.1201,
		`相鄰格最大差 ${s0.max} 半音（上限 0.12）`);
	await page.$eval('#shift', el => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
	await hintDone();
	check('音高變化上限：滑桿回 0 完全還原', (await dbg()).selMaxDelta < 1e-9, `selMaxDelta=${(await dbg()).selMaxDelta}`);
	await page.$eval('#ramp', el => { el.value = '100'; el.dispatchEvent(new Event('change', { bubbles: true })); });
}

// I) ramp 設定
await page.$eval('#ramp', el => { el.value = '200'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await page.$$eval('[data-nudge]', btns => btns.find(b => b.dataset.nudge === '1').click());
await hintDone();
check('ramp 拉長到 200ms 之後仍能正常算繪', /完成/.test(await hint()), await hint());

// I) 音量 lane 讓波形變粗（比較兩張波形截圖的亮點數）
await page.keyboard.press('Escape');
await select(300, 620);
// 直接數 canvas 上「波形顏色」的像素，比截圖檔案大小可靠得多
const inkInSelection = () => page.evaluate(() => {
	const c = document.getElementById('waveform');
	const ctx = c.getContext('2d');
	const dpr = window.devicePixelRatio || 1;
	const d = ctx.getImageData(300 * dpr, 0, 320 * dpr, c.height).data;
	let ink = 0;
	// 波形是 #4a8fb0；選取底色偏暗，用藍色分量當門檻就分得開
	for (let i = 0; i < d.length; i += 4) if (d[i] > 40 && d[i + 2] > 120) ink++;
	return ink;
});
await page.$eval('#gain', el => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await new Promise(r => setTimeout(r, 300));
const ink0 = await inkInSelection();
await page.$eval('#gain', el => { el.value = '12'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await new Promise(r => setTimeout(r, 300));
const ink12 = await inkInSelection();
// +12dB 是 4 倍振幅，波形像素應該明顯變多（碰到上下邊界才會被夾住）
check('拖音量滑桿時波形立刻變粗（不必等算繪）', ink12 > ink0 * 1.5,
	`選取範圍內的波形像素 ${ink0} → ${ink12}`);

// J) Time stretch 錨點
await page.keyboard.press('Escape');
// 前面的測試動過縮放與捲動，這裡直接指定視野：48~66s
await page.evaluate(() => window.__setView(48, 18));
const wbox = await (await page.$('#waveform')).boundingBox();
const tx = t => page.evaluate(t => window.__timeToX(t), t);
const wy = wbox.y + wbox.height / 2;
const dur0 = (await dbg()).outDuration;
await page.evaluate(() => window.__snapRendered('tail', 60, 62));

await page.keyboard.press('KeyB');
await page.mouse.click(wbox.x + await tx(50), wy);
await page.mouse.click(wbox.x + await tx(52), wy);
d = await dbg();
check('畫筆點波形加錨點（加的當下不改變時間）', d.anchors.length === 2 && Math.abs(d.outDuration - dur0) < 1e-6,
	`錨點 ${JSON.stringify(d.anchors)}、總長 ${d.outDuration}s`);

// 伸縮前記下 50~52s 之間幾個發聲格的絕對音高，伸縮後它們應該出現在 50 + 2·(t − 50)
const probeSrc = [50.2, 50.6, 51.0, 51.4, 51.8];
const pitchBefore = [];
for (const t of probeSrc) pitchBefore.push((await laneAt('pitch', await tx(t))).abs);

// 把 52s 的錨點拖到 54s → 50~52s 拉長一倍
await page.keyboard.press('KeyS');   // 錨點在任何工具下都能拖
await page.mouse.move(wbox.x + await tx(52), wy); await page.mouse.down();
const x54 = await tx(54);
await page.mouse.move(wbox.x + x54, wy, { steps: 6 });
await page.mouse.up();
await hintDone();
d = await dbg();
const a2 = d.anchors[1];
check('拖曳錨點伸縮：總長與算繪長度一起變長', Math.abs(d.outDuration - (dur0 + (a2.out - 52))) < 0.01
	&& Math.abs(d.renderedSec - d.outDuration) < 0.001 && a2.out > 53.8 && a2.out < 54.2,
	`錨點 52 → ${a2.out}s、總長 ${dur0} → ${d.outDuration}s、算繪 ${d.renderedSec}s`);
const stretch = (a2.out - 50) / 2;
const shifted = await page.evaluate(o => window.__compareSnap('tail', o), 60 + (a2.out - 52));
check('錨點之後的聲音只是平移（不重算、逐 sample 相同）', shifted.relErr < 1e-4, JSON.stringify(shifted));

// 畫面 x 是整數像素，一個像素約 16ms，所以在伸縮後的位置 ±1px 內找得到同一個值就算對
let followOk = 0, followN = 0;
for (let k = 0; k < probeSrc.length; k++) {
	if (pitchBefore[k] === null) continue;
	followN++;
	const x = await tx(50 + stretch * (probeSrc[k] - 50));
	for (const dx of [0, -1, 1, -2, 2]) {
		const r = await laneAt('pitch', x + dx);
		if (r.abs !== null && Math.abs(r.abs - pitchBefore[k]) < 0.05) { followOk++; break; }
	}
}
check('音高線跟著伸縮', followN >= 2 && followOk === followN, `${followOk}/${followN} 個取樣點落在伸縮後的位置`);

// K) 歸零 × stretch：在伸縮段內移調再歸零 → 伸縮保留，聲音回到「伸縮但沒移調」
//
// 這一段前面的測試畫過東西，「全部歸零」會連那些舊編輯一起清掉，
// 所以先歸零一次、算好，當作「伸縮、沒有任何編輯」的參考狀態再開始。
const sx0 = await tx(50.7), sx1 = await tx(53.3);
await select(sx0, sx1);
const depthBeforeCleanup = (await dbg()).historyDepth;
await page.$$eval('[data-reset]', btns => btns.find(b => b.dataset.reset === 'all').click());
// 本來就沒有編輯的話不會算繪、也不會進 undo，不能傻等「完成」
await new Promise(r => setTimeout(r, 200));
const stretchSteps = (await dbg()).historyDepth - depthBeforeCleanup;   // 下面復原的步數要算進去
if (stretchSteps > 0) await hintDone();
// 伸縮段的快速重算在接縫處不精確，精確版由背景精算補上——等它算完再拍快照
await page.evaluate(() => window.__waitBackground());
await page.evaluate(() => window.__snapRendered('stretched', 50.5, 53.5));
// 基準：狀態完全不變，只是讓背景串流換一個範圍（起點不同）重算一次。
// 經過伸縮段的輸出跟串流從哪裡開始有關，不會逐 sample 相同；歸零後的差異不該比這個大
await page.evaluate(() => window.__rerenderForTest(46, 58));
await hintDone();
await page.evaluate(() => window.__waitBackground());
const streamBase = await page.evaluate(() => window.__compareSnap('stretched', 50.5));
await page.$$eval('[data-nudge]', btns => btns.find(b => b.dataset.nudge === '1').click());
await hintDone();
await page.evaluate(() => window.__waitBackground());
const afterShift = await page.evaluate(() => window.__compareSnap('stretched', 50.5));
const appliedBefore = (await dbg()).bgApplied;
await page.$$eval('[data-reset]', btns => btns.find(b => b.dataset.reset === 'all').click());
await hintDone();
// 快速重算剛完成時，背景精算應該已經排上（指示燈亮著）
const bgDuring = await dbg();
await page.evaluate(() => window.__waitBackground());
const bgAfter = await dbg();
const afterReset = await page.evaluate(() => window.__compareSnap('stretched', 50.5));
check('伸縮段編輯後會排背景精算，算完指示燈熄滅', bgDuring.bgVisible && (bgDuring.bgWaiting || bgDuring.bgProgress !== null)
	&& !bgAfter.bgVisible && bgAfter.bgApplied > appliedBefore,
	`重算完成時 指示燈=${bgDuring.bgVisible}、等待=${bgDuring.bgWaiting}；算完 指示燈=${bgAfter.bgVisible}、換上次數 ${appliedBefore} → ${bgAfter.bgApplied}`);
d = await dbg();
check('歸零只清數值、伸縮保留', d.anchors.length === 2 && Math.abs(d.anchors[1].out - a2.out) < 1e-6
	&& Math.abs(d.renderedSec - d.outDuration) < 0.001 && d.selMaxDelta === 0,
	`錨點 ${JSON.stringify(d.anchors)}、selMaxDelta=${d.selMaxDelta}`);
// 用頻譜比（±10ms 內最佳）：歸零後要跟「只換串流起點」的基準差不多，而且明顯比移調時更像
check('歸零後（背景精算完）聲音回到「有伸縮、沒移調」',
	afterReset.bestSpecCorr > streamBase.bestSpecCorr - 0.03 && afterReset.bestSpecCorr > afterShift.bestSpecCorr + 0.05,
	`頻譜相關：只換串流起點 ${streamBase.bestSpecCorr}、移調 ${afterShift.bestSpecCorr}、歸零 ${afterReset.bestSpecCorr}`);
const seam = bgAfter.bgStream;
check('背景串流的接縫落在無聲處', seam && seam.fromDb < -35 && seam.toDb < -35,
	seam ? `串流 ${seam.from}~${seam.to}s，接縫音量 ${seam.fromDb} / ${seam.toDb} dB` : '沒有串流紀錄');

// L) 復原／重做包含錨點：reset、nudge、（先清乾淨的 reset）、拖曳 依序復原
await page.keyboard.press('Escape');
for (let k = 0; k < 3 + stretchSteps; k++) {
	await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
	await hintDone();
}
const undone = await dbg();
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await hintDone();
const redone = await dbg();
check('復原／重做錨點拖曳', Math.abs(undone.outDuration - dur0) < 1e-6 && Math.abs(undone.renderedSec - dur0) < 0.001
	&& Math.abs(redone.outDuration - d.outDuration) < 1e-6,
	`復原後 ${undone.outDuration}s（算繪 ${undone.renderedSec}s）、重做後 ${redone.outDuration}s`);

// M) 點選錨點 + Delete：伸縮回復、曲線數值不動、後段聲音回到原位
const maxDeltaBefore = redone.maxDelta;
await page.mouse.click(wbox.x + await tx(redone.anchors[1].out), wy);
const picked = (await dbg()).selectedAnchors[0];
await page.keyboard.press('Delete');
await hintDone();
d = await dbg();
check('Delete 刪除錨點 → 伸縮回復、數值不變', picked === redone.anchors[1].id && d.anchors.length === 1
	&& Math.abs(d.outDuration - dur0) < 1e-6 && Math.abs(d.renderedSec - dur0) < 0.001 && d.maxDelta === maxDeltaBefore,
	`刪掉 #${picked}、總長 ${d.outDuration}s、maxDelta ${maxDeltaBefore} → ${d.maxDelta}`);
// 還剩一個錨點（在原位，沒有伸縮）。背景精算要把之前串流算過的地方還原——
// 中性的地方回到原始音訊，有編輯的地方是 1× 的局部重算，兩者都跟伸縮前一樣
await page.evaluate(() => window.__waitBackground());
const back = await page.evaluate(() => window.__compareSnap('tail', 60));
check('刪除後（背景精算完）錨點之後的聲音回到伸縮前', back.corr > 0.9999, JSON.stringify(back));

// N) Shift 多選錨點一起移動
await page.evaluate(() => window.__setView(56, 18));
await page.keyboard.press('KeyB');
for (const t of [60, 62, 64]) await page.mouse.click(wbox.x + await tx(t), wy);
await page.keyboard.press('KeyS');
let ids = (await dbg()).anchors.filter(a => [60, 62, 64].includes(Math.round(a.src))).map(a => a.id);
await page.mouse.click(wbox.x + await tx(60), wy);
await page.keyboard.down('Shift');
await page.mouse.click(wbox.x + await tx(62), wy);
await page.keyboard.up('Shift');
d = await dbg();
check('Shift+點擊多選錨點', d.selectedAnchors.length === 2 && d.selectedAnchors.includes(ids[0]) && d.selectedAnchors.includes(ids[1]),
	`選取 ${JSON.stringify(d.selectedAnchors)}`);

// 範圍選取：點 60、Shift 點 64 → 中間的 62 也要選到
await page.mouse.click(wbox.x + await tx(60), wy);
await page.keyboard.down('Shift');
await page.mouse.click(wbox.x + await tx(64), wy);
await page.keyboard.up('Shift');
const ranged = (await dbg()).selectedAnchors;
check('Shift+點擊選取中間所有的錨點', ranged.length === 3 && ids.every(id => ranged.includes(id)), `選取 ${JSON.stringify(ranged)}`);
// Ctrl+點擊移出單一個
await page.keyboard.down('Control');
await page.mouse.click(wbox.x + await tx(62), wy);
await page.keyboard.up('Control');
const toggled = (await dbg()).selectedAnchors;
check('Ctrl+點擊移出單一個錨點', toggled.length === 2 && !toggled.includes(ids[1]), `選取 ${JSON.stringify(toggled)}`);

// 回到「60、62 被選取」讓下面的拖曳測試照舊
await page.mouse.click(wbox.x + await tx(60), wy);
await page.keyboard.down('Shift');
await page.mouse.click(wbox.x + await tx(62), wy);
await page.keyboard.up('Shift');
// 拖其中一個（已選的）→ 兩個一起往右 1 秒，64 那個不動
await page.mouse.move(wbox.x + await tx(62), wy); await page.mouse.down();
await page.mouse.move(wbox.x + await tx(63), wy, { steps: 6 });
await page.mouse.up();
await hintDone();
d = await dbg();
const byId = id => d.anchors.find(a => a.id === id);
const moved60 = byId(ids[0]).out - 60, moved62 = byId(ids[1]).out - 62;
check('多選的錨點一起移動、沒選的不動', Math.abs(moved60 - moved62) < 1e-6 && moved60 > 0.9 && moved60 < 1.1 && Math.abs(byId(ids[2]).out - 64) < 1e-6,
	`60 → ${byId(ids[0]).out}、62 → ${byId(ids[1]).out}、64 → ${byId(ids[2]).out}`);
await page.keyboard.press('Delete');
await hintDone();
await page.evaluate(() => window.__waitBackground());
d = await dbg();
check('Delete 一次刪掉所有選取的錨點', d.anchors.every(a => !ids.slice(0, 2).includes(a.id)) && d.anchors.some(a => a.id === ids[2]),
	`剩下 ${JSON.stringify(d.anchors)}`);

// O) 錨點可以拖到原本檔案長度之後（拖到畫面邊緣會自動捲動）
const lastSrc = Math.floor(dur0) - 1;
await page.evaluate(s => window.__setView(s - 12, 18), lastSrc);
await page.keyboard.press('KeyB');
await page.mouse.click(wbox.x + await tx(lastSrc), wy);
await page.keyboard.press('KeyS');
const endId = (await dbg()).anchors.find(a => Math.abs(a.src - lastSrc) < 0.05).id;
await page.mouse.move(wbox.x + await tx(lastSrc), wy); await page.mouse.down();
// 拖到畫面右緣外面停一下，讓自動捲動把錨點帶過檔尾
await page.mouse.move(wbox.x + wbox.width + 30, wy, { steps: 8 });
await new Promise(r => setTimeout(r, 1500));
await page.mouse.up();
await hintDone();
d = await dbg();
const endAnchor = d.anchors.find(a => a.id === endId);
check('錨點可以拖過原本的檔尾', endAnchor.out > dur0 + 1 && d.outDuration > dur0 + 2 && Math.abs(d.renderedSec - d.outDuration) < 0.001,
	`錨點 ${lastSrc}s → ${endAnchor.out.toFixed(2)}s、總長 ${dur0} → ${d.outDuration}s（原檔 ${dur0}s）`);
await page.keyboard.press('Delete');
await hintDone();
await page.evaluate(() => window.__waitBackground());

// P) 波形放大（只影響顯示）
await page.keyboard.press('Escape');
await page.evaluate(() => window.__setView(45, 6));
await new Promise(r => setTimeout(r, 200));
const inkWave = () => page.evaluate(() => {
	const c = document.getElementById('waveform');
	const ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
	const data = ctx.getImageData(300 * dpr, 0, 320 * dpr, c.height).data;
	let ink = 0;
	for (let i = 0; i < data.length; i += 4) if (data[i] > 40 && data[i + 2] > 120) ink++;
	return ink;
});
const amp1 = await inkWave();
// 4× 在對數刻度 0.25~100 上的位置
await page.$eval('#amp-zoom', el => { el.value = String(Math.log(16) / Math.log(400)); el.dispatchEvent(new Event('input', { bubbles: true })); });
await new Promise(r => setTimeout(r, 200));
const amp4 = await inkWave();
const z4 = (await dbg()).ampZoom;
await page.$eval('#amp-zoom', el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
check('波形放大滑桿與雙擊還原', Math.abs(z4 - 4) < 0.05 && amp4 > amp1 * 1.5 && (await dbg()).ampZoom === 1,
	`倍率 ${z4}×、波形像素 ${amp1} → ${amp4}、還原後 ${(await dbg()).ampZoom}×`);

// Q) 拖分隔線調波形軌高度
const split = await (await page.$('#wave-splitter')).boundingBox();
const wh0 = await dbg();
await page.mouse.move(split.x + 200, split.y + split.height / 2); await page.mouse.down();
await page.mouse.move(split.x + 200, split.y + split.height / 2 - 100, { steps: 6 });
await page.mouse.up();
await new Promise(r => setTimeout(r, 100));
const wh1 = await dbg();
await page.$eval('#wave-splitter', el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
await new Promise(r => setTimeout(r, 100));
const wh2 = await dbg();
check('拖分隔線調波形軌高度、雙擊還原', Math.abs(wh1.waveHeight - wh0.waveHeight - 100) <= 2 && wh1.pianoHeight < wh0.pianoHeight - 90 && wh2.waveHeight === wh0.waveHeight,   // 軌道有 1px 下框線，clientHeight 是 149 不是 150，跟拖之前比
	`波形軌 ${wh0.waveHeight} → ${wh1.waveHeight} → ${wh2.waveHeight}px、automation 區 ${wh0.pianoHeight} → ${wh1.pianoHeight}px`);

// R) 背景參考音軌
const durBefore = await dbg();
const bgInput = await page.$('#bg-file');
await bgInput.uploadFile(new URL('../Vocal.wav', import.meta.url).pathname);
await page.waitForFunction(() => window.__debug()?.reference?.name, { timeout: 60000, polling: 200 });
d = await dbg();
check('載入背景音檔（主唱長度不變）', d.reference.name === 'Vocal.wav' && Math.abs(d.reference.duration - 100.381) < 0.01
	&& d.outDuration === durBefore.outDuration && d.renderedSec === durBefore.renderedSec,
	`背景 ${d.reference.name} ${d.reference.duration}s、主唱 ${d.outDuration}s`);

await page.$eval('#bg-vol', el => { el.value = '-12'; el.dispatchEvent(new Event('input', { bubbles: true })); });
const volSet = (await dbg()).reference;
await page.click('#bg-mute');
const muted = (await dbg()).reference;
await page.keyboard.press('KeyM');
const unmuted = (await dbg()).reference;
check('背景音量、靜音鈕、M 鍵', Math.abs(volSet.playerGain - 0.2512) < 0.001 && muted.muted && muted.playerGain === 0
	&& !unmuted.muted && Math.abs(unmuted.playerGain - 0.2512) < 0.001,
	`−12dB → ${volSet.playerGain}、靜音 → ${muted.playerGain}、M → ${unmuted.playerGain}`);

await page.$eval('#bg-offset', el => { el.value = '500'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await page.$$eval('[data-bg-nudge]', btns => btns.find(b => b.dataset.bgNudge === '10').click());
check('背景 offset 輸入與微調', Math.abs((await dbg()).reference.offsetSec - 0.51) < 1e-9, `offset ${(await dbg()).reference.offsetSec}s`);

// 播放中：背景要有 node、seek 與改 offset 之後仍然只有一條
await page.evaluate(() => window.__seekForTest(30));
await page.keyboard.press('Space');
await new Promise(r => setTimeout(r, 400));
const playing1 = await dbg();
await page.evaluate(() => window.__seekForTest(60));
await page.$$eval('[data-bg-nudge]', btns => btns.find(b => b.dataset.bgNudge === '-10').click());
await new Promise(r => setTimeout(r, 200));
const playing2 = await dbg();
await page.keyboard.press('Space');
const stopped = await dbg();
check('播放時背景一起播，seek／改 offset 不出錯，暫停後停止', playing1.playing && playing1.reference.nodeActive
	&& playing2.reference.nodeActive && !stopped.playing && !stopped.reference.nodeActive,
	`播放 ${playing1.reference.nodeActive} → seek+改 offset ${playing2.reference.nodeActive} → 暫停 ${stopped.reference.nodeActive}`);

await page.click('#bg-remove');
d = await dbg();
check('移除背景', d.reference.name === null && d.reference.duration === 0, JSON.stringify(d.reference));

check('沒有 console 錯誤', problems.length === 0, problems.join(' / '));

console.log(`\n${results.filter(Boolean).length}/${results.length} 項通過`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
