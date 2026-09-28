// 範圍捲軸：捲軸的滑塊就是「目前畫面上看得到的範圍」。
//
// 拖滑塊中間 = 捲動，拖兩端 = 縮放（另一端不動），點軌道空白處 = 跳過去，
// 雙擊 = 還原成全覽。同時是捲軸也是縮放器，不必知道任何滾輪組合鍵。
//
// 元件本身不存狀態：每幀從模型讀範圍來擺滑塊，操作時把新範圍交給模型去夾限。
// 所以用滾輪改視野時滑塊自然會跟著動，也不會跟使用者的手打架。

export type Range = { lo: number; hi: number };

export interface RangeSource {
	/** 可以捲動的全長 */
	extent(): Range;
	/** 目前畫面上的範圍 */
	visible(): Range;
	/** 設定新範圍。keep = 縮放時哪一端要固定不動（被夾限時由另一端讓步） */
	setVisible(lo: number, hi: number, keep?: 'lo' | 'hi'): void;
	fit(): void;
}

export class RangeBar {
	private thumb: HTMLDivElement;
	private bg: HTMLCanvasElement | null = null;
	private drag: { mode: 'move' | 'lo' | 'hi'; startPos: number; start: Range } | null = null;

	constructor(
		private root: HTMLElement,
		private orient: 'h' | 'v',
		private src: RangeSource,
		/** 橫向版在軌道底下畫總覽用 */
		private drawBackground?: (ctx: CanvasRenderingContext2D, w: number, h: number, extent: Range) => void,
	) {
		root.classList.add('rangebar', orient === 'h' ? 'rb-h' : 'rb-v');
		if (drawBackground) {
			this.bg = document.createElement('canvas');
			root.appendChild(this.bg);
		}
		this.thumb = document.createElement('div');
		this.thumb.className = 'rb-thumb';
		this.thumb.innerHTML = '<div class="rb-edge rb-lo"></div><div class="rb-edge rb-hi"></div>';
		root.appendChild(this.thumb);
		root.title = orient === 'h'
			? '拖中間捲動、拖左右兩端縮放、點空白處跳過去，雙擊看全部'
			: '拖中間上下捲動、拖上下兩端縮放、點空白處跳過去，雙擊還原';

		root.addEventListener('pointerdown', e => this.down(e));
		root.addEventListener('pointermove', e => this.move(e));
		root.addEventListener('pointerup', e => this.up(e));
		root.addEventListener('pointercancel', e => this.up(e));
		root.addEventListener('dblclick', () => this.src.fit());
		root.addEventListener('wheel', e => {
			e.preventDefault();
			const vis = this.src.visible();
			const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
			// 一格滾輪捲可視範圍的 1/5；縱向往下滾 = 看更低的值
			const k = (d / 100) * (vis.hi - vis.lo) * 0.2 * (this.orient === 'v' ? -1 : 1);
			this.src.setVisible(vis.lo + k, vis.hi + k);
		}, { passive: false });
	}

	/** 滑鼠位置換算成值（橫向左小右大；縱向下小上大，跟曲線區一致） */
	private valueAt(e: PointerEvent) {
		const r = this.root.getBoundingClientRect();
		const f = this.orient === 'h'
			? (e.clientX - r.left) / Math.max(1, r.width)
			: (r.bottom - e.clientY) / Math.max(1, r.height);
		const ext = this.src.extent();
		return ext.lo + f * (ext.hi - ext.lo);
	}

	private down(e: PointerEvent) {
		if (e.button !== 0) return;
		const t = e.target as HTMLElement;
		let mode: 'move' | 'lo' | 'hi';
		if (t.classList.contains('rb-lo')) mode = 'lo';
		else if (t.classList.contains('rb-hi')) mode = 'hi';
		else if (t === this.thumb) mode = 'move';
		else {
			// 點在空白處：滑塊中心跳過去，接著可以直接拖
			const v = this.valueAt(e);
			const vis = this.src.visible();
			const span = vis.hi - vis.lo;
			this.src.setVisible(v - span / 2, v + span / 2);
			mode = 'move';
		}
		this.drag = { mode, startPos: this.valueAt(e), start: { ...this.src.visible() } };
		this.root.classList.add('dragging');
		this.root.setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	private move(e: PointerEvent) {
		if (!this.drag) return;
		const d = this.valueAt(e) - this.drag.startPos;
		const s = this.drag.start;
		if (this.drag.mode === 'move') this.src.setVisible(s.lo + d, s.hi + d);
		else if (this.drag.mode === 'lo') this.src.setVisible(Math.min(s.lo + d, s.hi), s.hi, 'hi');
		else this.src.setVisible(s.lo, Math.max(s.hi + d, s.lo), 'lo');
	}

	private up(e: PointerEvent) {
		if (!this.drag) return;
		this.drag = null;
		this.root.classList.remove('dragging');
		if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId);
	}

	/** 每幀呼叫：依模型擺好滑塊，重畫總覽 */
	sync() {
		const ext = this.src.extent(), vis = this.src.visible();
		const len = Math.max(1e-9, ext.hi - ext.lo);
		const f0 = Math.max(0, Math.min(1, (vis.lo - ext.lo) / len));
		const f1 = Math.max(f0, Math.min(1, (vis.hi - ext.lo) / len));
		const st = this.thumb.style;
		if (this.orient === 'h') {
			st.left = `${f0 * 100}%`; st.width = `${(f1 - f0) * 100}%`;
		} else {
			st.bottom = `${f0 * 100}%`; st.height = `${(f1 - f0) * 100}%`;
		}

		if (this.bg && this.drawBackground) {
			const dpr = window.devicePixelRatio || 1;
			const w = this.root.clientWidth, h = this.root.clientHeight;
			if (this.bg.width !== w * dpr || this.bg.height !== h * dpr) {
				this.bg.width = w * dpr; this.bg.height = h * dpr;
			}
			const ctx = this.bg.getContext('2d')!;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);
			this.drawBackground(ctx, w, h, ext);
		}
	}
}
