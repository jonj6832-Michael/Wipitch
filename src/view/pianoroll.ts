// Automation 區：橫軸時間，縱軸依「目前作用中的 lane」而定。
//
// 三條線可以各自顯示／隱藏，其中一條是「作用中」的編輯對象：
//   音高    縱軸是 MIDI 音高（每格一個半音），畫的是「偵測到的音高 + Δ」的絕對值
//   音量    縱軸是 dB
//   Formant 縱軸是半音偏移
//
// 音高那條還會在有編輯時多畫一條淡色的原始線當對照，沒編輯的地方兩條完全重合。
import { frameTime, hzToMidi, midiToName, type PitchTrack } from '../analysis/swiftf0';
import { Curves, LANES, CURVE_HOP_SEC, CURVE_SUB, upsample, upsampleVoiced, type LaneId } from '../model/curves';
import type { ViewState } from './viewstate';
import type { TimeMap } from '../model/timemap';

const isBlackKey = (midi: number) => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);

export class PianoRollView {
	private ctx: CanvasRenderingContext2D;
	private track: PitchTrack | null = null;
	/** 偵測音高（MIDI）與發聲旗標內插到曲線格上，畫編輯後的音高用 */
	private fineMidi: Float32Array | null = null;
	private fineVoiced: Uint8Array | null = null;
	/**
	 * 每條 lane 各自的縱軸可視範圍。
	 *
	 * 跟 LANES 的 min/max 是兩回事：那個是「值的上下限」（畫筆會夾），
	 * 這個是「現在看得到哪一段」，可以縮放與捲動。音高那條的初始值是
	 * 從偵測結果的分位數算出來的，另外兩條就用各自的上下限當初始視野。
	 */
	private ranges: Record<LaneId, { lo: number; hi: number }> = {
		pitch: { lo: 48, hi: 72 },
		gain: { lo: LANES.gain.min, hi: LANES.gain.max },
		formant: { lo: LANES.formant.min, hi: LANES.formant.max },
	};
	/** 音高那條的預設視野，「還原」時要用 */
	private pitchFit = { lo: 48, hi: 72 };

	/** 要畫出來的 lane */
	visible: Set<LaneId> = new Set<LaneId>(['pitch']);
	/** 目前的編輯對象。它的縱軸刻度會畫在右側 */
	active: LaneId = 'pitch';

	private keyboardLayout = '';

	constructor(private canvas: HTMLCanvasElement, private view: ViewState, private keyboard: HTMLElement) {
		this.ctx = canvas.getContext('2d')!;
	}

	setTrack(track: PitchTrack) {
		this.track = track;
		this.fineMidi = upsample(track.f0.map(hzToMidi));
		this.fineVoiced = upsampleVoiced(track.voiced);

		// 用發聲格子的分位數決定縱軸範圍，不用最大最小值——
		// 偵測難免有少數離群值，用極值會讓畫面縮得很小。
		const midis: number[] = [];
		for (let i = 0; i < track.length; i++) {
			if (track.voiced[i]) midis.push(hzToMidi(track.f0[i]));
		}
		if (!midis.length) { this.setPitchRange(48, 72); return; }
		midis.sort((a, b) => a - b);
		const q = (p: number) => midis[Math.floor((midis.length - 1) * p)];
		let lo = Math.floor(q(0.02)) - 4;
		let hi = Math.ceil(q(0.98)) + 4;
		if (hi - lo < 14) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 7); hi = Math.ceil(mid + 7); }
		this.setPitchRange(lo, hi);
	}

	private setPitchRange(lo: number, hi: number) {
		this.pitchFit = { lo, hi };
		this.ranges.pitch = { lo, hi };
	}

	/** 縱向縮放。以游標所在的 y 為錨點，跟橫向縮放同一個道理——看的地方不要跑掉。 */
	zoomV(factor: number, anchorY: number, h: number) {
		const id = this.active;
		const r = this.ranges[id];
		const anchor = this.yToLaneValue(id, anchorY, h);
		// 跟滑桿共用同一組上下限，不然兩種操作方式的可及範圍會不一樣
		const { full, min } = this.vLimits();
		const span = Math.min(full, Math.max(min, (r.hi - r.lo) * factor));
		// 錨點在畫面上的相對位置維持不變
		const f = (anchor - r.lo) / (r.hi - r.lo);
		this.ranges[id] = { lo: anchor - f * span, hi: anchor + (1 - f) * span };
	}

	/** 縱向捲動。deltaPx 是畫面上的像素，往下捲 = 看更低的值。 */
	scrollV(deltaPx: number, h: number) {
		const id = this.active;
		const r = this.ranges[id];
		const d = (r.hi - r.lo) * (deltaPx / Math.max(1, h));
		this.setRangeV(r.lo + d, r.hi + d);
	}

	/**
	 * 縱向可以捲動的全長：以預設視野的中心為中心、長度等於「縮到最小」的那個跨度。
	 * 範圍捲軸拿它當軌道全長，滾輪捲動也夾在裡面，兩種操作可及的範圍才一致。
	 */
	vExtent() {
		const { full } = this.vLimits();
		const fit = this.fitRange(this.active);
		const c = (fit.lo + fit.hi) / 2;
		return { lo: c - full / 2, hi: c + full / 2 };
	}

	/** 直接指定目前這條 lane 的縱向可視範圍（範圍捲軸用）。keep = 縮放被夾限時固定不動的那一端 */
	setRangeV(lo: number, hi: number, keep?: 'lo' | 'hi') {
		const { full, min } = this.vLimits();
		const span = Math.min(full, Math.max(min, hi - lo));
		const ext = this.vExtent();
		let l = keep === 'hi' ? hi - span : lo;
		l = Math.max(ext.lo, Math.min(ext.hi - span, l));
		this.ranges[this.active] = { lo: l, hi: l + span };
	}

	private fitRange(id: LaneId) {
		return id === 'pitch' ? { ...this.pitchFit } : { lo: LANES[id].min, hi: LANES[id].max };
	}

	/** 目前這條 lane 的縱向縮放程度，0 = 預設視野、1 = 最大倍率 */
	vZoomFraction(): number {
		const { full, min } = this.vLimits();
		const span = this.ranges[this.active].hi - this.ranges[this.active].lo;
		if (full <= min) return 0;
		return Math.log(full / Math.max(min, span)) / Math.log(full / min);
	}

	setVZoomFraction(f: number) {
		const id = this.active;
		const { full, min } = this.vLimits();
		const r = this.ranges[id];
		const mid = (r.lo + r.hi) / 2;
		const span = full * Math.pow(min / full, Math.max(0, Math.min(1, f)));
		this.ranges[id] = { lo: mid - span / 2, hi: mid + span / 2 };
	}

	/**
	 * 縱向縮放的兩端。
	 *
	 * `full`（滑桿最左 = 縮到最小）要比預設視野**更寬**，不然「縮小」根本沒得縮——
	 * 預設視野是貼著素材音域算出來的，那已經是很緊的框了。
	 * `min`（滑桿最右 = 放到最大）則刻意不做太細：音高放到剩 4 個半音就夠看清楚
	 * 抖音的形狀了，再放大只是讓曲線跑出畫面。
	 */
	private vLimits() {
		const id = this.active;
		if (id === 'pitch') {
			const fit = this.pitchFit.hi - this.pitchFit.lo;
			return { full: Math.max(fit * 2.5, 60), min: 4 };
		}
		const span = LANES[id].max - LANES[id].min;
		return { full: span * 2, min: span / 6 };
	}

	/** 把目前這條 lane 的縱軸還原成預設視野 */
	fitV() {
		const id = this.active;
		this.ranges[id] = this.fitRange(id);
	}

	/** 目前這條 lane 的縱軸範圍，給狀態列顯示用 */
	rangeOf(id: LaneId) { return this.ranges[id]; }

	/** MIDI 號碼 → y 座標 */
	private midiToY(midi: number, h: number): number {
		const { lo, hi } = this.ranges.pitch;
		return h - ((midi - lo) / (hi - lo)) * h;
	}

	/** y 座標 → MIDI 號碼（拖曳時要用） */
	yToMidi(y: number, h: number): number {
		const { lo, hi } = this.ranges.pitch;
		return lo + ((h - y) / h) * (hi - lo);
	}

	/** 一個半音在畫面上有多少像素 */
	semitonePx(h: number): number {
		const { lo, hi } = this.ranges.pitch;
		return h / (hi - lo);
	}

	/** 非音高 lane 的值 → y 座標 */
	private laneToY(id: LaneId, v: number, h: number): number {
		const { lo, hi } = this.ranges[id];
		return h - ((v - lo) / (hi - lo)) * h;
	}

	/** y 座標 → lane 的值。畫筆與垂直拖曳都要用 */
	yToLaneValue(id: LaneId, y: number, h: number): number {
		if (id === 'pitch') return this.yToMidi(y, h);
		const { lo, hi } = this.ranges[id];
		return lo + ((h - y) / h) * (hi - lo);
	}

	/** 一個單位（半音／dB）在畫面上有多少像素。垂直拖曳的換算用 */
	unitPx(id: LaneId, h: number): number {
		if (id === 'pitch') return this.semitonePx(h);
		const { lo, hi } = this.ranges[id];
		return h / (hi - lo);
	}

	draw(
		playhead: number,
		selection: { start: number; end: number } | null,
		curves: Curves | null,
		loop: { start: number; end: number } | null = null,
		rendering: { start: number; end: number } | null = null,
		selectedAnchors: ReadonlySet<number> = new Set(),
	) {
		const { canvas, ctx, view } = this;
		const dpr = window.devicePixelRatio || 1;
		const w = canvas.clientWidth, h = canvas.clientHeight;
		if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
			canvas.width = w * dpr; canvas.height = h * dpr;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = '#171b21';
		ctx.fillRect(0, 0, w, h);

		// 格線永遠是音高的（黑白鍵底色是這個畫面最重要的空間參考），
		// 作用中的 lane 若不是音高，它自己的刻度另外畫在右側。
		this.drawGrid(w, h);
		this.drawKeyboard(h);

		if (loop) {
			const x0 = view.timeToX(loop.start), x1 = view.timeToX(loop.end);
			ctx.fillStyle = 'rgba(255, 184, 108, 0.07)';
			ctx.fillRect(x0, 0, x1 - x0, h);
		}

		if (selection) {
			const x0 = view.timeToX(selection.start), x1 = view.timeToX(selection.end);
			ctx.fillStyle = 'rgba(90, 200, 250, 0.13)';
			ctx.fillRect(x0, 0, x1 - x0, h);
			ctx.strokeStyle = 'rgba(90, 200, 250, 0.5)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, h);
			ctx.moveTo(x1 - 0.5, 0); ctx.lineTo(x1 - 0.5, h);
			ctx.stroke();
		}

		// 先畫沒有作用的 lane（比較暗），作用中的最後畫，才不會被蓋住
		for (const id of ['pitch', 'gain', 'formant'] as LaneId[]) {
			if (!this.visible.has(id) || id === this.active) continue;
			this.drawLane(w, h, id, curves, 0.3);
		}
		if (this.visible.has(this.active)) this.drawLane(w, h, this.active, curves, 1);
		if (this.active !== 'pitch') this.drawLaneAxis(w, h, this.active);

		// 正在重算的範圍。蓋在曲線上面，讓使用者看得到「是這一段在跑」
		if (rendering) {
			const x0 = view.timeToX(rendering.start), x1 = view.timeToX(rendering.end);
			ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
			ctx.fillRect(x0, 0, x1 - x0, h);
		}

		// 錨點延伸到 automation 區的虛線，方便對照伸縮落在哪個音上
		for (const a of curves?.timeMap.anchors ?? []) {
			const ax = Math.round(view.timeToX(a.out)) + 0.5;
			if (ax < 0 || ax > w) continue;
			ctx.strokeStyle = selectedAnchors.has(a.id) ? 'rgba(255, 209, 102, 0.8)' : 'rgba(255, 209, 102, 0.3)';
			ctx.lineWidth = 1;
			ctx.setLineDash([4, 4]);
			ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, h); ctx.stroke();
			ctx.setLineDash([]);
		}

		const px = view.timeToX(playhead);
		if (px >= 0 && px <= w) {
			ctx.strokeStyle = '#ff6b6b';
			ctx.lineWidth = 1;
			ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke();
		}
	}

	private drawLane(w: number, h: number, id: LaneId, curves: Curves | null, alpha: number) {
		const { ctx } = this;
		ctx.save();
		ctx.globalAlpha = alpha;
		if (id === 'pitch') {
			if (this.track) {
				// 有編輯的話先畫淡色的原始線當對照
				const map = curves?.timeMap ?? null;
				if (curves && hasEdits(curves.pitch)) {
					this.drawContour(w, h, null, 'rgba(216, 222, 233, 0.22)', 1.5, map);
				}
				this.drawContour(w, h, curves, LANES.pitch.color, 2, map);
			}
		} else {
			this.drawFlatLane(w, h, id, curves);
		}
		ctx.restore();
	}

	/** 畫 gain / formant 這種「值本身就是曲線」的 lane */
	private drawFlatLane(w: number, h: number, id: LaneId, curves: Curves | null) {
		const { ctx, view } = this;
		const spec = LANES[id];

		// 中性值的水平參考線
		const zeroY = this.laneToY(id, spec.neutral, h);
		ctx.strokeStyle = 'rgba(216,222,233,0.12)';
		ctx.setLineDash([3, 3]);
		ctx.lineWidth = 1;
		ctx.beginPath(); ctx.moveTo(0, zeroY + 0.5); ctx.lineTo(w, zeroY + 0.5); ctx.stroke();
		ctx.setLineDash([]);

		if (!curves) return;
		const a = curves.lane(id);
		ctx.strokeStyle = spec.color;
		ctx.lineWidth = 2;
		ctx.lineJoin = 'round';
		ctx.beginPath();
		for (let x = 0; x <= w; x++) {
			// 曲線存在原始時間，畫面是輸出時間
			const i = Math.round(curves.timeMap.outToSrc(view.xToTime(x)) / CURVE_HOP_SEC);
			const v = a[Math.max(0, Math.min(a.length - 1, i))] ?? spec.neutral;
			const y = this.laneToY(id, v, h);
			if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}

	/** 作用中的 lane 不是音高時，在右邊畫出它自己的刻度 */
	private drawLaneAxis(w: number, h: number, id: LaneId) {
		const { ctx } = this;
		const spec = LANES[id];
		const { lo, hi } = this.ranges[id];
		// 刻度間隔跟著可視範圍走，放大時才看得到更細的格子
		const raw = (hi - lo) / 6;
		const step = [0.5, 1, 2, 3, 4, 6, 12, 24].find(v => v >= raw) ?? 48;
		ctx.font = '10px system-ui, sans-serif';
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'right';
		ctx.fillStyle = spec.color;
		ctx.globalAlpha = 0.7;
		for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
			const y = this.laneToY(id, v, h);
			if (y < 6 || y > h - 6) continue;
			const label = step < 1 ? v.toFixed(1) : String(Math.round(v));
			ctx.fillText(`${v > 0 ? '+' : ''}${label}`, w - 6, y);
		}
		ctx.globalAlpha = 1;
		ctx.textAlign = 'left';
	}

	/** 琴鍵與曲線共用 midiToY，視野或高度改變時才更新 DOM。 */
	private drawKeyboard(h: number) {
		if (h <= 0) return;
		const { lo, hi } = this.ranges.pitch;
		const layout = `${lo}:${hi}:${h}`;
		if (layout === this.keyboardLayout) return;
		this.keyboardLayout = layout;
		const step = this.semitonePx(h);
		const keys = document.createDocumentFragment();
		// 多畫上下各兩個半音，讓視野邊緣的半個琴鍵也能完整覆蓋。
		for (let m = Math.floor(lo) - 2; m <= Math.ceil(hi) + 2; m++) {
			const black = isBlackKey(m);
			const octave = ((m % 12) + 12) % 12 === 0;
			const y = this.midiToY(m, h);
			// 白鍵相接於相鄰白鍵的中點；黑鍵中心正對自己的半音格。
			const above = isBlackKey(m + 1) ? 2 : 1;
			const below = isBlackKey(m - 1) ? 2 : 1;
			const top = black ? y - step * 0.46 : this.midiToY(m + above / 2, h);
			const bottom = black ? y + step * 0.46 : this.midiToY(m - below / 2, h);
			if (bottom <= 0 || top >= h) continue;
			const key = document.createElement('div');
			key.className = `piano-key ${black ? 'black' : 'white'}${octave ? ' octave' : ''}`;
			key.dataset.midi = String(m);
			key.title = midiToName(m);
			key.style.top = `${top}px`;
			key.style.height = `${bottom - top}px`;
			if (step >= 14 || (octave && step >= 7)) {
				const label = document.createElement('span');
				label.textContent = midiToName(m);
				// 音名對準音高中心，並非白鍵外框的幾何中心。
				label.style.top = `${y - top - 1}px`;
				key.appendChild(label);
			}
			keys.appendChild(key);
		}
		this.keyboard.replaceChildren(keys);
	}

	private drawGrid(w: number, h: number) {
		const { ctx } = this;
		const step = this.semitonePx(h);
		ctx.lineWidth = 1;
		ctx.font = '10px system-ui, sans-serif';
		ctx.textBaseline = 'middle';

		const { lo: loMidi, hi: hiMidi } = this.ranges.pitch;
		// 縱向放到很大時整數半音的格線會多到畫不完，限制一下總數
		if (hiMidi - loMidi > 200) return;
		for (let m = Math.ceil(loMidi); m <= hiMidi; m++) {
			const y = this.midiToY(m, h);
			// 黑鍵那幾格塗底色，讓縱軸一眼看得出是哪個音
			if (isBlackKey(m) && step > 3) {
				ctx.fillStyle = 'rgba(0,0,0,0.24)';
				ctx.fillRect(0, y - step / 2, w, step);
			}
			// 半音與半音的交界畫一條暗線，相鄰的白鍵（E-F、B-C）才分得開
			if (step > 3) {
				const edge = Math.round(y - step / 2) + 0.5;
				ctx.strokeStyle = 'rgba(0,0,0,0.22)';
				ctx.beginPath(); ctx.moveTo(0, edge); ctx.lineTo(w, edge); ctx.stroke();
			}
		}
	}

	/**
	 * 畫音高曲線。curves 傳 null 就畫原始音高，傳曲線就畫套用 Δ 之後的音高。
	 *
	 * 未發聲的格子要把線斷開，不能硬連——不然休止符處會出現一條橫跨的假線。
	 */
	private drawContour(w: number, h: number, curves: Curves | null, color: string, width: number, map: TimeMap | null) {
		const { ctx, view, track } = this;
		if (!track) return;
		// 音高格子在原始時間，畫面是輸出時間
		const srcToOut = (t: number) => map ? map.srcToOut(t) : t;
		const outToSrc = (t: number) => map ? map.outToSrc(t) : t;

		// 只畫看得到的範圍，不然 100 秒的檔案每一幀都要跑幾萬格。
		// 原始音高走偵測格（16ms）；編輯後的音高走曲線格（2ms），伸縮拉長後抖音才畫得圓。
		const t0 = outToSrc(view.xToTime(0)), t1 = outToSrc(view.xToTime(w));
		const fine = !!curves && !!this.fineMidi && !!this.fineVoiced;
		const hop = fine ? CURVE_HOP_SEC : 0.016;
		const n = fine ? curves!.length : track.length;
		const i0 = Math.max(0, Math.floor(t0 / hop) - 1);
		const i1 = Math.min(n, Math.ceil(t1 / hop) + 1);
		// 一個像素畫不下好幾格時跳著畫，線不會變，只是省掉看不出來的點
		const stride = Math.max(1, Math.floor((view.secPerPx / (map ? Math.max(1e-6, map.ratioAt((t0 + t1) / 2)) : 1)) / hop / 2));

		ctx.strokeStyle = color;
		ctx.lineWidth = width;
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.beginPath();

		let drawing = false;
		for (let i = i0; i < i1; i += fine ? stride : 1) {
			let t: number, midi: number;
			if (fine) {
				if (!this.fineVoiced![i]) { drawing = false; continue; }
				t = frameTime(i / CURVE_SUB);
				midi = this.fineMidi![i] + curves!.pitch[i];
			} else {
				if (!track.voiced[i]) { drawing = false; continue; }
				t = frameTime(i);
				midi = hzToMidi(track.f0[i]) + (curves ? curves.pitch[i * CURVE_SUB] : 0);
			}
			const x = view.timeToX(srcToOut(t)), y = this.midiToY(midi, h);
			if (!drawing) { ctx.moveTo(x, y); drawing = true; }
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}
}

function hasEdits(a: Float32Array): boolean {
	for (let i = 0; i < a.length; i++) if (a[i] !== 0) return true;
	return false;
}
