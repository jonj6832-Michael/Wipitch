// 波形顯示。
//
// 直接畫原始 sample 在縮小時會非常慢（100 秒 48kHz 有 480 萬個點），
// 所以先建一份 min/max 峰值快取：每 PEAK_SAMPLES 個 sample 存一組最大最小值。
// 縮小時從快取聚合，放大到比快取還細的時候才去讀原始 sample。
import type { Curves } from '../model/curves';
import type { Source } from '../audio/decode';
import type { ViewState } from './viewstate';
import type { Samples } from '../types';

const PEAK_SAMPLES = 256;

export class WaveformView {
	private ctx: CanvasRenderingContext2D;
	private peaks: { min: Float32Array; max: Float32Array } | null = null;
	private source: Source | null = null;

	/**
	 * 波形的顯示放大倍率（只影響畫面，不影響聲音）。素材很小聲時波形幾乎是一條線，
	 * 放大才看得到起伏。超出上下緣的部分夾在邊界。
	 */
	ampZoom = 1;

	constructor(private canvas: HTMLCanvasElement, private view: ViewState) {
		this.ctx = canvas.getContext('2d')!;
	}

	setSource(source: Source) {
		this.source = source;
		this.peaks = buildPeaks(source.channels[0]);
	}

	/** 總覽用：峰值快取與取樣率 */
	overviewData() {
		return this.source && this.peaks ? { peaks: this.peaks, rate: this.source.sampleRate } : null;
	}

	/**
	 * 波形會乘上增益曲線後才畫。
	 *
	 * 畫的是「原始峰值 × 目前的 gain 曲線」而不是算繪結果，因為算繪要等 500ms，
	 * 而拖音量滑桿時使用者要「當下」就看到波形變粗。第一階近似之下兩者相同。
	 */
	draw(
		playhead: number,
		selection: { start: number; end: number } | null,
		curves: Curves | null = null,
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

		ctx.fillStyle = '#1a1e25';
		ctx.fillRect(0, 0, w, h);

		if (!this.source || !this.peaks) return;
		const mid = h / 2;

		if (loop) {
			const x0 = view.timeToX(loop.start), x1 = view.timeToX(loop.end);
			ctx.fillStyle = 'rgba(255, 184, 108, 0.07)';
			ctx.fillRect(x0, 0, x1 - x0, h);
		}

		// 選取範圍底色
		if (selection) {
			const x0 = view.timeToX(selection.start), x1 = view.timeToX(selection.end);
			ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--sel') || 'rgba(90,200,250,.16)';
			ctx.fillRect(x0, 0, x1 - x0, h);
		}

		// 零線
		ctx.strokeStyle = '#2b313b';
		ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

		// 波形
		const z = this.ampZoom;
		const clampAmp = (v: number) => Math.max(-1, Math.min(1, v));

		// 畫的是原始音訊的峰值，但攤在輸出時間上：伸縮過的段落看起來就被拉長或壓扁
		const { sampleRate } = this.source;
		const map = curves?.timeMap;
		ctx.fillStyle = '#4a8fb0';

		for (let x = 0; x < w; x++) {
			const t0 = map ? map.outToSrc(view.xToTime(x)) : view.xToTime(x);
			const t1 = map ? map.outToSrc(view.xToTime(x + 1)) : view.xToTime(x + 1);
			const s0 = Math.floor(t0 * sampleRate), s1 = Math.ceil(t1 * sampleRate);
			const r = s1 - s0 >= PEAK_SAMPLES
				? peakRange(this.peaks, s0, s1)
				: rawRange(this.source.channels[0], s0, s1);
			if (!r) continue;
			const g = curves ? curves.linearGainAt(t0) : 1;
			const yTop = mid - clampAmp(r.max * g * z) * mid, yBot = mid - clampAmp(r.min * g * z) * mid;
			ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
		}

		if (rendering) {
			const x0 = view.timeToX(rendering.start), x1 = view.timeToX(rendering.end);
			ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
			ctx.fillRect(x0, 0, x1 - x0, h);
		}

		// 錨點：頂端一個小三角當把手，加一條細線。被選取的比較亮
		for (const a of map?.anchors ?? []) {
			const ax = Math.round(view.timeToX(a.out)) + 0.5;
			if (ax < -8 || ax > w + 8) continue;
			const on = selectedAnchors.has(a.id);
			ctx.strokeStyle = on ? '#ffd166' : 'rgba(255, 209, 102, 0.55)';
			ctx.lineWidth = 1;
			ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, h); ctx.stroke();
			ctx.fillStyle = on ? '#ffd166' : 'rgba(255, 209, 102, 0.75)';
			ctx.beginPath(); ctx.moveTo(ax - 6, 0); ctx.lineTo(ax + 6, 0); ctx.lineTo(ax, 9); ctx.closePath(); ctx.fill();
		}

		// 播放頭
		const px = view.timeToX(playhead);
		if (px >= 0 && px <= w) {
			ctx.strokeStyle = '#ff6b6b';
			ctx.lineWidth = 1;
			ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke();
		}
	}
}

/**
 * 參考音軌（伴奏、導唱）的波形，獨立一軌畫在主波形下方。
 * 照輸出時間 − offset 對齊，不跟著錨點伸縮。
 */
export class RefWaveformView {
	private ctx: CanvasRenderingContext2D;
	private peaks: { min: Float32Array; max: Float32Array } | null = null;
	private mono: Samples | null = null;
	private rate = 48000;
	ampZoom = 1;
	offset = 0;
	muted = false;

	constructor(private canvas: HTMLCanvasElement, private view: ViewState) {
		this.ctx = canvas.getContext('2d')!;
	}

	setAudio(channels: Samples[] | null, sampleRate = 48000) {
		if (!channels) { this.peaks = null; this.mono = null; return; }
		// 多聲道混成單聲道（取平均），跟主波形一樣只畫一條
		const mono = new Float32Array(channels[0].length) as Samples;
		for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channels.length;
		this.mono = mono;
		this.rate = sampleRate;
		this.peaks = buildPeaks(mono);
	}

	draw(playhead: number, selection: { start: number; end: number } | null, loop: { start: number; end: number } | null) {
		const { canvas, ctx, view } = this;
		const dpr = window.devicePixelRatio || 1;
		const w = canvas.clientWidth, h = canvas.clientHeight;
		if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
			canvas.width = w * dpr; canvas.height = h * dpr;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = '#161a20';
		ctx.fillRect(0, 0, w, h);
		const mid = h / 2;

		if (loop) {
			const x0 = view.timeToX(loop.start), x1 = view.timeToX(loop.end);
			ctx.fillStyle = 'rgba(255, 184, 108, 0.07)';
			ctx.fillRect(x0, 0, x1 - x0, h);
		}
		if (selection) {
			const x0 = view.timeToX(selection.start), x1 = view.timeToX(selection.end);
			ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--sel') || 'rgba(90,200,250,.16)';
			ctx.fillRect(x0, 0, x1 - x0, h);
		}
		ctx.strokeStyle = '#2b313b';
		ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

		if (this.peaks && this.mono) {
			const z = this.ampZoom;
			const clampAmp = (v: number) => Math.max(-1, Math.min(1, v));
			ctx.fillStyle = this.muted ? 'rgba(160, 200, 140, 0.25)' : '#8fb07a';
			for (let x = 0; x < w; x++) {
				const t0 = view.xToTime(x) - this.offset, t1 = view.xToTime(x + 1) - this.offset;
				if (t1 <= 0) continue;
				const s0 = Math.max(0, Math.floor(t0 * this.rate)), s1 = Math.ceil(t1 * this.rate);
				const r = s1 - s0 >= PEAK_SAMPLES ? peakRange(this.peaks, s0, s1) : rawRange(this.mono, s0, s1);
				if (!r) continue;
				const yTop = mid - clampAmp(r.max * z) * mid, yBot = mid - clampAmp(r.min * z) * mid;
				ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
			}
		}

		const px = view.timeToX(playhead);
		if (px >= 0 && px <= w) {
			ctx.strokeStyle = '#ff6b6b';
			ctx.lineWidth = 1;
			ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke();
		}
	}
}

/**
 * 範圍捲軸底下的總覽：整個時間軸（t0~t1，輸出時間）的迷你波形、選取範圍與播放頭。
 * 掛在 WaveformView 上是為了共用它的峰值快取。
 */
export function drawOverview(
	wv: WaveformView, ctx: CanvasRenderingContext2D, w: number, h: number, t0: number, t1: number,
	curves: Curves | null, playhead: number, selection: { start: number; end: number } | null,
) {
	const src = wv.overviewData();
	if (!src) return;
	const sx = (t: number) => ((t - t0) / Math.max(1e-9, t1 - t0)) * w;
	if (selection) {
		ctx.fillStyle = 'rgba(90, 200, 250, 0.16)';
		ctx.fillRect(sx(selection.start), 0, Math.max(1, sx(selection.end) - sx(selection.start)), h);
	}
	const map = curves?.timeMap;
	const mid = h / 2;
	ctx.fillStyle = 'rgba(74, 143, 176, 0.75)';
	for (let x = 0; x < w; x++) {
		const a = t0 + (x / w) * (t1 - t0), b = t0 + ((x + 1) / w) * (t1 - t0);
		const sa = map ? map.outToSrc(a) : a, sb = map ? map.outToSrc(b) : b;
		const r = peakRange(src.peaks, Math.floor(sa * src.rate), Math.ceil(sb * src.rate));
		if (!r) continue;
		const amp = Math.min(1, Math.max(Math.abs(r.max), Math.abs(r.min)) * 1.5);
		const bh = Math.max(1, amp * (h - 2));
		ctx.fillRect(x, mid - bh / 2, 1, bh);
	}
	const px = sx(playhead);
	ctx.fillStyle = '#ff6b6b';
	ctx.fillRect(Math.round(px), 0, 1, h);
}

function buildPeaks(x: Samples) {
	const n = Math.ceil(x.length / PEAK_SAMPLES);
	const min = new Float32Array(n), max = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const a = i * PEAK_SAMPLES, b = Math.min(a + PEAK_SAMPLES, x.length);
		let lo = Infinity, hi = -Infinity;
		for (let j = a; j < b; j++) { const v = x[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
		min[i] = lo; max[i] = hi;
	}
	return { min, max };
}

function peakRange(p: { min: Float32Array; max: Float32Array }, s0: number, s1: number) {
	const a = Math.max(0, Math.floor(s0 / PEAK_SAMPLES));
	const b = Math.min(p.min.length, Math.ceil(s1 / PEAK_SAMPLES));
	if (b <= a) return null;
	let lo = Infinity, hi = -Infinity;
	for (let i = a; i < b; i++) { if (p.min[i] < lo) lo = p.min[i]; if (p.max[i] > hi) hi = p.max[i]; }
	return { min: lo, max: hi };
}

function rawRange(x: Samples, s0: number, s1: number) {
	const a = Math.max(0, s0), b = Math.min(x.length, Math.max(s1, s0 + 1));
	if (b <= a) return null;
	let lo = Infinity, hi = -Infinity;
	for (let i = a; i < b; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
	return { min: lo, max: hi };
}
