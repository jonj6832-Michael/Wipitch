import type { ViewState } from '../view/viewstate';

export type DetectionRange = { start: number; end: number };

/** 檢測範圍採輸出時間，與編輯選取、循環播放各自獨立。 */
export class DetectionBar {
	range: DetectionRange | null = null;
	private thumb: HTMLElement;
	private drag: { anchor: number; mode: string; initial: DetectionRange | null } | null = null;
	private lastLayout = '';
	constructor(private root: HTMLElement, private view: ViewState, private duration: () => number,
		private changed: (range: DetectionRange | null) => void) {
		root.innerHTML = '<div class="detection-thumb" hidden><button type="button" data-edge="start" aria-label="檢測起點" role="slider"></button><button type="button" data-edge="end" aria-label="檢測終點" role="slider"></button></div>';
		this.thumb = root.firstElementChild as HTMLElement;
		root.addEventListener('pointerdown', e => {
			if (e.button !== 0 || this.duration() <= 0) return;
			e.preventDefault();
			const target = e.target as HTMLElement;
			const mode = target.dataset.edge ?? (target === this.thumb ? 'move' : 'new');
			this.drag = { anchor: this.time(e.clientX), mode, initial: this.range && { ...this.range } };
			root.setPointerCapture(e.pointerId);
			if (mode === 'new') this.set({ start: this.drag.anchor, end: this.drag.anchor });
		});
		root.addEventListener('pointermove', e => {
			if (!this.drag) return;
			const { mode, anchor, initial } = this.drag;
			const t = this.time(e.clientX);
			if (mode === 'new') this.set({ start: Math.min(anchor, t), end: Math.max(anchor, t) });
			else if (initial && mode === 'move') {
				const d = Math.max(-initial.start, Math.min(this.duration() - initial.end, t - anchor));
				this.set({ start: initial.start + d, end: initial.end + d });
			} else if (initial) this.set(mode === 'start'
				? { start: Math.min(t, initial.end), end: initial.end }
				: { start: initial.start, end: Math.max(t, initial.start) });
		});
		root.addEventListener('pointerup', e => {
			this.drag = null;
			if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
		});
		root.addEventListener('pointercancel', () => { if (this.drag) this.set(this.drag.initial); this.drag = null; });
		root.addEventListener('keydown', e => {
			const edge = (e.target as HTMLElement).dataset.edge;
			if (!this.range || !edge || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
			e.preventDefault(); e.stopPropagation();
			const delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
			this.set(edge === 'start'
				? { ...this.range, start: Math.min(this.range.end, this.range.start + delta) }
				: { ...this.range, end: Math.max(this.range.start, this.range.end + delta) });
		});
	}
	private time(clientX: number) {
		return Math.max(0, Math.min(this.duration(), this.view.xToTime(clientX - this.root.getBoundingClientRect().left)));
	}
	set(range: DetectionRange | null) {
		const max = this.duration();
		this.range = range ? { start: Math.max(0, Math.min(max, range.start)), end: Math.max(0, Math.min(max, range.end)) } : null;
		this.changed(this.range);
		this.sync();
	}
	sync() {
		if (this.range && this.range.end > this.duration()) { this.set(this.range); return; }
		const layout = `${this.range?.start}:${this.range?.end}:${this.view.startSec}:${this.view.secPerPx}:${this.duration()}`;
		if (layout === this.lastLayout) return;
		this.lastLayout = layout;
		this.thumb.hidden = !this.range;
		if (!this.range) return;
		this.thumb.style.left = `${this.view.timeToX(this.range.start)}px`;
		this.thumb.style.width = `${Math.max(2, (this.range.end - this.range.start) / this.view.secPerPx)}px`;
		for (const button of this.thumb.querySelectorAll('button')) {
			const t = button.dataset.edge === 'start' ? this.range.start : this.range.end;
			button.setAttribute('aria-valuemin', '0'); button.setAttribute('aria-valuemax', String(this.duration()));
			button.setAttribute('aria-valuenow', String(t)); button.setAttribute('aria-valuetext', `${t.toFixed(2)} 秒`);
		}
	}
}
