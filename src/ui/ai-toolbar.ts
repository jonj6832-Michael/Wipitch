/** AI 修正列的獨立顯示模組。所有修音判斷與工作鎖仍由應用層持有。 */
export interface AIToolbarEvents {
	openSettings(): void;
	changeStrength(level: number): void;
	correct(): void;
	discard(): void;
	complete(): void;
	cancel(): void;
}

export class AIToolbarView {
	private settings: HTMLButtonElement;
	private strength: HTMLInputElement;
	private strengthValue: HTMLOutputElement;
	private correct: HTMLButtonElement;
	private discard: HTMLButtonElement;
	private complete: HTMLButtonElement;
	private cancel: HTMLButtonElement;
	private service: HTMLElement;
	private status: HTMLElement;

	constructor(private root: HTMLElement, events: AIToolbarEvents) {
		this.settings = root.querySelector<HTMLButtonElement>('#ai-settings-open')!;
		this.strength = root.querySelector<HTMLInputElement>('#ai-strength')!;
		this.strengthValue = root.querySelector<HTMLOutputElement>('#ai-strength-value')!;
		this.correct = root.querySelector<HTMLButtonElement>('#ai-correct')!;
		this.discard = root.querySelector<HTMLButtonElement>('#ai-undo')!;
		this.complete = root.querySelector<HTMLButtonElement>('#ai-clear-marks')!;
		this.cancel = root.querySelector<HTMLButtonElement>('#ai-cancel')!;
		this.service = root.querySelector('#ai-service')!;
		this.status = root.querySelector('#ai-status')!;
		this.settings.addEventListener('click', events.openSettings);
		this.strength.addEventListener('input', () => events.changeStrength(Number(this.strength.value)));
		this.correct.addEventListener('click', events.correct);
		this.discard.addEventListener('click', events.discard);
		this.complete.addEventListener('click', events.complete);
		this.cancel.addEventListener('click', events.cancel);
	}

	get level() { return Number(this.strength.value); }
	setService(value: string) { this.service.textContent = value; }
	setStatus(value: string) { this.status.textContent = value; }
	setStrengthDisplay(value: { text: string; title: string; ariaValueText: string }) {
		this.strengthValue.textContent = value.text;
		this.strength.title = value.title;
		this.strength.setAttribute('aria-valuetext', value.ariaValueText);
	}
	setControls(state: { disabled: boolean; correct: boolean; correctTitle: string; discard: boolean; discardTitle: string; complete: boolean }) {
		this.settings.disabled = this.strength.disabled = state.disabled;
		this.correct.disabled = state.correct; this.correct.title = state.correctTitle;
		this.discard.disabled = state.discard; this.discard.title = state.discardTitle;
		this.complete.disabled = state.complete;
	}
	setBusy(busy: boolean) {
		this.correct.setAttribute('aria-busy', String(busy));
		this.cancel.hidden = !busy;
		if (!busy) this.cancel.disabled = true;
	}
	setCancelDisabled(disabled: boolean) { this.cancel.disabled = disabled; }
}
