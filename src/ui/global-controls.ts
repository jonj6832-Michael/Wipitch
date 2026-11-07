import type { LaneId } from '../model/curves';

export interface GlobalControlsEvents {
	changeSlope(value: number): void;
	changeRamp(value: number): void;
	reset(lane: LaneId | 'all'): void;
	clearSelection(): void;
}

/** 底部全域編輯面板；不直接讀寫 Curves。 */
export class GlobalControlsView {
	private ramp: HTMLInputElement;
	private slope: HTMLInputElement;
	private clear: HTMLButtonElement;

	constructor(private root: HTMLElement, events: GlobalControlsEvents) {
		this.ramp = root.querySelector<HTMLInputElement>('#ramp')!;
		this.slope = root.querySelector<HTMLInputElement>('#slope')!;
		this.clear = root.querySelector<HTMLButtonElement>('#clear-sel')!;
		this.slope.addEventListener('change', () => events.changeSlope(Number.parseFloat(this.slope.value)));
		this.ramp.addEventListener('change', () => events.changeRamp(Number.parseFloat(this.ramp.value)));
		root.querySelectorAll<HTMLElement>('[data-reset]').forEach(button => button.addEventListener('click', () => events.reset(button.dataset.reset as LaneId | 'all')));
		this.clear.addEventListener('click', events.clearSelection);
	}

	setRampMilliseconds(value: number) { this.ramp.value = String(value); }
	setSlope(value: number) { this.slope.value = String(value); }
	setSelectionActive(active: boolean) {
		this.root.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach(button => { button.disabled = !active; });
		this.clear.disabled = !active;
	}
	setInert(inert: boolean) { this.root.inert = inert; }
}
