import type { WorkProgress } from '../application/work-state';

/** 純呈現元件：不持有工作、不發出忙碌事件，也不決定操作權限。 */
export class ProgressView {
	private bar: HTMLProgressElement;
	private label: HTMLElement;
	private value: HTMLElement;
	constructor(private root: HTMLElement) {
		this.bar = root.querySelector('progress')!;
		this.label = root.querySelector('#progress-label')!;
		this.value = root.querySelector('.progress-value')!;
	}
	render(state: WorkProgress) {
		this.label.textContent = state.label;
		this.label.title = state.label;
		this.root.classList.toggle('error', state.error);
		this.root.setAttribute('aria-busy', String(state.active));
		if (state.fraction === null) this.bar.removeAttribute('value');
		else this.bar.value = state.fraction;
		this.value.textContent = state.error ? '失敗'
			: state.fraction === null ? '處理中…' : `${Math.round(state.fraction * 100)}%`;
	}
}
