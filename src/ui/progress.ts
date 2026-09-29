/** 顯示目前工作；前景操作優先於背景精算，各工作的回報互不覆蓋。 */
export class ProgressView {
	onBusyChange?: (busy: boolean) => void;
	get isBusy() { return this.tasks.size > 0; }
	private nextId = 0;
	private tasks = new Map<number, { label: string; fraction: number | null; priority: number }>();
	private result = { label: '等待載入音檔', fraction: 0, error: false };
	private bar: HTMLProgressElement;
	private label: HTMLElement;
	private value: HTMLElement;

	constructor(private root: HTMLElement) {
		this.bar = root.querySelector('progress')!;
		this.label = root.querySelector('#progress-label')!;
		this.value = root.querySelector('.progress-value')!;
	}

	begin(label: string, priority = 1) {
		const id = ++this.nextId;
		this.tasks.set(id, { label, fraction: null, priority });
		this.draw();
		return {
			update: (label: string, fraction: number | null = null) => {
				const task = this.tasks.get(id);
				if (!task) return;
				task.label = label;
				task.fraction = fraction === null || !Number.isFinite(fraction) ? null : Math.max(0, Math.min(1, fraction));
				this.draw();
			},
			finish: (label: string, error = false) => {
				if (!this.tasks.delete(id)) return;
				this.result = { label, fraction: error ? 0 : 1, error };
				this.draw();
			},
		};
	}

	private draw() {
		const active = [...this.tasks.entries()].sort((a, b) => b[1].priority - a[1].priority || b[0] - a[0])[0]?.[1];
		const state = active ?? this.result;
		this.label.textContent = state.label;
		this.label.title = state.label;
		this.root.classList.toggle('error', !active && this.result.error);
		this.root.setAttribute('aria-busy', String(!!active));
		if (state.fraction === null) this.bar.removeAttribute('value');
		else this.bar.value = state.fraction;
		this.value.textContent = !active && this.result.error ? '失敗'
			: state.fraction === null ? '處理中…' : `${Math.round(state.fraction * 100)}%`;
		this.onBusyChange?.(this.isBusy);
	}
}

export type ProgressTask = ReturnType<ProgressView['begin']>;
