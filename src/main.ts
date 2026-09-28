import { decodeFile, decodeAudio, fmtTime, type Source } from './audio/decode';
import { ViewState } from './view/viewstate';
import { WaveformView, RefWaveformView, drawOverview } from './view/waveform';
import { RangeBar } from './view/rangebar';
import { PianoRollView } from './view/pianoroll';
import { Player } from './engine/player';
import { Renderer } from './engine/renderer';
import { detectPitch } from './analysis/pitch';
import { hzToMidi, midiToName, frameTime, HOP, CENTER_OFFSET, type PitchTrack } from './analysis/swiftf0';
import { Curves, LANES, LANE_IDS, PEN_RAMP_SEC, DEFAULT_PITCH_SLOPE_LIMIT, CURVE_HOP_SEC, CURVE_SUB, upsample, upsampleVoiced, type LaneId } from './model/curves';
import { offsetLane, resetLane, resetAll, drawLane, flattenRange, fillGaps, limitSlope, slopeMarginFrames } from './model/edits';
import { History } from './model/history';
import { TimeMap } from './model/timemap';
import { encodeWav24, downloadBlob } from './audio/wav';
import { serialize, deserialize, type BackgroundSettings } from './model/project';

const el = {
	file: document.getElementById('file') as HTMLInputElement,
	play: document.getElementById('play') as HTMLButtonElement,
	stop: document.getElementById('stop') as HTMLButtonElement,
	clock: document.getElementById('clock')!,
	status: document.getElementById('status')!,
	stage: document.getElementById('stage')!,
	pitchTrack: document.getElementById('pitch-track')!,
	waveform: document.getElementById('waveform') as HTMLCanvasElement,
	pianoroll: document.getElementById('pianoroll') as HTMLCanvasElement,
	pianoKeys: document.getElementById('piano-keys')!,
	hint: document.getElementById('hint')!,
	panel: document.getElementById('panel')!,
	selInfo: document.getElementById('sel-info')!,
	shift: document.getElementById('shift') as HTMLInputElement,
	shiftOut: document.getElementById('shift-out')!,
	flatten: document.getElementById('flatten') as HTMLInputElement,
	flattenOut: document.getElementById('flatten-out')!,
	gain: document.getElementById('gain') as HTMLInputElement,
	gainOut: document.getElementById('gain-out')!,
	formant: document.getElementById('formant') as HTMLInputElement,
	formantOut: document.getElementById('formant-out')!,
	modeVoice: document.getElementById('mode-voice') as HTMLButtonElement,
	modeInstrument: document.getElementById('mode-instrument') as HTMLButtonElement,
	progress: document.getElementById('progress')!,
	progressBar: document.getElementById('progress-bar')!,
	penOpts: document.getElementById('pen-opts')!,
	hbar: document.getElementById('hbar')!,
	vbar: document.getElementById('vbar')!,
	vibDepth: document.getElementById('vib-depth') as HTMLInputElement,
	vibRate: document.getElementById('vib-rate') as HTMLInputElement,
	vibOnset: document.getElementById('vib-onset') as HTMLInputElement,
	vibOn: document.getElementById('vib-on') as HTMLInputElement,
	vibOnsetOn: document.getElementById('vib-onset-on') as HTMLInputElement,
	vibUnit: document.getElementById('vib-unit')!,
	laneChips: document.getElementById('lane-chips')!,
	toolSelect: document.getElementById('tool-select') as HTMLButtonElement,
	toolPen: document.getElementById('tool-pen') as HTMLButtonElement,
	loopBtn: document.getElementById('loop-btn') as HTMLButtonElement,
	followBtn: document.getElementById('follow-btn') as HTMLButtonElement,
	clearSel: document.getElementById('clear-sel') as HTMLButtonElement,
	globalBar: document.getElementById('global-bar')!,
	waveTrack: document.getElementById('wave-track')!,
	exportBtn: document.getElementById('export') as HTMLButtonElement,
	saveBtn: document.getElementById('save') as HTMLButtonElement,
	openProject: document.getElementById('open-project') as HTMLInputElement,
	bgStatus: document.getElementById('bg-status')!,
	bgText: document.getElementById('bg-text')!,
	refFile: document.getElementById('bg-file') as HTMLInputElement,
	refName: document.getElementById('bg-name')!,
	refControls: document.getElementById('bg-controls')!,
	refMute: document.getElementById('bg-mute') as HTMLButtonElement,
	refVol: document.getElementById('bg-vol') as HTMLInputElement,
	refVolOut: document.getElementById('bg-vol-out')!,
	refOffset: document.getElementById('bg-offset') as HTMLInputElement,
	refRemove: document.getElementById('bg-remove') as HTMLButtonElement,
	waveSplitter: document.getElementById('wave-splitter')!,
	ampZoom: document.getElementById('amp-zoom') as HTMLInputElement,
	refwave: document.getElementById('refwave') as HTMLCanvasElement,
	refSplitter: document.getElementById('ref-splitter')!,
	refAmpZoom: document.getElementById('ref-amp-zoom') as HTMLInputElement,
	refFileText: document.getElementById('bg-file-text')!,
	ramp: document.getElementById('ramp') as HTMLInputElement,
	slope: document.getElementById('slope') as HTMLInputElement,
};

const view = new ViewState();
const waveform = new WaveformView(el.waveform, view);
const refWave = new RefWaveformView(el.refwave, view);
const pianoroll = new PianoRollView(el.pianoroll, view, el.pianoKeys);
const player = new Player();
const renderer = new Renderer();
const history = new History();

let source: Source | null = null;
let track: PitchTrack | null = null;
let curves: Curves | null = null;
let selection: { start: number; end: number } | null = null;
let baseInfo = '';
let busy = false;
let tool: 'select' | 'pen' = 'select';
/** 正在算繪的時間範圍（秒）。畫在兩個 canvas 上，讓使用者看得到「是這一段在跑」 */
let renderingRange: { start: number; end: number } | null = null;
/** 偵測到的音高，換算成 MIDI 半音刻度。壓平與畫筆都要用。 */
/** 偵測音高（MIDI）內插到曲線格（2ms）上，索引跟 curves 一致 */
let pitchMidi: Float32Array | null = null;
/** 發聲旗標放到曲線格上，索引跟 curves 一致 */
let curveVoiced: Uint8Array | null = null;
/**
 * pitchMidi 的未發聲空隙用兩側的值線性內插補滿。畫筆換算 Δ 用這一份。
 *
 * 畫筆以前遇到未發聲的格子就跳過不改，交界一側是畫的值、另一側是舊值（常常是 0），
 * Δ 在那裡是一個階梯。SwiftF0 常把音符起音的前一兩格判成未發聲，所以階梯正好落在
 * 「起音之後」——算繪出來起音的前 ~20ms 就是沒被移調的聲音
 * （spike/onset-truth.mjs：+12 半音的階梯晚 20ms，起音前 20ms 平均差 504 cents）。
 */
let pitchMidiFilled: Float32Array | null = null;

/**
 * 目前選取範圍在「還沒被面板參數改動」時的曲線狀態。
 *
 * 選取存在期間這份快照**不會更新**，所有面板參數都是從它重新套用一次。
 * 這就是「參數是活的」的關鍵：滑桿可以自由來回拉、互相疊加，
 * 拉回中性值就逐位元等於選取當下的狀態，不會像舊版那樣每動一次就疊加一層。
 */
let selBase: Curves | null = null;
/** 這一輪選取編輯有沒有已經把 selBase 推進 undo 堆疊了 */
let sessionPushed = false;

/** 面板上的活參數。全部都是「相對於 selBase」的量。 */
const params = { shift: 0, alpha: 1, gainDb: 0, formant: 0 };

const status = (msg: string) => { el.status.textContent = msg; };

// ── 兩個時間軸 ──────────────────────────────────────────────────────────
//
// 曲線與音高偵測存在「原始時間」，畫面、播放頭、選取在「輸出時間」（time stretch 之後）。
// 所有要動曲線的地方都先經過 toSrc；所有要交給畫面或算繪器的時間都是輸出時間。

const toSrc = (t: number) => curves ? curves.timeMap.outToSrc(t) : t;
const toOut = (t: number) => curves ? curves.timeMap.srcToOut(t) : t;

/** 選取範圍換成原始時間 */
function srcSel(): { start: number; end: number } | null {
	return selection && { start: toSrc(selection.start), end: toSrc(selection.end) };
}

/** 伸縮之後的總長（秒） */
function outDuration(): number {
	if (!source) return 0;
	return curves ? curves.timeMap.srcToOut(source.duration) : source.duration;
}

/** 目前被選取的錨點（id）。Shift+點擊可以多選；拖曳時一起移動，按 Delete 一起刪掉 */
const selectedAnchors = new Set<number>();

/**
 * 算繪進度。
 *
 * 一段長的畫筆或讀檔的整段重算要好幾秒，只有一行「算繪中…」的話，
 * 使用者分不出是在跑還是當掉了。除了進度條，還要在軌道上標出「哪一段在重算」。
 */
let progressTicks = 0;   // 測試用：確認進度真的有回報，不是只有一個假的進度條
renderer.onProgress = f => {
	progressTicks++;
	el.progressBar.style.width = `${(f * 100).toFixed(1)}%`;
};
function showProgress(range: { start: number; end: number } | null) {
	renderingRange = range;
	el.progress.hidden = !range;
	if (range) el.progressBar.style.width = '0%';
}
const hint = (msg: string) => { el.hint.textContent = msg; };

// ── 載入 ────────────────────────────────────────────────────────────────

async function load(file: File) {
	status(`解碼 ${file.name}…`);
	try {
		source = await decodeFile(file);
	} catch (e) {
		status(`解不開這個檔案：${(e as Error).message}`);
		return;
	}

	view.duration = source.duration;
	view.fit(el.waveform.clientWidth || 1200);
	waveform.setSource(source);

	// Δ 全為 0 時算繪輸出等於輸入，所以一開始不用整段算繪，直接用原始音訊。
	// 只有被編輯過的區域才需要進 Rubber Band。
	await renderer.init(source.channels, source.sampleRate);
	player.setAudio(renderer.rendered, source.sampleRate);

	el.stage.hidden = false;
	el.globalBar.hidden = false;
	el.play.disabled = el.stop.disabled = false;

	baseInfo = `${source.name} · ${source.sampleRate}Hz · ${fmtTime(source.duration)}`;
	status(`${baseInfo} · 偵測音高中…`);
	try {
		track = await detectPitch(source.mono16k, f => status(`${baseInfo} · 偵測音高中… ${(f * 100).toFixed(0)}%`));
	} catch (e) {
		status(`${baseInfo} · 音高偵測失敗：${(e as Error).message}`);
		return;
	}
	pianoroll.setTrack(track);
	curves = new Curves(track.length * CURVE_SUB);
	history.reset(curves);
	syncRampInputs();

	pitchMidi = upsample(track.f0.map(hzToMidi));
	curveVoiced = upsampleVoiced(track.voiced);
	pitchMidiFilled = fillGaps(pitchMidi, curveVoiced, 0, pitchMidi.length);

	el.exportBtn.disabled = el.saveBtn.disabled = false;

	applyDevParams();
	status(baseInfo);
	hint('拖曳選取一段，用面板調整；1/2/3 切換音高・音量・Formant，B 切畫筆');
}

function applyDevParams() {
	const p = new URLSearchParams(location.search);
	if (!p.has('t') && !p.has('span')) return;
	const span = parseFloat(p.get('span') || '6');
	view.secPerPx = span / (el.pianoroll.clientWidth || 1200);
	view.startSec = Math.max(0, parseFloat(p.get('t') || '0'));
	player.seek(view.startSec);
}

el.file.addEventListener('change', () => { const f = el.file.files?.[0]; if (f) load(f); });

const autoload = new URLSearchParams(location.search).get('autoload');
if (autoload) {
	fetch(autoload).then(r => r.blob())
		.then(b => load(new File([b], autoload.split('/').pop() || 'audio.wav')))
		.catch(e => status(`autoload 失敗：${e.message}`));
}

document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', e => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
document.addEventListener('drop', e => {
	e.preventDefault();
	document.body.classList.remove('dragging');
	const f = e.dataTransfer?.files?.[0];
	if (f) load(f);
});

// ── 播放 ────────────────────────────────────────────────────────────────

const syncPlayButton = () => {
	// 只放圖示省空間，文字說明在 tooltip
	el.play.textContent = player.isPlaying ? '‖' : '▶';
	el.play.title = player.isPlaying ? '暫停（空白鍵）' : '播放（空白鍵）';
};
const togglePlay = () => { player.isPlaying ? player.pause() : player.play(); syncPlayButton(); };

el.play.addEventListener('click', togglePlay);
el.stop.addEventListener('click', () => { player.pause(); player.seek(0); syncPlayButton(); });
player.onEnded = syncPlayButton;

/**
 * 跟隨播放頭。
 *
 * 做成「翻頁」而不是「一直把播放頭釘在中央」：連續捲動時曲線一直在動，
 * 很難看清楚形狀，而且使用者播放中手動捲去看別的地方會立刻被搶回來。
 * 播放頭跑到右側 85% 才翻一頁，讓它落在 15% 的位置。
 */
let followPlayhead = false;
function toggleFollow() {
	followPlayhead = !followPlayhead;
	el.followBtn.classList.toggle('on', followPlayhead);
	hint(followPlayhead ? '跟隨播放頭' : '跟隨播放頭已關閉');
}

function applyFollow(pos: number) {
	if (!followPlayhead || !source) return;
	const w = el.pianoroll.clientWidth;
	const span = w * view.secPerPx;
	const rel = (pos - view.startSec) / span;
	if (rel >= 0.85 || rel < 0) {
		view.scrollBy((pos - view.startSec - span * 0.15) / view.secPerPx, w);
	}
}

function toggleLoop() {
	if (player.loopRegion) {
		player.setLoop(null);
	} else {
		if (!selection) { hint('要先選一段才能循環'); return; }
		player.setLoop({ ...selection });
	}
	el.loopBtn.classList.toggle('on', !!player.loopRegion);
	hint(player.loopRegion ? '循環播放選取範圍' : '循環已關閉');
}
el.loopBtn.addEventListener('click', toggleLoop);
el.followBtn.addEventListener('click', toggleFollow);

// ── 工具與 lane 切換 ────────────────────────────────────────────────────

function setTool(t: 'select' | 'pen') {
	tool = t;
	el.toolSelect.classList.toggle('on', t === 'select');
	el.toolPen.classList.toggle('on', t === 'pen');
	el.pitchTrack.classList.toggle('pen', t === 'pen');
	el.waveTrack.classList.toggle('pen', t === 'pen');
	// 選取保留：切去畫筆畫幾筆再切回來，還是同一段可以繼續調
	syncToolbar();
}

/**
 * 工具列左半邊只放「現在能用的東西」：
 *   選取工具、沒選取 → 空
 *   選取工具、有選取 → 參數面板
 *   畫筆工具         → 畫筆選項
 * 工具列那一列一直都在（右邊有工具與 lane 切換），所以左邊換內容不會讓版面跳動。
 */
function syncToolbar() {
	el.penOpts.hidden = tool !== 'pen';
	el.panel.hidden = tool !== 'select' || !selection;
}
/**
 * 畫筆的抖音開關。
 *
 * 有了開關之後，幅度就不必再用 0 當「關閉」的代名詞了——關掉時數值留著，
 * 下次打開就是上次的設定，不用重打一次。
 */
function toggleVib(box: HTMLInputElement) {
	box.checked = !box.checked;
	syncPenOpts();
	const what = box === el.vibOn ? '抖音' : '抖音漸入';
	hint(`畫筆的${what}：${box.checked ? '開' : '關'}`);
}

function syncPenOpts() {
	el.vibDepth.disabled = el.vibRate.disabled = !el.vibOn.checked;
	// 漸入只有在抖音本身開著的時候才有意義
	el.vibOnsetOn.disabled = !el.vibOn.checked;
	el.vibOnset.disabled = !el.vibOn.checked || !el.vibOnsetOn.checked;
}
el.vibOn.addEventListener('change', syncPenOpts);
el.vibOnsetOn.addEventListener('change', syncPenOpts);
syncPenOpts();

el.toolSelect.addEventListener('click', () => setTool('select'));
el.toolPen.addEventListener('click', () => setTool('pen'));

// lane 的「顯示／編輯」小按鈕
for (const id of LANE_IDS) {
	const chip = document.createElement('div');
	chip.className = 'lane-chip';
	chip.innerHTML =
		`<button class="eye" data-eye="${id}" title="顯示 ${LANES[id].label}（Shift+${LANE_IDS.indexOf(id) + 1}）">●</button>` +
		`<button class="pick" data-pick="${id}" title="編輯 ${LANES[id].label}（${LANE_IDS.indexOf(id) + 1}）">${LANES[id].label}</button>`;
	el.laneChips.appendChild(chip);
	const eye = chip.querySelector('.eye') as HTMLElement;
	eye.style.color = LANES[id].color;
	eye.addEventListener('click', () => toggleLaneVisible(id));
	chip.querySelector('.pick')!.addEventListener('click', () => setActiveLane(id));
}

function setActiveLane(id: LaneId) {
	pianoroll.active = id;
	el.vibUnit.textContent = LANES[id].unit;
	// 要編輯的 lane 一定要看得見，不然會對著看不到的線亂調
	pianoroll.visible.add(id);
	// 面板只放目前這條 lane 的滑桿（抖動只作用在音高，歸在 pitch）
	el.panel.querySelectorAll<HTMLElement>('[data-lane]').forEach(g => { g.hidden = g.dataset.lane !== id; });
	syncLaneChips();
	hint(`編輯對象：${LANES[id].label}`);
}

function toggleLaneVisible(id: LaneId) {
	if (pianoroll.visible.has(id)) {
		if (id === pianoroll.active) { hint('正在編輯的那條不能隱藏'); return; }
		pianoroll.visible.delete(id);
	} else {
		pianoroll.visible.add(id);
	}
	syncLaneChips();
}

function syncLaneChips() {
	for (const id of LANE_IDS) {
		el.laneChips.querySelector(`[data-eye="${id}"]`)!.classList.toggle('on', pianoroll.visible.has(id));
		el.laneChips.querySelector(`[data-pick="${id}"]`)!.classList.toggle('on', pianoroll.active === id);
	}
}
setActiveLane('pitch');
setTool('select');
selectionChanged();

// ── 鍵盤 ────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
	if (e.target instanceof HTMLInputElement) return;
	// Alt 是畫筆的吸附鍵；不擋的話 Firefox 放開 Alt 會跳出選單列
	if (e.key === 'Alt') e.preventDefault();
	const digit = ['1', '2', '3'].indexOf(e.key);
	if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
	else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
		e.preventDefault();
		e.shiftKey ? redo() : undo();
	}
	else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
		e.preventDefault();
		if (!source || !curves) return;
		selection = { start: 0, end: outDuration() };
		selectionChanged();
		hint(`全選 ${fmtTime(selection.start)} ~ ${fmtTime(selection.end)}`);
	}
	else if (e.key === 'Escape') { clearSelection(); selectedAnchors.clear(); hint('選取已取消'); }
	else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnchors.size) {
		e.preventDefault();
		deleteAnchors([...selectedAnchors]);
	}
	else if (digit >= 0) { e.shiftKey ? toggleLaneVisible(LANE_IDS[digit]) : setActiveLane(LANE_IDS[digit]); }
	else if (e.key.toLowerCase() === 's') setTool('select');
	else if (e.key.toLowerCase() === 'b') setTool('pen');
	else if (e.key.toLowerCase() === 'l') toggleLoop();
	else if (e.key.toLowerCase() === 'f') toggleFollow();
	else if (e.key.toLowerCase() === 'm') toggleRefMute();
	// 漸入是抖音的子選項，所以掛在同一個鍵的 Shift 上
	else if (e.key.toLowerCase() === 'v') toggleVib(e.shiftKey ? el.vibOnsetOn : el.vibOn);
});

async function undo() {
	if (!curves || busy) return;
	const prev = history.undo(curves);
	if (!prev) { hint('沒有東西可以復原了'); return; }
	await swapCurves(prev, '復原');
}

async function redo() {
	if (!curves || busy) return;
	const next = history.redo(curves);
	if (!next) { hint('沒有東西可以重做了'); return; }
	await swapCurves(next, '重做');
}

/** 換上另一份曲線（含錨點），只重算跟現在不同的那一段 */
async function swapCurves(next: Curves, label: string) {
	const prev = curves!;
	const changed = diffRange(prev, next);   // 原始時間
	curves = next;
	const mapChanged = !prev.timeMap.equals(next.timeMap);
	let dirty: { from: number; to: number } | null = null;
	if (mapChanged) {
		remapSelection(prev.timeMap, next.timeMap);
		for (const id of selectedAnchors) if (!next.timeMap.get(id)) selectedAnchors.delete(id);
		dirty = applyTimeMap();
	}
	syncRampInputs();
	// 曲線被整個換掉了，選取的基準也要跟著換，不然下一次調滑桿會套在舊狀態上
	selBase = selection ? curves.clone() : null;
	sessionPushed = false;
	resetParams();

	const ranges = [dirty, changed && { from: toOut(changed.from), to: toOut(changed.to) }]
		.filter((r): r is { from: number; to: number } => !!r);
	if (ranges.length) {
		await rerender(Math.min(...ranges.map(r => r.from)), Math.max(...ranges.map(r => r.to)), label);
	} else {
		hint(`已${label}`);
	}
}

// ── Time stretch 錨點 ───────────────────────────────────────────────────

/**
 * 把 curves.timeMap 套到算繪器上。回傳伸縮倍率有變、必須重算的輸出範圍。
 * 伸縮沒變的段落算繪器會自己從舊 buffer 搬過去，所以不必整段重算。
 */
function applyTimeMap(): { from: number; to: number } | null {
	if (!curves) return null;
	const dirty = renderer.setTimeMap(curves.timeMap);
	view.duration = outDuration();
	player.setAudio(renderer.rendered, renderer.sampleRate);
	return dirty;
}

/** 錨點變動之後，選取與循環範圍要跟著內容走（黏在原始時間上），不是停在原本的秒數 */
function remapSelection(from: TimeMap, to: TimeMap) {
	const move = (t: number) => to.srcToOut(from.outToSrc(t));
	if (selection) selection = { start: move(selection.start), end: move(selection.end) };
	const loop = player.loopRegion;
	if (loop) player.setLoop({ start: move(loop.start), end: move(loop.end) });
}

const ANCHOR_HIT_PX = 6;

/** 波形條上 x 附近的錨點 */
function anchorAtX(x: number): number | null {
	if (!curves) return null;
	let best: number | null = null, bestD = ANCHOR_HIT_PX;
	for (const a of curves.timeMap.anchors) {
		const d = Math.abs(view.timeToX(a.out) - x);
		if (d <= bestD) { best = a.id; bestD = d; }
	}
	return best;
}

function describeAnchors(delta = 0): string {
	if (!curves || !selectedAnchors.size) return '';
	if (selectedAnchors.size > 1) {
		return `選取 ${selectedAnchors.size} 個錨點${delta ? `，一起移動 ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s` : ''}　Shift+點擊選範圍、Ctrl+點擊加減、Delete 刪除`;
	}
	const a = curves.timeMap.get([...selectedAnchors][0]);
	if (!a) return '';
	// 顯示錨點左邊那一段的倍率——拖曳時變的就是它
	const ratio = curves.timeMap.ratioAt(a.src - 1e-9);
	return `錨點：原 ${fmtTime(a.src)} → ${fmtTime(a.out)}（左段 ${ratio.toFixed(2)}×）　Shift+點擊選範圍、Ctrl+點擊加減、Delete 刪除`;
}

async function deleteAnchors(ids: number[]) {
	if (!curves || busy) return;
	const before = curves.clone();
	let removed = 0;
	for (const id of ids) if (curves.timeMap.remove(id)) removed++;
	if (!removed) return;
	history.push(before);
	selectedAnchors.clear();
	remapSelection(before.timeMap, curves.timeMap);
	const dirty = applyTimeMap();
	const label = removed > 1 ? `刪除 ${removed} 個錨點` : '刪除錨點';
	if (dirty) await rerender(dirty.from, dirty.to, label);
	else hint(`已${label}`);
}

/** Shift+點擊範圍選取的起點：上一次不按 Shift 點到的錨點 */
let anchorPivot: number | null = null;

/** 拖曳中的錨點群組。base 是按下時的狀態，所有位移都從它算，來回拖不會累積誤差 */
let anchorDrag: { base: Curves; startT: number; x: number; moved: boolean } | null = null;

el.waveform.addEventListener('pointerdown', e => {
	if (!source) return;
	const x = e.clientX - el.waveform.getBoundingClientRect().left;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(x)));

	// 錨點在任何工具下都能選取與拖曳
	const hit = curves && !busy ? anchorAtX(x) : null;
	if (hit !== null) {
		const list = curves!.timeMap.anchors;
		if (e.shiftKey && anchorPivot !== null && curves!.timeMap.get(anchorPivot)) {
			// Shift+點擊：從上次點的錨點到這個之間全部選起來（跟檔案總管一樣，取代原本的選取）
			const i = list.findIndex(a => a.id === anchorPivot), j = list.findIndex(a => a.id === hit);
			selectedAnchors.clear();
			for (let k = Math.min(i, j); k <= Math.max(i, j); k++) selectedAnchors.add(list[k].id);
		} else if (e.ctrlKey || e.metaKey) {
			// Ctrl/Cmd+點擊：加入或移出單一個。移出的話就不拖了
			anchorPivot = hit;
			if (selectedAnchors.has(hit)) { selectedAnchors.delete(hit); hint(describeAnchors()); return; }
			selectedAnchors.add(hit);
		} else {
			anchorPivot = hit;
			// 點在沒選到的錨點上 = 只選它；點在已選的錨點上 = 保留整群，準備一起拖
			if (!selectedAnchors.has(hit)) {
				selectedAnchors.clear();
				selectedAnchors.add(hit);
			}
		}
		anchorDrag = { base: curves!.clone(), startT: view.xToTime(x), x, moved: false };
		el.waveform.setPointerCapture(e.pointerId);
		hint(describeAnchors());
		return;
	}
	// 畫筆工具點波形 = 加錨點。加錨點本身不改變對應，所以不必重算
	if (tool === 'pen' && curves && !busy) {
		const before = curves.clone();
		const a = curves.timeMap.add(t);
		if (!a) { hint('這裡跟既有的錨點重疊了'); return; }
		history.push(before);
		if (!e.shiftKey) selectedAnchors.clear();
		selectedAnchors.add(a.id);
		applyTimeMap();
		hint(`加入錨點 ${fmtTime(t)}（拖曳來伸縮，Shift+點擊多選，Delete 刪除）`);
		return;
	}
	if (!e.shiftKey) selectedAnchors.clear();
	// 其餘 = 拉選取範圍；沒拖動就放開只是定位播放頭
	waveSelect = { anchor: t, moved: false };
	el.waveform.setPointerCapture(e.pointerId);
});

/**
 * 波形軌（主波形與參考音軌）上的選取拖曳。波形軌沒有縱向改曲線的語意，
 * 所以在既有選取範圍內按下也是重新拉選取。
 */
let waveSelect: { anchor: number; moved: boolean } | null = null;

function waveSelectMove(canvas: HTMLCanvasElement, clientX: number) {
	if (!waveSelect || !source) return;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(clientX - canvas.getBoundingClientRect().left)));
	if (Math.abs(t - waveSelect.anchor) >= 0.01) waveSelect.moved = true;
	if (!waveSelect.moved) return;
	selection = { start: Math.min(waveSelect.anchor, t), end: Math.max(waveSelect.anchor, t) };
	hint(`選取 ${fmtTime(selection.start)} ~ ${fmtTime(selection.end)}（${(selection.end - selection.start).toFixed(2)}s）`);
}

function waveSelectEnd(canvas: HTMLCanvasElement, pointerId: number) {
	if (!waveSelect) return;
	const s = waveSelect;
	waveSelect = null;
	canvas.releasePointerCapture(pointerId);
	if (!s.moved) player.seek(s.anchor);
	else selectionChanged();
}

/** 依游標位置更新拖曳中的錨點群組 */
function dragAnchorsTo(x: number) {
	if (!anchorDrag || !curves) return;
	anchorDrag.x = x;
	// 只夾在沒選到的相鄰錨點之間（TimeMap.moveGroup 處理），不設倍率上下限，也可以拖過檔尾
	const d = curves.timeMap.moveGroup(anchorDrag.base.timeMap, selectedAnchors, view.xToTime(x) - anchorDrag.startT);
	if (d !== 0) anchorDrag.moved = true;
	view.duration = outDuration();
	hint(describeAnchors(d));
}

el.waveform.addEventListener('pointermove', e => {
	if (waveSelect) { waveSelectMove(el.waveform, e.clientX); return; }
	if (!anchorDrag) {
		// 滑到錨點把手上 = 顯示可以左右拖；其他地方交還給 CSS（畫筆模式有自己的游標）
		const x = e.clientX - el.waveform.getBoundingClientRect().left;
		el.waveform.style.cursor = curves && anchorAtX(x) !== null ? 'ew-resize' : '';
		return;
	}
	dragAnchorsTo(e.clientX - el.waveform.getBoundingClientRect().left);
});

/**
 * 拖曳錨點時游標超出畫面左右邊緣就自動捲動（每一幀呼叫）。
 * 滑鼠停著不動也要繼續捲，所以不能只靠 pointermove。
 */
function autoScrollAnchorDrag() {
	if (!anchorDrag) return;
	const w = el.waveform.clientWidth, edge = 24;
	const over = anchorDrag.x > w - edge ? anchorDrag.x - (w - edge) : anchorDrag.x < edge ? anchorDrag.x - edge : 0;
	if (!over) return;
	view.scrollBy(Math.max(-40, Math.min(40, over * 0.5)), w);
	dragAnchorsTo(anchorDrag.x);
}

el.waveform.addEventListener('pointerup', async e => {
	if (waveSelect) { waveSelectEnd(el.waveform, e.pointerId); return; }
	if (!anchorDrag || !curves) return;
	const { base } = anchorDrag;
	anchorDrag = null;
	el.waveform.releasePointerCapture(e.pointerId);
	if (base.timeMap.equals(curves.timeMap)) return;
	history.push(base);
	remapSelection(base.timeMap, curves.timeMap);
	const dirty = applyTimeMap();
	if (dirty) await rerender(dirty.from, dirty.to, '伸縮');
});

// ── 選取、拖曳與畫筆 ────────────────────────────────────────────────────

type DragMode =
	| { kind: 'select'; anchor: number; moved: boolean }
	| { kind: 'value'; startY: number; base: Curves; t: number; moved: boolean }
	| { kind: 'vibrato'; startY: number; startAlpha: number; t: number; moved: boolean }
	| { kind: 'pen'; base: Curves; startT: number; startY: number; lastT: number; lastY: number; minT: number; maxT: number };
let drag: DragMode | null = null;

el.pianoroll.addEventListener('pointerdown', e => {
	if (!source || !curves || busy) return;
	const rect = el.pianoroll.getBoundingClientRect();
	const x = e.clientX - rect.left, y = e.clientY - rect.top;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(x)));

	if (tool === 'pen') {
		drag = { kind: 'pen', base: curves.clone(), startT: t, startY: y, lastT: t, lastY: y, minT: t, maxT: t };
		penTo(t, t, y, y, e.altKey, t);
	} else if (selection && t >= selection.start && t <= selection.end && e.shiftKey) {
		// Shift+上下拖 = 調抖動（跟面板的抖動滑桿同一個參數）
		drag = { kind: 'vibrato', startY: y, startAlpha: params.alpha, t, moved: false };
	} else if (selection && t >= selection.start && t <= selection.end) {
		// 在既有選取區內按下 = 對作用中的 lane 做垂直拖曳
		// 沒有上下拖動就放開 = 定位播放頭
		drag = { kind: 'value', startY: y, base: curves.clone(), t, moved: false };
	} else {
		drag = { kind: 'select', anchor: t, moved: false };
	}
	el.pianoroll.setPointerCapture(e.pointerId);
});

el.pianoroll.addEventListener('pointermove', e => {
	if (!drag || !source || !curves) return;
	const rect = el.pianoroll.getBoundingClientRect();
	const x = e.clientX - rect.left, y = e.clientY - rect.top;
	const h = el.pianoroll.clientHeight;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(x)));

	if (drag.kind === 'select') {
		// 動了才算是在拉選取範圍。沒動的話放開時只是移動播放頭，選取要留著。
		if (Math.abs(t - drag.anchor) >= 0.01) drag.moved = true;
		if (!drag.moved) return;
		selection = { start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) };
		hint(`選取 ${fmtTime(selection.start)} ~ ${fmtTime(selection.end)}（${(selection.end - selection.start).toFixed(2)}s）`);
	} else if (drag.kind === 'pen') {
		if (e.shiftKey) {
			// Shift = 直線：每次都從落筆前的曲線重畫「落筆點 → 游標」這一條，
			// 所以拖曳途中游標怎麼繞都只留下最後那條直線
			curves.lane(pianoroll.active).set(drag.base.lane(pianoroll.active));
			penTo(drag.startT, t, drag.startY, y, e.altKey, drag.startT);
		} else {
			penTo(drag.lastT, t, drag.lastY, y, e.altKey, drag.startT);
		}
		drag.minT = Math.min(drag.minT, t); drag.maxT = Math.max(drag.maxT, t);
		drag.lastT = t; drag.lastY = y;
		const v = pianoroll.yToLaneValue(pianoroll.active, y, h);
		hint(`畫 ${LANES[pianoroll.active].label}：${v.toFixed(2)}${pianoroll.active === 'pitch' ? ` (${midiToName(v)})` : ' ' + LANES[pianoroll.active].unit}`);
	} else if (drag.kind === 'vibrato') {
		if (Math.abs(y - drag.startY) >= 3) drag.moved = true;
		if (!drag.moved) return;
		// 往上 = 起伏放大，往下 = 壓平；100px 一倍
		const alpha = Math.max(0, Math.min(4, Math.round((drag.startAlpha + (drag.startY - y) / 100) * 100) / 100));
		el.flatten.value = String(alpha);
		el.flatten.dispatchEvent(new Event('input'));
		hint(`抖動 ${alpha.toFixed(2)}×（0 = 壓平，1 = 原樣）`);
	} else if (selection) {
		if (Math.abs(y - drag.startY) >= 3) drag.moved = true;
		if (!drag.moved) return;
		// 拖多少像素換算成多少單位，並吸附到 0.01 避免數字抖動
		const id = pianoroll.active;
		const raw = (drag.startY - y) / pianoroll.unitPx(id, h);
		const amount = Math.round(raw * 100) / 100;
		curves.lane(id).set(drag.base.lane(id));
		const s = srcSel()!;
		offsetLane(curves, id, s.start, s.end, amount);
		if (id === 'pitch') limitPitchSlope(s.start - curves.rampSec.pitch, s.end + curves.rampSec.pitch);
		hint(id === 'pitch'
			? `${amount >= 0 ? '+' : ''}${amount.toFixed(2)} 半音${describeTarget(amount)}`
			: `${LANES[id].label} ${amount >= 0 ? '+' : ''}${amount.toFixed(2)} ${LANES[id].unit}`);
	}
});

el.pianoroll.addEventListener('pointerup', async e => {
	if (!drag) return;
	const mode = drag;
	drag = null;
	el.pianoroll.releasePointerCapture(e.pointerId);
	if (!curves || !source) return;

	if (mode.kind === 'select') {
		if (!mode.moved) {
			// 幾乎沒移動 = 單純定位播放頭。**選取要保留**，這樣才能一直調同一段。
			player.seek(mode.anchor);
			return;
		}
		selectionChanged();
		return;
	}

	if (mode.kind === 'pen') {
		// 斜坡長度是原始時間的量，繞回原始時間加上去再換回輸出時間
		const ramp = PEN_RAMP_SEC;
		// 變化率上限在放開時才套用：畫的途中每一小段都套的話，已經畫好的部分會被反覆抹平
		if (pianoroll.active === 'pitch') limitPitchSlope(toSrc(mode.minT) - ramp, toSrc(mode.maxT) + ramp);
		if (sameCurves(mode.base, curves)) return;
		history.push(mode.base);
		const r = editRange(mode.base, toOut(toSrc(mode.minT) - ramp), toOut(toSrc(mode.maxT) + ramp));
		await rerender(r.from, r.to, '畫筆');
		// 畫筆改的是曲線本身，選取的基準要跟著更新
		if (selection) { selBase = curves.clone(); sessionPushed = false; resetParams(); }
		return;
	}

	if (!mode.moved) { player.seek(mode.t); return; }
	if (mode.kind === 'vibrato') { el.flatten.dispatchEvent(new Event('change')); return; }
	// 垂直拖曳結束 → 記錄一步可復原的動作，然後重算那一段
	if (!selection || sameCurves(mode.base, curves)) return;
	history.push(mode.base);
	const r = editRange(mode.base, selection.start, selection.end);
	await rerender(r.from, r.to, LANES[pianoroll.active].label);
	// 拖曳的結果併入基準，滑桿的參考點跟著往前走
	selBase = curves.clone();
	sessionPushed = false;
	resetParams();
});

/**
 * 畫筆：把 (t0,y0) 到 (t1,y1) 之間的格子改寫成線性內插的值。
 *
 * pitch lane 畫的是「絕對音高」，所以要換算成相對於偵測值的偏移；
 * 未發聲的格子沒有偵測音高可以當基準，直接跳過。
 *
 * 抖音幅度不是 0 的話，畫出來的線會再加上 A(t)·sin(2πft)。
 *
 * **相位一律用絕對時間算**，不是從筆畫起點算——一次拖曳會產生幾十段 penTo，
 * 用筆畫相對時間的話每一段都從相位 0 重來，交界處就是一個突兀的跳動。
 *
 * 幅度 A(t) 則相反，要用「離筆畫起點多遠」算：真人的抖音是起音時幾乎沒有、
 * 然後才長出來的，一開始就滿幅度聽起來很機械。用 raised-cosine 漸入，
 * 而且取絕對值距離，所以由右往左畫也一樣是從落筆處長出來。
 */
function penTo(t0: number, t1: number, y0: number, y1: number, snap: boolean, startT: number) {
	if (!curves) return;
	const id = pianoroll.active;
	const h = el.pianoroll.clientHeight;
	const [ta, tb] = t0 <= t1 ? [t0, t1] : [t1, t0];
	const [ya, yb] = t0 <= t1 ? [y0, y1] : [y1, y0];
	const span = Math.max(1e-6, tb - ta);
	const vibDepth = el.vibOn.checked ? Math.max(0, parseFloat(el.vibDepth.value) || 0) : 0;
	const vibRate = Math.max(0.1, parseFloat(el.vibRate.value) || 5.5);
	const onsetSec = el.vibOnsetOn.checked ? Math.max(0, parseFloat(el.vibOnset.value) || 0) / 1000 : 0;
	// t0/t1/startT 都是輸出時間。抖音的速率與漸入照「畫的當下看到的時間」算，
	// 所以用輸出時間；之後再拉動錨點，抖音會跟著原唱一起變快變慢。
	const vib = (t: number) => {
		if (vibDepth === 0) return 0;
		let env = 1;
		if (onsetSec > 0) {
			const x = Math.min(1, Math.abs(t - startT) / onsetSec);
			env = 0.5 - 0.5 * Math.cos(Math.PI * x);
		}
		return vibDepth * env * Math.sin(2 * Math.PI * vibRate * t);
	};

	// 曲線格子在原始時間上：先把筆畫範圍換過去，每一格再換回輸出時間做內插
	const map = curves.timeMap;
	drawLane(curves, id, map.outToSrc(ta), map.outToSrc(tb) + CURVE_HOP_SEC, (tSrc, i) => {
		const t = map.srcToOut(tSrc);
		const f = Math.max(0, Math.min(1, (t - ta) / span));
		let v = pianoroll.yToLaneValue(id, ya + (yb - ya) * f, h);
		if (snap && id === 'pitch') v = Math.round(v);   // 按住 Alt/Option 吸附到整數半音
		// 吸附之後才加抖音，不然抖音會被吸附抹掉
		v += vib(t);
		if (id !== 'pitch') return Math.max(LANES[id].min, Math.min(LANES[id].max, v));
		// 未發聲的格子也要寫：跳過的話 Δ 在發聲交界會是階梯（見 pitchMidiFilled 的說明）
		if (!pitchMidiFilled) return null;
		return v - pitchMidiFilled[i];
	});
}

/** 選取狀態改變時呼叫：更新面板、把參數歸到中性、記下新的編輯基準 */
function selectionChanged() {
	// 底部列的歸零與取消選取只有在有選取時才能按
	const none = !selection || !curves;
	document.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach(b => { b.disabled = none; });
	el.clearSel.disabled = none;
	syncToolbar();
	if (!selection || !curves) {
		el.selInfo.textContent = '尚未選取';
		selBase = null;
		sessionPushed = false;
		return;
	}
	selBase = curves.clone();
	sessionPushed = false;
	resetParams();
	el.selInfo.textContent =
		`${fmtTime(selection.start)} ~ ${fmtTime(selection.end)}（${(selection.end - selection.start).toFixed(2)}s）`;
}

function clearSelection() {
	selection = null;
	player.setLoop(null);
	el.loopBtn.classList.remove('on');
	selectionChanged();
}

el.clearSel.addEventListener('click', () => { clearSelection(); hint(''); });

// ── 面板參數（活的，隨時可以來回調） ────────────────────────────────────

function resetParams() {
	params.shift = 0; params.alpha = 1; params.gainDb = 0; params.formant = 0;
	el.shift.value = '0';
	el.flatten.value = '1';
	el.gain.value = '0';
	el.formant.value = '0';
	syncParamLabels();
}

function syncParamLabels() {
	el.shiftOut.textContent = `${params.shift >= 0 ? '+' : ''}${params.shift.toFixed(2)} 半音`;
	el.flattenOut.textContent = `${params.alpha.toFixed(2)}×`;
	el.gainOut.textContent = `${params.gainDb >= 0 ? '+' : ''}${params.gainDb.toFixed(1)} dB`;
	el.formantOut.textContent = `${params.formant >= 0 ? '+' : ''}${params.formant.toFixed(2)} 半音`;
}

/**
 * 依照目前的參數，從 selBase 重新套用一次。
 *
 * 一定要從 selBase 重算而不是在 curves 上疊加，否則滑桿拉回中性值時
 * 回不到原樣（舊版的問題）。全部參數都中性時，結果逐位元等於 selBase。
 */
function applyParams() {
	if (!curves || !selBase || !selection) return;
	curves.pitch.set(selBase.pitch);
	curves.gainDb.set(selBase.gainDb);
	curves.formant.set(selBase.formant);

	const s = srcSel()!;
	if (params.shift !== 0) offsetLane(curves, 'pitch', s.start, s.end, params.shift);
	if (params.alpha !== 1 && pitchMidi && curveVoiced) {
		flattenRange(curves, pitchMidi, curveVoiced, s.start, s.end, params.alpha);
	}
	if (params.gainDb !== 0) offsetLane(curves, 'gain', s.start, s.end, params.gainDb);
	if (params.formant !== 0) offsetLane(curves, 'formant', s.start, s.end, params.formant);
	if (params.shift !== 0 || params.alpha !== 1) limitPitchSlope(s.start - curves.rampSec.pitch, s.end + curves.rampSec.pitch);
}

/**
 * 對原始時間 [fromSec, toSec) 附近的音高偏移套用變化率上限（curves.pitchSlopeLimit）。
 * 範圍會自動往外擴到「最大的 |Δ| 拉得回來」的距離，被拉緩的部分不會截在範圍外。
 */
function limitPitchSlope(fromSec: number, toSec: number) {
	if (!curves || !(curves.pitchSlopeLimit > 0)) return;
	const L = curves.pitchSlopeLimit;
	const i0 = Curves.timeToFrame(fromSec), i1 = Curves.timeToFrame(toSec);
	const m = slopeMarginFrames(curves.pitch, i0, i1, L);
	limitSlope(curves.pitch, i0 - m, i1 + m, L);
}

/**
 * 這次編輯要重算的輸出範圍：選取（或筆畫）範圍，再加上曲線實際被改到的地方。
 * 變化率上限會把編輯往外推（+12 半音 / 60 = 往外 200ms），只算選取範圍的話接縫會落在 Δ≠0 處。
 */
function editRange(base: Curves, fromOut: number, toOut_: number): { from: number; to: number } {
	const d = curves ? diffRange(base, curves) : null;
	if (!d) return { from: fromOut, to: toOut_ };
	return { from: Math.min(fromOut, toOut(d.from)), to: Math.max(toOut_, toOut(d.to)) };
}

const sliders: { input: HTMLInputElement; key: keyof typeof params; label: string }[] = [
	{ input: el.shift, key: 'shift', label: '音高' },
	{ input: el.flatten, key: 'alpha', label: '抖動' },
	{ input: el.gain, key: 'gainDb', label: '音量' },
	{ input: el.formant, key: 'formant', label: 'Formant' },
];

for (const s of sliders) {
	// 拖曳過程只更新曲線和畫面，不算繪——不然會卡成一團
	s.input.addEventListener('input', () => {
		params[s.key] = parseFloat(s.input.value);
		syncParamLabels();
		applyParams();
	});
	// 放開才真的算繪
	s.input.addEventListener('change', async () => {
		if (!curves || !selBase || !selection) return;
		applyParams();
		if (!sessionPushed) {
			if (sameCurves(selBase, curves)) return;   // 拉了又拉回中性，不必留一步 undo
			history.push(selBase);
			sessionPushed = true;
		}
		const r = editRange(selBase, selection.start, selection.end);
		await rerender(r.from, r.to, s.label);
	});
}

/**
 * 人聲／樂器模式：移調時音色要不要跟著跑。
 *
 * 這是**全域**設定，不是曲線——改了整個檔案所有移調過的地方聽感都會變，
 * 所以放在 header 而不是選取面板，也做成兩顆按鈕而不是滑桿，免得被滑鼠掃到。
 * 中間的程度用 Formant 那條 lane 分段調就好，不必再開一個連續旋鈕。
 */
async function setMode(follow: 0 | 1) {
	if (busy) return;
	const changed = renderer.formantFollow !== follow;
	renderer.formantFollow = follow;
	el.modeVoice.classList.toggle('on', follow === 0);
	el.modeInstrument.classList.toggle('on', follow === 1);
	if (!changed || !curves) return;
	// 只有已經移調過的地方會受影響，沒移調的地方 r·Δ = 0
	const r = editedPitchRange();
	if (!r) { hint(follow ? '樂器模式（目前還沒有移調的段落）' : '人聲模式'); return; }
	await rerender(r.from, r.to, follow ? '樂器模式' : '人聲模式');
}
el.modeVoice.addEventListener('click', () => setMode(0));
el.modeInstrument.addEventListener('click', () => setMode(1));

el.panel.querySelectorAll('[data-nudge]').forEach(btn => {
	btn.addEventListener('click', () => {
		const amount = parseFloat((btn as HTMLElement).dataset.nudge!);
		el.shift.value = String(Math.max(-12, Math.min(12, params.shift + amount)));
		el.shift.dispatchEvent(new Event('input'));
		el.shift.dispatchEvent(new Event('change'));
	});
});

// 把選取範圍的編輯清掉，回到原始聲音
document.querySelectorAll('[data-reset]').forEach(btn => {
	btn.addEventListener('click', async () => {
		if (!curves || !selection || busy) return;
		const which = (btn as HTMLElement).dataset.reset!;
		const before = curves.clone();
		// 只歸零曲線數值；錨點與伸縮不動。範圍換到原始時間，因為曲線存在那裡
		const s = srcSel()!;
		if (which === 'all') resetAll(curves, s.start, s.end);
		else resetLane(curves, which as LaneId, s.start, s.end);
		if (which === 'all' || which === 'pitch') limitPitchSlope(s.start - 2 * curves.rampSec.pitch, s.end + 2 * curves.rampSec.pitch);
		if (sameCurves(before, curves)) { hint('這段本來就沒有這類編輯'); return; }
		history.push(before);
		const r = editRange(before, selection.start, selection.end);
		await rerender(r.from, r.to, '歸零');
		selBase = curves.clone();
		sessionPushed = false;
		resetParams();
	});
});

// ── Ramp 長度 ───────────────────────────────────────────────────────────

// 邊界過渡只有一個數字，三條 lane 共用。只影響選取工具的編輯（上下拖、滑桿、歸零），
// 畫筆固定用 PEN_RAMP_SEC。曲線裡仍然每條 lane 各存一份，舊專案檔讀得進來。
function syncRampInputs() {
	if (!curves) return;
	el.ramp.value = String(Math.round(curves.rampSec.pitch * 1000));
	el.slope.value = String(curves.pitchSlopeLimit);
}

// 音高變化上限：只影響之後的編輯（跟邊界過渡一樣），不回頭改已經做好的曲線
el.slope.addEventListener('change', () => {
	if (!curves) return;
	const v = Math.max(0, Math.min(1000, parseFloat(el.slope.value)));
	const limit = isFinite(v) ? v : DEFAULT_PITCH_SLOPE_LIMIT;
	el.slope.value = String(limit);
	curves.pitchSlopeLimit = limit;
	if (selBase) selBase.pitchSlopeLimit = limit;
	hint(limit > 0 ? `音高變化上限：每秒 ${limit} 半音` : '音高變化上限：不限制');
});

el.ramp.addEventListener('change', () => {
	if (!curves) return;
	const ms = Math.max(5, Math.min(500, parseFloat(el.ramp.value) || 100));
	el.ramp.value = String(ms);
	for (const id of LANE_IDS) {
		curves.rampSec[id] = ms / 1000;
		if (selBase) selBase.rampSec[id] = ms / 1000;
	}
	hint(`邊界過渡：${ms}ms`);
});

// ── 匯出與存檔 ──────────────────────────────────────────────────────────

el.exportBtn.addEventListener('click', async () => {
	if (!source) return;
	// 背景精算還沒完成的話，匯出的會是有接縫的預覽版——等它算完
	if (bgTimer || bgPendingRange || renderer.backgroundProgress !== null) {
		hint('背景精算中，算完會自動匯出…');
		await waitBackground();
	}
	const name = source.name.replace(/\.[^.]+$/, '') + '_wipitch.wav';
	downloadBlob(encodeWav24(renderer.rendered, renderer.sampleRate), name);
	hint(`已匯出 ${name}`);
});

el.saveBtn.addEventListener('click', () => {
	if (!source || !curves) return;
	const name = source.name.replace(/\.[^.]+$/, '') + '.wipitch.json';
	const text = serialize(curves, source.name, source.sampleRate, source.duration, renderer.formantFollow,
		ref.name ? { name: ref.name, gainDb: ref.gainDb, muted: ref.muted, offsetSec: ref.offsetSec } : undefined);
	downloadBlob(new Blob([text], { type: 'application/json' }), name);
	hint(`已存檔 ${name}`);
});

el.openProject.addEventListener('change', async () => {
	const f = el.openProject.files?.[0];
	if (!f || !source || !track) return;
	try {
		const loaded = deserialize(await f.text(), source.sampleRate, track.length);
		history.push(curves!);
		curves = loaded.curves;
		// 模式是全域設定，也要跟著專案檔回來——不然讀檔後聲音會跟存檔前不一樣
		renderer.formantFollow = loaded.formantFollow;
		el.modeVoice.classList.toggle('on', loaded.formantFollow === 0);
		el.modeInstrument.classList.toggle('on', loaded.formantFollow === 1);
		syncRampInputs();
		clearSelection();
		selectedAnchors.clear();
		// 曲線整個換掉了，只好整段重算
		busy = true;
		hint('讀檔：整段重新算繪中…（可能要十幾秒）');
		view.duration = outDuration();
		showProgress({ start: 0, end: outDuration() });
		const t0 = performance.now();
		await renderer.renderAll(curves);
		player.setAudio(renderer.rendered, renderer.sampleRate);
		let refNote = '';
		const bgSaved = loaded.background;
		if (bgSaved && bgSaved.name === ref.name) {
			// 同一個背景已經載入了，直接套用設定
			ref.gainDb = bgSaved.gainDb; ref.muted = bgSaved.muted; ref.offsetSec = bgSaved.offsetSec;
			applyRefToPlayer();
		} else if (bgSaved) {
			pendingRefSettings = bgSaved;
			refNote = `；專案有參考音軌 ${bgSaved.name}，請在下方參考音軌按「載入參考音軌」（設定會自動套用）`;
		}
		hint(`讀檔完成（算繪 ${((performance.now() - t0) / 1000).toFixed(1)}s）${refNote}`);
	} catch (e) {
		hint(`讀檔失敗：${(e as Error).message}`);
	} finally {
		busy = false;
		showProgress(null);
		el.openProject.value = '';
	}
});

/** 拖曳時顯示「現在大概落在哪個音」，方便對照 */
function describeTarget(amount: number): string {
	if (!track || !selection) return '';
	let sum = 0, n = 0;
	const s = srcSel()!;
	const i0 = Math.round(s.start / 0.016), i1 = Math.round(s.end / 0.016);
	for (let i = i0; i < i1 && i < track.length; i++) {
		if (track.voiced[i]) { sum += hzToMidi(track.f0[i]); n++; }
	}
	if (!n) return '';
	const midi = sum / n + amount;
	const cents = Math.round((midi - Math.round(midi)) * 100);
	return `　→ 平均落在 ${midiToName(midi)} ${cents >= 0 ? '+' : ''}${cents} cents`;
}

async function rerender(fromSec: number, toSec: number, label: string) {
	if (!curves) return;
	busy = true;
	hint(`${label}：算繪中…`);
	showProgress({ start: Math.max(0, fromSec), end: toSec });
	const t0 = performance.now();
	try {
		await renderer.patch(curves, Math.max(0, fromSec), toSec);
		player.setAudio(renderer.rendered, renderer.sampleRate);
		hint(`${label}：完成（${(performance.now() - t0).toFixed(0)}ms）`);
		scheduleBackground({ from: Math.max(0, fromSec), to: toSec });
	} catch (e) {
		hint(`${label}：算繪失敗 ${(e as Error).message}`);
	} finally {
		busy = false;
		showProgress(null);
	}
}

// ── 背景精算 ────────────────────────────────────────────────────────────
//
// 有伸縮的段落，快速的局部重算在接縫處可能有幾毫秒的偏差（見 renderer.ts）。
// 每次重算完就排一個背景工作，把改動前後兩個無聲處之間一口氣算完，算完自動換上。

let bgTimer = 0;
/** 還沒處理的改動範圍（輸出秒）。連續編輯時合併起來，一次算完 */
let bgPendingRange: { from: number; to: number } | null = null;
let bgApplied = 0;   // 測試用：背景精算換上過幾次

function scheduleBackground(changed: { from: number; to: number }) {
	bgPendingRange = bgPendingRange
		? { from: Math.min(bgPendingRange.from, changed.from), to: Math.max(bgPendingRange.to, changed.to) }
		: changed;
	clearTimeout(bgTimer);
	// 連續編輯時不要每一步都開一個工作：停手 400ms 才開始
	bgTimer = window.setTimeout(runBackground, 400);
	// 要在計時器設好之後才同步指示燈，不然它會以為沒有在等
	syncBackgroundStatus();
}

async function runBackground() {
	bgTimer = 0;
	if (!curves || !bgPendingRange) return;
	if (busy) { bgTimer = window.setTimeout(runBackground, 200); return; }
	const range = bgPendingRange;
	bgPendingRange = null;
	// 沒換上的話，要嘛是不需要精算，要嘛是被新的編輯取消了——那個編輯自己會再排一次
	if (await renderer.renderBackground(curves, range)) {
		player.setAudio(renderer.rendered, renderer.sampleRate);
		bgApplied++;
	}
	syncBackgroundStatus();
}

renderer.onBackground = syncBackgroundStatus;
function syncBackgroundStatus() {
	const p = renderer.backgroundProgress;
	const waiting = !!bgTimer && !!bgPendingRange;
	el.bgStatus.hidden = p === null && !waiting;
	el.bgText.textContent = p === null ? '背景精算（等待中）' : `背景精算 ${Math.round(p * 100)}%`;
}

/** 等背景精算全部結束（匯出前、測試用） */
async function waitBackground() {
	while (bgTimer || bgPendingRange || renderer.backgroundProgress !== null || busy) {
		await new Promise(r => setTimeout(r, 100));
	}
}

// ── 時間軸操作 ──────────────────────────────────────────────────────────

/**
 * 滾輪（照一般編輯器的慣例：Shift 代表「換成橫向」）：
 *   單獨          縱向捲動
 *   Ctrl/Cmd      縱向縮放
 *   Shift         橫向捲動
 *   Ctrl+Shift    橫向縮放
 *
 * 縱向的兩個是對「目前正在編輯的那條 lane」作用。波形軌沒有縱軸可言，
 * 所以在那裡一律當成橫向操作——不然在波形上滾滾輪會完全沒反應，那更怪。
 */
for (const canvas of [el.waveform, el.refwave, el.pianoroll]) {
	canvas.addEventListener('wheel', e => {
		if (!source) return;
		e.preventDefault();
		const rect = canvas.getBoundingClientRect();
		const x = e.clientX - rect.left, y = e.clientY - rect.top;
		const w = canvas.clientWidth;
		// 有些滑鼠與觸控板把 Shift+滾輪直接送成 deltaX，兩個都要看
		const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
		const ctrl = e.ctrlKey || e.metaKey;
		// 波形軌上 Alt+滾輪 = 放大波形（只影響顯示）
		if (canvas === el.waveform && e.altKey) {
			setAmpZoom(waveform.ampZoom * Math.exp(-d * 0.002));
			return;
		}
		if (canvas === el.refwave && e.altKey) {
			setRefAmpZoom(refWave.ampZoom * Math.exp(-d * 0.002));
			return;
		}
		// 觸控板的橫向滑動本來就是 deltaX，不必按 Shift 也該當成橫向
		const horizontal = e.shiftKey || canvas !== el.pianoroll || (e.deltaX !== 0 && e.deltaY === 0);

		if (horizontal) {
			if (ctrl) view.zoomAt(x, Math.exp(d * 0.003), w);
			else view.scrollBy(d, w);
			return;
		}
		const h = el.pianoroll.clientHeight;
		if (ctrl) pianoroll.zoomV(Math.exp(d * 0.003), y, h);
		else pianoroll.scrollV(d * 0.5, h);
	}, { passive: false });
}

/*
 * 範圍捲軸：滾輪組合鍵不好記，也不是每個人都有滾輪。
 * 橫向那條管所有軌道共用的時間軸，底下畫整個檔案的總覽；縱向那條管目前編輯的 lane。
 */
const hbar = new RangeBar(el.hbar, 'h', {
	extent: () => ({ lo: 0, hi: view.extent }),
	visible: () => ({ lo: view.startSec, hi: view.startSec + el.pianoroll.clientWidth * view.secPerPx }),
	setVisible: (lo, hi, keep) => { if (source) view.setRange(lo, hi, el.pianoroll.clientWidth, keep); },
	fit: () => { if (source) view.fit(el.pianoroll.clientWidth); },
}, (ctx, w, h, ext) => drawOverview(waveform, ctx, w, h, ext.lo, ext.hi, curves, player.position, selection));

const vbar = new RangeBar(el.vbar, 'v', {
	extent: () => pianoroll.vExtent(),
	visible: () => pianoroll.rangeOf(pianoroll.active),
	setVisible: (lo, hi, keep) => pianoroll.setRangeV(lo, hi, keep),
	fit: () => pianoroll.fitV(),
});

// ── 波形放大與波形軌高度 ────────────────────────────────────────────────

/** 放大倍率與滑桿位置的換算：對數刻度 0.25× ~ 100×（100× ≈ +40dB） */
const AMP_MIN = 0.25, AMP_MAX = 100;
const ampToFraction = (z: number) => Math.log(z / AMP_MIN) / Math.log(AMP_MAX / AMP_MIN);
const fractionToAmp = (f: number) => AMP_MIN * Math.pow(AMP_MAX / AMP_MIN, f);

function setAmpZoom(z: number) {
	waveform.ampZoom = Math.max(AMP_MIN, Math.min(AMP_MAX, z));
	el.ampZoom.value = String(ampToFraction(waveform.ampZoom));
	hint(`波形放大 ${waveform.ampZoom.toFixed(2)}×（只影響顯示）`);
}
el.ampZoom.value = String(ampToFraction(1));
el.ampZoom.addEventListener('input', () => setAmpZoom(fractionToAmp(parseFloat(el.ampZoom.value))));
el.ampZoom.addEventListener('dblclick', () => setAmpZoom(1));

const TRACK_MIN_PX = 40;

/**
 * 分隔線拖曳改軌道高度（主波形、參考音軌各一條）。
 * 唯一的限制是每個軌道都還看得到一點。高度記在 localStorage。
 */
function makeSplitter(splitter: HTMLElement, canvas: HTMLCanvasElement, other: HTMLCanvasElement,
	cssVar: string, key: string, def: number) {
	const set = (px: number) => {
		const main = el.stage;
		const max = Math.max(TRACK_MIN_PX, main.clientHeight - el.waveSplitter.clientHeight - el.refSplitter.clientHeight - el.hbar.parentElement!.clientHeight
			- other.clientHeight - TRACK_MIN_PX);
		const h = Math.round(Math.max(TRACK_MIN_PX, Math.min(max, px)));
		main.style.setProperty(cssVar, `${h}px`);
		try { localStorage.setItem(key, String(h)); } catch { /* 私密模式等 */ }
	};
	try {
		const saved = parseFloat(localStorage.getItem(key) || '');
		if (saved > 0) el.stage.style.setProperty(cssVar, `${saved}px`);
	} catch { /* 讀不到就用預設 */ }

	let drag: { startY: number; startH: number } | null = null;
	splitter.addEventListener('pointerdown', e => {
		drag = { startY: e.clientY, startH: canvas.clientHeight };
		splitter.setPointerCapture(e.pointerId);
	});
	splitter.addEventListener('pointermove', e => {
		if (!drag) return;
		// 往上拖 = 下面的軌道變高
		set(drag.startH - (e.clientY - drag.startY));
	});
	splitter.addEventListener('pointerup', e => {
		drag = null;
		splitter.releasePointerCapture(e.pointerId);
	});
	splitter.addEventListener('dblclick', () => set(def));
}
makeSplitter(el.waveSplitter, el.waveform, el.refwave, '--wave-h', 'wipitch.waveHeight', 150);
makeSplitter(el.refSplitter, el.refwave, el.waveform, '--ref-h', 'wipitch.refHeight', 60);

function setRefAmpZoom(z: number) {
	refWave.ampZoom = Math.max(AMP_MIN, Math.min(AMP_MAX, z));
	el.refAmpZoom.value = String(ampToFraction(refWave.ampZoom));
	hint(`參考音軌波形放大 ${refWave.ampZoom.toFixed(2)}×（只影響顯示）`);
}
el.refAmpZoom.value = String(ampToFraction(1));
el.refAmpZoom.addEventListener('input', () => setRefAmpZoom(fractionToAmp(parseFloat(el.refAmpZoom.value))));
el.refAmpZoom.addEventListener('dblclick', () => setRefAmpZoom(1));

// 參考音軌上也能拉選取、點一下定位播放頭（沒有錨點）
el.refwave.addEventListener('pointerdown', e => {
	if (!source) return;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(e.clientX - el.refwave.getBoundingClientRect().left)));
	if (!e.shiftKey) selectedAnchors.clear();
	// 畫筆模式不建立選取，點一下只定位播放頭
	if (tool === 'pen') { player.seek(t); return; }
	waveSelect = { anchor: t, moved: false };
	el.refwave.setPointerCapture(e.pointerId);
});
el.refwave.addEventListener('pointermove', e => waveSelectMove(el.refwave, e.clientX));
el.refwave.addEventListener('pointerup', e => waveSelectEnd(el.refwave, e.pointerId));

// ── 背景參考音軌 ────────────────────────────────────────────────────────
//
// 修主唱時一邊聽伴奏才知道對不對得準。只用來監聽：不跟著錨點伸縮、不會匯出。
// 存檔只記設定，讀檔後請使用者重新載入同名檔。

const ref = { name: null as string | null, gainDb: 0, muted: false, offsetSec: 0 };
/** 讀檔時帶進來、但背景音檔還沒載入的設定。之後載入同名檔時套用 */
let pendingRefSettings: BackgroundSettings | null = null;

function applyRefToPlayer() {
	player.setBackgroundGain(ref.muted ? 0 : Math.pow(10, ref.gainDb / 20));
	player.setBackgroundOffset(ref.offsetSec);
	refWave.offset = ref.offsetSec;
	refWave.muted = ref.muted;
	syncRefUi();
}

function syncRefUi() {
	el.refName.textContent = ref.name ?? '無';
	el.refControls.hidden = !ref.name;
	el.refName.hidden = !ref.name;
	el.refFileText.textContent = ref.name ? '更換' : '載入參考音軌';
	el.refMute.classList.toggle('on', ref.muted);
	el.refVol.value = String(ref.gainDb);
	el.refVolOut.textContent = `${ref.gainDb > 0 ? '+' : ''}${ref.gainDb.toFixed(1)} dB`;
	if (document.activeElement !== el.refOffset) el.refOffset.value = String(Math.round(ref.offsetSec * 1000));
}

async function loadReference(file: File) {
	hint(`載入參考音軌 ${file.name}…`);
	let audio;
	try {
		audio = await decodeAudio(file);
	} catch (e) {
		hint(`解不開參考音檔：${(e as Error).message}`);
		return;
	}
	player.setBackground(audio.channels, audio.sampleRate);
	refWave.setAudio(audio.channels, audio.sampleRate);
	ref.name = audio.name;
	if (pendingRefSettings && pendingRefSettings.name === audio.name) {
		ref.gainDb = pendingRefSettings.gainDb;
		ref.muted = pendingRefSettings.muted;
		ref.offsetSec = pendingRefSettings.offsetSec;
		pendingRefSettings = null;
	}
	applyRefToPlayer();
	const mainDur = outDuration();
	hint(source && Math.abs(audio.duration - mainDur) > 0.5
		? `參考音軌 ${fmtTime(audio.duration)} / 主唱 ${fmtTime(mainDur)}，長度不同，可能要調 offset`
		: `已載入參考音軌 ${audio.name}`);
}

function removeReference() {
	player.setBackground(null);
	refWave.setAudio(null);
	ref.name = null;
	syncRefUi();
	hint('已移除參考音軌');
}

function toggleRefMute() {
	if (!ref.name) return;
	ref.muted = !ref.muted;
	applyRefToPlayer();
	hint(ref.muted ? '參考音軌靜音' : '參考音軌取消靜音');
}

el.refFile.addEventListener('change', () => {
	const f = el.refFile.files?.[0];
	if (f) loadReference(f);
	el.refFile.value = '';
});
el.refRemove.addEventListener('click', removeReference);
el.refMute.addEventListener('click', toggleRefMute);
el.refVol.addEventListener('input', () => { ref.gainDb = parseFloat(el.refVol.value); applyRefToPlayer(); });
el.refVol.addEventListener('dblclick', () => { ref.gainDb = 0; applyRefToPlayer(); });
el.refOffset.addEventListener('change', () => {
	ref.offsetSec = (parseFloat(el.refOffset.value) || 0) / 1000;
	applyRefToPlayer();
	hint(`參考音軌 offset ${Math.round(ref.offsetSec * 1000)}ms`);
});
document.querySelectorAll<HTMLButtonElement>('[data-bg-nudge]').forEach(btn => {
	btn.addEventListener('click', () => {
		ref.offsetSec = Math.round((ref.offsetSec * 1000 + parseFloat(btn.dataset.bgNudge!))) / 1000;
		applyRefToPlayer();
		hint(`參考音軌 offset ${Math.round(ref.offsetSec * 1000)}ms`);
	});
});
syncRefUi();

// ── 工具 ────────────────────────────────────────────────────────────────

function sameArray(a: Float32Array, b: Float32Array) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function sameCurves(a: Curves, b: Curves) {
	return sameArray(a.pitch, b.pitch) && sameArray(a.gainDb, b.gainDb) && sameArray(a.formant, b.formant)
		&& a.timeMap.equals(b.timeMap);
}

/** 找出兩份曲線不同的範圍（秒），用來決定復原之後要重算哪裡 */
function diffRange(a: Curves, b: Curves): { from: number; to: number } | null {
	let lo = -1, hi = -1;
	for (let i = 0; i < a.length; i++) {
		if (a.pitch[i] !== b.pitch[i] || a.gainDb[i] !== b.gainDb[i] || a.formant[i] !== b.formant[i]) {
			if (lo < 0) lo = i;
			hi = i;
		}
	}
	return lo < 0 ? null : { from: Curves.frameToTime(lo), to: Curves.frameToTime(hi + 1) };
}

/** 有 pitch 編輯的整個範圍（秒）。改 formant 跟隨比例時要重算這一段。 */
function editedPitchRange(): { from: number; to: number } | null {
	if (!curves) return null;
	let lo = -1, hi = -1;
	for (let i = 0; i < curves.length; i++) {
		if (curves.pitch[i] !== 0) { if (lo < 0) lo = i; hi = i; }
	}
	return lo < 0 ? null : { from: toOut(Curves.frameToTime(lo)), to: toOut(Curves.frameToTime(hi + 1)) };
}

// 測試用：直接把播放頭放到指定秒數（正常操作是點波形軌）
(window as any).__seekForTest = (sec: number) => player.seek(sec);

// 開發／測試用的內部狀態查詢窗口
/** 測試用：畫面 x 位置上某條 lane 的值；pitch 另外回傳絕對音高（未發聲為 null） */
(window as any).__laneAtX = (id: LaneId, x: number) => {
	if (!curves) return null;
	const t = toSrc(view.xToTime(x));
	const i = Curves.timeToFrame(t);
	const v = curves.valueAt(id, t);
	const abs = id === 'pitch' && pitchMidi && curveVoiced && curveVoiced[i] ? pitchMidi[i] + curves.pitch[i] : null;
	return { v, abs };
};

function pitchStepIn(fromOut: number, toOut_: number) {
	if (!curves || !curveVoiced) return null;
	const i0 = Math.max(1, Curves.timeToFrame(toSrc(fromOut))), i1 = Math.min(curves.length, Curves.timeToFrame(toSrc(toOut_)));
	let max = 0, unvoiced = 0;
	for (let i = i0; i < i1; i++) {
		max = Math.max(max, Math.abs(curves.pitch[i] - curves.pitch[i - 1]));
		if (!curveVoiced[i]) unvoiced++;
	}
	return { max: +max.toFixed(4), unvoiced };
}

(window as any).__debug = () => {
	if (!curves || !source) return null;
	let maxDelta = 0, edited = 0;
	for (let i = 0; i < curves.length; i++) {
		const d = Math.abs(curves.pitch[i]);
		if (d > 1e-9) edited++;
		if (d > maxDelta) maxDelta = d;
	}
	// 算繪結果跟原始音訊差多少，用來確認聲音真的被改過
	let diff = 0, refEnergy = 0;
	const a = source.channels[0], b = renderer.rendered[0];
	for (let i = 0; i < a.length; i += 97) { const d = a[i] - b[i]; diff += d * d; refEnergy += a[i] * a[i]; }
	return {
		maxDelta: +maxDelta.toFixed(3),
		editedFrames: edited,
		editedSeconds: +(edited * CURVE_HOP_SEC).toFixed(2),
		renderDiffRatio: +(Math.sqrt(diff / (refEnergy + 1e-20))).toFixed(4),
		historyDepth: history.depth,
		redoDepth: history.redoDepth,
		/** 選取範圍內「音高圍繞平滑中心線的起伏」標準差（半音）。壓平之後應該要變小。 */
		wobble: selection ? wobbleIn(selection.start, selection.end) : null,
		/** 選取範圍內音高的整體標準差（半音）。α=0 壓成單一音高之後應該接近 0。 */
		spread: selection ? spreadIn(selection.start, selection.end) : null,
		/** 只看選取範圍內的編輯量（maxDelta 是整個檔案的，測局部功能時會被別處的編輯干擾） */
		selMaxDelta: selection ? maxDeltaIn(selection.start, selection.end) : null,
		selMaxGainDb: selection ? maxAbsIn('gain', selection.start, selection.end) : null,
		selMaxFormant: selection ? maxAbsIn('formant', selection.start, selection.end) : null,
		/** 選取範圍內相鄰曲線格音高偏移的最大差（半音）與其中未發聲的格數 */
		selPitchStep: selection ? pitchStepIn(selection.start, selection.end) : null,
		pitchSlopeLimit: curves.pitchSlopeLimit,
		activeLane: pianoroll.active,
		formantFollow: renderer.formantFollow,
		progressTicks,
		vibOn: el.vibOn.checked,
		vibDepth: parseFloat(el.vibDepth.value),
		vibOnsetOn: el.vibOnsetOn.checked,
		vibOnsetMs: parseFloat(el.vibOnset.value),
		/** 目前這條 lane 的縱軸可視範圍，測試縱向縮放／捲動用 */
		vRange: pianoroll.rangeOf(pianoroll.active),
		hSpanSec: +(el.pianoroll.clientWidth * view.secPerPx).toFixed(3),
		startSec: +view.startSec.toFixed(3),
		following: followPlayhead,
		/** 播放頭位置（秒）。時鐘是下一個動畫幀才更新，測試要看這個才不會讀到舊值 */
		playhead: +player.position.toFixed(3),
		looping: !!player.loopRegion,
		selection,
		anchors: curves.timeMap.anchors.map(a => ({ id: a.id, src: +a.src.toFixed(4), out: +a.out.toFixed(4) })),
		selectedAnchors: [...selectedAnchors],
		outDuration: +outDuration().toFixed(4),
		renderedSec: +(renderer.rendered[0].length / renderer.sampleRate).toFixed(4),
		bgProgress: renderer.backgroundProgress,
		bgWaiting: !!bgTimer || !!bgPendingRange,
		bgVisible: !el.bgStatus.hidden,
		bgApplied,
		/** 背景參考音軌 */
		reference: {
			name: ref.name, duration: +player.backgroundDuration.toFixed(3),
			gainDb: ref.gainDb, muted: ref.muted, offsetSec: ref.offsetSec,
			playerGain: +player.backgroundGain.toFixed(4), nodeActive: player.backgroundNodeActive,
		},
		playing: player.isPlaying,
		ampZoom: +waveform.ampZoom.toFixed(3),
		refAmpZoom: +refWave.ampZoom.toFixed(3),
		waveHeight: el.waveform.clientHeight,
		refHeight: el.refwave.clientHeight,
		pianoHeight: el.pianoroll.clientHeight,
		/** 最近一次背景串流的範圍與兩端接縫的音量（dB，相對整檔最大音量） */
		bgStream: renderer.lastStream && {
			from: +renderer.lastStream.from.toFixed(3),
			to: +renderer.lastStream.to.toFixed(3),
			fromDb: +renderer.levelDbAt(renderer.lastStream.from).toFixed(1),
			toDb: +renderer.levelDbAt(renderer.lastStream.to).toFixed(1),
		},
	};
};

/** 測試用：等背景精算全部結束 */
(window as any).__waitBackground = waitBackground;

/**
 * 測試用：記下目前算繪結果的某一段（輸出時間），之後拿來比對。
 * 「歸零之後要回到同樣的聲音」這種驗收需要它。
 */
const renderSnaps = new Map<string, Float32Array>();
(window as any).__snapRendered = (name: string, fromSec: number, toSec: number) => {
	const sr = renderer.sampleRate;
	const snap = renderer.rendered[0].slice(Math.round(fromSec * sr), Math.round(toSec * sr));
	renderSnaps.set(name, snap);
	return snap.length;
};
/**
 * 測試用：目前算繪結果（從 fromSec 起）與快照比較。
 *
 * corr / relErr 是逐 sample 的——只適合「應該完全相同」的情況（搬移、還原原始音訊）。
 * 有伸縮的段落從不同位置開始算，相位聲碼器的相位本來就不同，聽起來一樣但波形對不起來，
 * 那種情況要看 specCorr：每 20ms 一窗的幅度頻譜（log）相關係數的平均。
 */
(window as any).__compareSnap = (name: string, fromSec: number) => {
	const snap = renderSnaps.get(name);
	if (!snap) return null;
	const sr = renderer.sampleRate, b = renderer.rendered[0], o = Math.round(fromSec * sr);
	let dot = 0, a2 = 0, b2 = 0, d2 = 0;
	for (let i = 0; i < snap.length; i++) {
		const x = snap[i], y = b[o + i] ?? 0;
		dot += x * y; a2 += x * x; b2 += y * y; d2 += (x - y) ** 2;
	}
	// 伸縮段重算之後可能有幾毫秒的時間偏移；分開報「對齊時」與「±10ms 內最佳」才看得出是哪一種差異
	let best = { off: 0, c: -2 };
	for (let offMs = -10; offMs <= 10; offMs += 2) {
		const s = o + Math.round(offMs / 1000 * sr);
		const c = spectralCorr(snap, b.subarray(Math.max(0, s), Math.max(0, s) + snap.length), sr);
		if (c > best.c) best = { off: offMs, c };
	}
	return {
		corr: +(dot / Math.sqrt(a2 * b2 + 1e-20)).toFixed(5),
		relErr: +Math.sqrt(d2 / (a2 + 1e-20)).toFixed(5),
		specCorr: +spectralCorr(snap, b.subarray(o, o + snap.length), sr).toFixed(4),
		bestSpecCorr: +best.c.toFixed(4),
		bestOffsetMs: best.off,
	};
};

/** 測試用：什麼都不改，單純重算一段（量「重算本身」造成的差異當基準） */
(window as any).__rerenderForTest = (fromSec: number, toSec: number) => rerender(fromSec, toSec, '測試重算');

/** 兩段音訊的 log 幅度頻譜相關（每 20ms 一窗、1024 點 Hann、只取有聲音的窗） */
function spectralCorr(x: Float32Array, y: Float32Array, sr: number): number {
	const N = 1024, hop = Math.round(sr * 0.02), bins = 200;   // 只看 0 ~ 約 9kHz
	const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
	const mag = (s: Float32Array, off: number) => {
		const m = new Float32Array(bins);
		for (let k = 1; k <= bins; k++) {
			let re = 0, im = 0;
			const w = 2 * Math.PI * k / N;
			for (let i = 0; i < N; i++) { const v = (s[off + i] ?? 0) * win[i]; re += v * Math.cos(w * i); im -= v * Math.sin(w * i); }
			m[k - 1] = Math.log(Math.hypot(re, im) + 1e-6);
		}
		return m;
	};
	let sum = 0, count = 0;
	for (let off = 0; off + N <= Math.min(x.length, y.length); off += hop) {
		let e = 0;
		for (let i = 0; i < N; i++) e += x[off + i] ** 2;
		if (Math.sqrt(e / N) < 0.005) continue;   // 靜音的窗沒有意義
		const p = mag(x, off), q = mag(y, off);
		const mp = p.reduce((s, v) => s + v, 0) / bins, mq = q.reduce((s, v) => s + v, 0) / bins;
		let pq = 0, pp = 0, qq = 0;
		for (let k = 0; k < bins; k++) { const a = p[k] - mp, b = q[k] - mq; pq += a * b; pp += a * a; qq += b * b; }
		sum += pq / Math.sqrt(pp * qq + 1e-20); count++;
	}
	return count ? sum / count : 0;
}
/** 測試用：輸出時間 ↔ 畫面 x */
(window as any).__timeToX = (t: number) => view.timeToX(t);
/** 測試用：直接換上一組錨點（[src, out] 秒），走跟拖曳錨點一樣的路徑（記 undo、搬移、重算） */
(window as any).__stretchForTest = async (pairs: [number, number][]) => {
	if (!curves) return null;
	const before = curves.clone();
	curves.timeMap = new TimeMap(pairs.map(([src, out], i) => ({ id: i + 1, src, out })));
	history.push(before);
	remapSelection(before.timeMap, curves.timeMap);
	const dirty = applyTimeMap();
	if (dirty) await rerender(dirty.from, dirty.to, '伸縮');
	return dirty;
};

/** 測試用：在原始時間 [fromSrc, toSrc) 疊加移調 semis 與正弦抖音（原始時間上的 vibHz） */
(window as any).__pitchEditForTest = async (fromSrc: number, toSrc: number, semis: number, vibDepth: number, vibHz: number) => {
	if (!curves) return;
	history.push(curves);
	const before = curves.clone();
	for (let i = Curves.timeToFrame(fromSrc); i < Curves.timeToFrame(toSrc); i++) {
		curves.pitch[i] += semis + vibDepth * Math.sin(2 * Math.PI * vibHz * Curves.frameToTime(i));
	}
	void before;
	await rerender(toOut(fromSrc) - 0.2, toOut(toSrc) + 0.2, '測試移調');
};

/**
 * 測試用：伸縮後的聲音「實際」音高，跟「原本的音高曲線（+ 編輯）沿著時間對應拉長」差多少。
 *
 * 把輸出 [fromOut, toOut) 重取樣成 16kHz 重新跑 SwiftF0，逐格比較。
 * control 是故意不做時間對應（假裝沒伸縮）的誤差，用來確認這個量法分得出對錯。
 */
(window as any).__pitchCompare = async (fromOut: number, toOut: number) => {
	if (!curves || !track || !pitchMidi) return null;
	const sr = renderer.sampleRate;
	const a = Math.round(fromOut * sr), b = Math.round(toOut * sr), n = b - a;
	const off = new OfflineAudioContext(1, Math.ceil(n / sr * 16000), 16000);
	const buf = off.createBuffer(renderer.rendered.length, n, sr);
	renderer.rendered.forEach((c, i) => buf.copyToChannel(c.subarray(a, b), i));
	const node = off.createBufferSource();
	node.buffer = buf; node.connect(off.destination); node.start();
	const mono = (await off.startRendering()).getChannelData(0).slice();
	const det = await detectPitch(mono);

	const map = curves.timeMap;
	/** 原本的音高（+ 編輯）在原始時間 tSrc 的值；兩側格子都發聲才內插 */
	/** 偵測格位置 pos（可以有小數）上的音高 + 編輯，在曲線格之間線性內插 */
	const curvePitchAt = (pos: number): number => {
		const k = pos * CURVE_SUB, k0 = Math.floor(k), g = k - k0;
		const at = (j: number) => pitchMidi![j] + curves!.pitch[j];
		return k0 + 1 < curves!.length ? at(k0) * (1 - g) + at(k0 + 1) * g : at(Math.min(k0, curves!.length - 1));
	};
	const expectedAt = (tSrc: number): number | null => {
		const pos = (tSrc * 16000 - CENTER_OFFSET) / HOP;
		const i0 = Math.floor(pos);
		if (i0 < 0 || i0 + 1 >= track!.length || !track!.voiced[i0] || !track!.voiced[i0 + 1]) return null;
		return curvePitchAt(pos);
	};
	const errs: number[] = [], control: number[] = [];
	let origOnly = 0, newOnly = 0, both = 0;
	for (let j = 0; j < det.length; j++) {
		const tOut = fromOut + frameTime(j);
		if (tOut < fromOut + 0.3 || tOut > toOut - 0.3) continue;   // 偵測器在片段兩端缺前後文
		const exp = expectedAt(map.outToSrc(tOut));
		const nv = !!det.voiced[j];
		if (exp === null) { if (nv) newOnly++; continue; }
		if (!nv) { origOnly++; continue; }
		both++;
		const got = hzToMidi(det.f0[j]);
		errs.push((got - exp) * 100);
		const ctl = expectedAt(tOut);
		if (ctl !== null) control.push((got - ctl) * 100);
	}
	const stats = (x: number[]) => {
		if (!x.length) return null;
		const abs = x.map(Math.abs).sort((p, q) => p - q);
		const q = (p: number) => +abs[Math.min(abs.length - 1, Math.floor(p * abs.length))].toFixed(1);
		return {
			n: x.length, median: q(0.5), p90: q(0.9), over50: +(abs.filter(v => v > 50).length / abs.length).toFixed(3),
			bias: +(x.reduce((s, v) => s + v, 0) / x.length).toFixed(1),
		};
	};
	return { mapped: stats(errs), control: stats(control), voicing: { both, origOnly, newOnly } };
};

/** 測試用：直接設定橫向視野（前面的測試會改縮放與捲動，後面的測試需要一個確定的起點） */
(window as any).__setView = (startSec: number, spanSec: number) => {
	view.secPerPx = spanSec / (el.pianoroll.clientWidth || 1200);
	view.startSec = Math.max(0, startSec);
};

/** 選取範圍（含兩端斜坡）內的最大 |pitch| */
function maxDeltaIn(fromSec: number, toSec: number): number {
	return maxAbsIn('pitch', fromSec, toSec);
}

function maxAbsIn(id: LaneId, fromSec: number, toSec: number): number {
	if (!curves) return 0;
	const a = curves.lane(id);
	const pad = Math.ceil(0.1 / CURVE_HOP_SEC);   // 要涵蓋編輯的斜坡尾巴
	const i0 = Math.max(0, Curves.timeToFrame(toSrc(fromSec)) - pad);
	const i1 = Math.min(curves.length, Curves.timeToFrame(toSrc(toSec)) + pad);
	let m = 0;
	for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(a[i]));
	return +m.toFixed(4);
}

/**
 * 量一段範圍內音高的「抖動幅度」：先減掉移動中位數的中心線，再取標準差。
 * 減中心線是必要的——不然旋律走向會被算成抖動。
 */
function wobbleIn(fromSec: number, toSec: number): number | null {
	const vals = editedPitchIn(fromSec, toSec);
	if (!vals || vals.length < 8) return null;
	const half = 6;   // ±6 格 ≈ 200ms 的視窗
	let sum = 0;
	for (let k = 0; k < vals.length; k++) {
		const win = vals.slice(Math.max(0, k - half), Math.min(vals.length, k + half + 1)).sort((a, b) => a - b);
		const d = vals[k] - win[win.length >> 1];
		sum += d * d;
	}
	return +Math.sqrt(sum / vals.length).toFixed(4);
}

/** 整段音高的標準差（不減中心線）。壓成單一音高之後應該接近 0。 */
function spreadIn(fromSec: number, toSec: number): number | null {
	const vals = editedPitchIn(fromSec, toSec);
	if (!vals || vals.length < 8) return null;
	const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
	const v = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
	return +Math.sqrt(v).toFixed(4);
}

/** 選取範圍內「套用編輯之後」的音高（MIDI），只取發聲的格子 */
function editedPitchIn(fromSec: number, toSec: number): number[] | null {
	if (!curveVoiced || !curves || !pitchMidi) return null;
	// 取樣間隔維持 16ms，量出來的統計量才跟以前的測試基準一致
	const i0 = Curves.timeToFrame(toSrc(fromSec)), i1 = Curves.timeToFrame(toSrc(toSec));
	const vals: number[] = [];
	for (let i = i0; i < i1 && i < curves.length; i += CURVE_SUB) {
		if (curveVoiced[i]) vals.push(pitchMidi[i] + curves.pitch[i]);
	}
	return vals;
}

// ── 畫面更新 ────────────────────────────────────────────────────────────

function frame() {
	if (source) {
		const pos = player.position;
		el.clock.textContent = fmtTime(pos);
		applyFollow(pos);
		autoScrollAnchorDrag();
		player.tick();
		const loop = player.loopRegion;
		waveform.draw(pos, selection, curves, loop, renderingRange, selectedAnchors);
		refWave.draw(pos, selection, loop);
		pianoroll.draw(pos, selection, curves, loop, renderingRange, selectedAnchors);
		hbar.sync();
		vbar.sync();
	}
	requestAnimationFrame(frame);
}
frame();
