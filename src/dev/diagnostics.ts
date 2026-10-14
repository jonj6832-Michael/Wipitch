import { Curves, CURVE_HOP_SEC, CURVE_SUB, type LaneId } from '../model/curves';
import { TimeMap } from '../model/timemap';
import { hzToMidi, frameTime, HOP, CENTER_OFFSET, type PitchTrack } from '../analysis/swiftf0';

import type { Source } from '../audio/decode';
import type { ViewState } from '../view/viewstate';
import type { Player } from '../engine/player';
import type { Renderer } from '../engine/renderer';
import type { History } from '../model/history';
import type { PianoRollView } from '../view/pianoroll';
import type { WaveformView, RefWaveformView } from '../view/waveform';

export interface DiagnosticContext {
 readonly curves: Curves | null;
 readonly source: Source | null;
 readonly track: PitchTrack | null;
 readonly selection: { start: number; end: number } | null;
 readonly pitchMidi: Float32Array | null;
 readonly curveVoiced: Uint8Array | null;
 readonly followPlayhead: boolean;
 readonly selectedAnchors: Set<number>;
 readonly backgroundWaiting: boolean;
 view: ViewState; player: Player; renderer: Renderer; history: History;
 pianoroll: PianoRollView; waveform: WaveformView; refWave: RefWaveformView;
 ref: { name: string | null; gainDb: number; muted: boolean; offsetSec: number };
 el: { vibOn: HTMLInputElement; vibDepth: HTMLInputElement; vibOnsetOn: HTMLInputElement;
 vibOnset: HTMLInputElement; pianoroll: HTMLCanvasElement; waveform: HTMLCanvasElement;
 refwave: HTMLCanvasElement; bgStatus: HTMLElement };
 toSrc(t: number): number; toOut(t: number): number; outDuration(): number;
 waitBackground(): Promise<void>;
 rerender(from: number, to: number, label: string): Promise<unknown>;
 remapSelection(before: TimeMap, after: TimeMap): void;
 applyTimeMap(): { from: number; to: number } | null;
 load(file: File): Promise<unknown>;
 status(message: string): void;
}

/** Development-only adapter. Mutable app state is supplied through live getters. */
export function installDiagnostics(state: DiagnosticContext, target: object, search = '') {
 const { view, player, renderer, history, pianoroll, waveform, refWave, ref,
 el, toSrc, toOut, outDuration, waitBackground, rerender, remapSelection, applyTimeMap } = state;
 const hooks = {} as Record<string, (...args: any[]) => any>;
 let progressTicks = 0, bgApplied = 0;
// 測試用：直接把播放頭放到指定秒數（正常操作是點波形軌）
hooks.__seekForTest = (sec: number) => player.seek(sec);

// 開發／測試用的內部狀態查詢窗口
/** 測試用：畫面 x 位置上某條 lane 的值；pitch 另外回傳絕對音高（未發聲為 null） */
hooks.__laneAtX = (id: LaneId, x: number) => {
	if (!state.curves) return null;
	const t = toSrc(view.xToTime(x));
	const i = Curves.timeToFrame(t);
	const v = state.curves.valueAt(id, t);
	const abs = id === 'pitch' && state.pitchMidi && state.curveVoiced && state.curveVoiced[i] ? state.pitchMidi[i] + state.curves.pitch[i] : null;
	return { v, abs };
};

function pitchStepIn(fromOut: number, toOut_: number) {
	if (!state.curves || !state.curveVoiced) return null;
	const i0 = Math.max(1, Curves.timeToFrame(toSrc(fromOut))), i1 = Math.min(state.curves.length, Curves.timeToFrame(toSrc(toOut_)));
	let max = 0, unvoiced = 0;
	for (let i = i0; i < i1; i++) {
		max = Math.max(max, Math.abs(state.curves.pitch[i] - state.curves.pitch[i - 1]));
		if (!state.curveVoiced[i]) unvoiced++;
	}
	return { max: +max.toFixed(4), unvoiced };
}

hooks.__debug = () => {
	if (!state.curves || !state.source) return null;
	let maxDelta = 0, edited = 0;
	for (let i = 0; i < state.curves.length; i++) {
		const d = Math.abs(state.curves.pitch[i]);
		if (d > 1e-9) edited++;
		if (d > maxDelta) maxDelta = d;
	}
	// 算繪結果跟原始音訊差多少，用來確認聲音真的被改過
	let diff = 0, refEnergy = 0;
	const a = state.source.channels[0], b = renderer.rendered[0];
	for (let i = 0; i < a.length; i += 97) { const d = a[i] - b[i]; diff += d * d; refEnergy += a[i] * a[i]; }
	return {
		maxDelta: +maxDelta.toFixed(3),
		editedFrames: edited,
		editedSeconds: +(edited * CURVE_HOP_SEC).toFixed(2),
		renderDiffRatio: +(Math.sqrt(diff / (refEnergy + 1e-20))).toFixed(4),
		historyDepth: history.depth,
		redoDepth: history.redoDepth,
		/** 選取範圍內「音高圍繞平滑中心線的起伏」標準差（半音）。壓平之後應該要變小。 */
		wobble: state.selection ? wobbleIn(state.selection.start, state.selection.end) : null,
		/** 選取範圍內音高的整體標準差（半音）。α=0 壓成單一音高之後應該接近 0。 */
		spread: state.selection ? spreadIn(state.selection.start, state.selection.end) : null,
		/** 只看選取範圍內的編輯量（maxDelta 是整個檔案的，測局部功能時會被別處的編輯干擾） */
		selMaxDelta: state.selection ? maxDeltaIn(state.selection.start, state.selection.end) : null,
		selMaxGainDb: state.selection ? maxAbsIn('gain', state.selection.start, state.selection.end) : null,
		selMaxFormant: state.selection ? maxAbsIn('formant', state.selection.start, state.selection.end) : null,
		/** 選取範圍內相鄰曲線格音高偏移的最大差（半音）與其中未發聲的格數 */
		selPitchStep: state.selection ? pitchStepIn(state.selection.start, state.selection.end) : null,
		pitchSlopeLimit: state.curves.pitchSlopeLimit,
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
		following: state.followPlayhead,
		/** 播放頭位置（秒）。時鐘是下一個動畫幀才更新，測試要看這個才不會讀到舊值 */
		playhead: +player.position.toFixed(3),
		looping: !!player.loopRegion,
		selection: state.selection,
		anchors: state.curves.timeMap.anchors.map(a => ({ id: a.id, src: +a.src.toFixed(4), out: +a.out.toFixed(4) })),
		selectedAnchors: [...state.selectedAnchors],
		outDuration: +outDuration().toFixed(4),
		renderedSec: +(renderer.rendered[0].length / renderer.sampleRate).toFixed(4),
		bgProgress: renderer.backgroundProgress,
		bgWaiting: state.backgroundWaiting,
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
hooks.__waitBackground = waitBackground;

/**
 * 測試用：記下目前算繪結果的某一段（輸出時間），之後拿來比對。
 * 「歸零之後要回到同樣的聲音」這種驗收需要它。
 */
const renderSnaps = new Map<string, Float32Array>();
hooks.__snapRendered = (name: string, fromSec: number, toSec: number) => {
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
hooks.__compareSnap = (name: string, fromSec: number) => {
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
hooks.__rerenderForTest = (fromSec: number, toSec: number) => rerender(fromSec, toSec, '測試重算');

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
hooks.__timeToX = (t: number) => view.timeToX(t);
/** 測試用：直接換上一組錨點（[src, out] 秒），走跟拖曳錨點一樣的路徑（記 undo、搬移、重算） */
hooks.__stretchForTest = async (pairs: [number, number][]) => {
	if (!state.curves) return null;
	const before = state.curves.clone();
	state.curves.timeMap = new TimeMap(pairs.map(([src, out], i) => ({ id: i + 1, src, out })));
	history.push(before);
	remapSelection(before.timeMap, state.curves.timeMap);
	const dirty = applyTimeMap();
	if (dirty) await rerender(dirty.from, dirty.to, '伸縮');
	return dirty;
};

/** 測試用：在原始時間 [fromSrc, toSrc) 疊加移調 semis 與正弦抖音（原始時間上的 vibHz） */
hooks.__pitchEditForTest = async (fromSrc: number, toSrc: number, semis: number, vibDepth: number, vibHz: number) => {
	if (!state.curves) return;
	history.push(state.curves);
	const before = state.curves.clone();
	for (let i = Curves.timeToFrame(fromSrc); i < Curves.timeToFrame(toSrc); i++) {
		state.curves.pitch[i] += semis + vibDepth * Math.sin(2 * Math.PI * vibHz * Curves.frameToTime(i));
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
hooks.__pitchCompare = async (fromOut: number, toOut: number) => {
	if (!state.curves || !state.track || !state.pitchMidi) return null;
	const sr = renderer.sampleRate;
	const a = Math.round(fromOut * sr), b = Math.round(toOut * sr), n = b - a;
	const off = new OfflineAudioContext(1, Math.ceil(n / sr * 16000), 16000);
	const buf = off.createBuffer(renderer.rendered.length, n, sr);
	renderer.rendered.forEach((c, i) => buf.copyToChannel(c.subarray(a, b), i));
	const node = off.createBufferSource();
	node.buffer = buf; node.connect(off.destination); node.start();
	const mono = (await off.startRendering()).getChannelData(0).slice();
	const { detectPitch } = await import('../analysis/pitch');
	const det = await detectPitch(mono);

	const map = state.curves.timeMap;
	/** 原本的音高（+ 編輯）在原始時間 tSrc 的值；兩側格子都發聲才內插 */
	/** 偵測格位置 pos（可以有小數）上的音高 + 編輯，在曲線格之間線性內插 */
	const curvePitchAt = (pos: number): number => {
		const k = pos * CURVE_SUB, k0 = Math.floor(k), g = k - k0;
		const at = (j: number) => state.pitchMidi![j] + state.curves!.pitch[j];
		return k0 + 1 < state.curves!.length ? at(k0) * (1 - g) + at(k0 + 1) * g : at(Math.min(k0, state.curves!.length - 1));
	};
	const expectedAt = (tSrc: number): number | null => {
		const pos = (tSrc * 16000 - CENTER_OFFSET) / HOP;
		const i0 = Math.floor(pos);
		if (i0 < 0 || i0 + 1 >= state.track!.length || !state.track!.voiced[i0] || !state.track!.voiced[i0 + 1]) return null;
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
hooks.__setView = (startSec: number, spanSec: number) => {
	view.secPerPx = spanSec / (el.pianoroll.clientWidth || 1200);
	view.startSec = Math.max(0, startSec);
};

/** 選取範圍（含兩端斜坡）內的最大 |pitch| */
function maxDeltaIn(fromSec: number, toSec: number): number {
	return maxAbsIn('pitch', fromSec, toSec);
}

function maxAbsIn(id: LaneId, fromSec: number, toSec: number): number {
	if (!state.curves) return 0;
	const a = state.curves.lane(id);
	const pad = Math.ceil(0.1 / CURVE_HOP_SEC);   // 要涵蓋編輯的斜坡尾巴
	const i0 = Math.max(0, Curves.timeToFrame(toSrc(fromSec)) - pad);
	const i1 = Math.min(state.curves.length, Curves.timeToFrame(toSrc(toSec)) + pad);
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
	if (!state.curveVoiced || !state.curves || !state.pitchMidi) return null;
	// 取樣間隔維持 16ms，量出來的統計量才跟以前的測試基準一致
	const i0 = Curves.timeToFrame(toSrc(fromSec)), i1 = Curves.timeToFrame(toSrc(toSec));
	const vals: number[] = [];
	for (let i = i0; i < i1 && i < state.curves.length; i += CURVE_SUB) {
		if (state.curveVoiced[i]) vals.push(state.pitchMidi[i] + state.curves.pitch[i]);
	}
	return vals;
}


 Object.assign(target, hooks);
 const params = new URLSearchParams(search);
 return {
  recordProgress() { progressTicks++; },
  recordBackgroundApplied() { bgApplied++; },
  applyViewParams() {
   if (!params.has('t') && !params.has('span')) return;
   const span = Number(params.get('span') || 6), start = Number(params.get('t') || 0);
   view.secPerPx = (Number.isFinite(span) && span > 0 ? span : 6) / (el.pianoroll.clientWidth || 1200);
   view.startSec = Number.isFinite(start) ? Math.max(0, start) : 0;
   player.seek(view.startSec);
  },
  async autoload() {
   const url = params.get('autoload');
   if (!url) return;
   try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await state.load(new File([await response.blob()], url.split('/').pop() || 'audio.wav'));
   } catch (error) { state.status(`autoload 失敗：${error instanceof Error ? error.message : error}`); }
  },
  dispose() {
   const installed = target as Record<string, unknown>;
   for (const [name, hook] of Object.entries(hooks)) if (installed[name] === hook) delete installed[name];
   renderSnaps.clear();
  },
 };
}
export type Diagnostics = ReturnType<typeof installDiagnostics>;
