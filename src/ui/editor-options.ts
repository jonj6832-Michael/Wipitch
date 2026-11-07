import type { LaneId } from '../model/curves';

export interface KeyChoice { id: string; label: string; mode: string; }
export interface KeyModeChoice { id: string; label: string; }
export interface EditorOptionsEvents { keyChanged(value: string): void; }
export interface PenOptions { depth: number; rate: number; onsetSec: number; enabled: boolean; onsetEnabled: boolean; }

/** Key 與畫筆選項的顯示模組；實際畫線與曲線修改由畫布控制器決定。 */
export class EditorOptionsView {
	private key: HTMLSelectElement;
	private penRoot: HTMLElement;
	private depth: HTMLInputElement;
	private rate: HTMLInputElement;
	private onset: HTMLInputElement;
	private enabled: HTMLInputElement;
	private onsetEnabled: HTMLInputElement;
	private unit: HTMLElement;

	constructor(root: HTMLElement, events: EditorOptionsEvents) {
		this.key = root.querySelector<HTMLSelectElement>('#key-filter')!;
		this.penRoot = root.querySelector('#pen-opts')!;
		this.depth = root.querySelector<HTMLInputElement>('#vib-depth')!;
		this.rate = root.querySelector<HTMLInputElement>('#vib-rate')!;
		this.onset = root.querySelector<HTMLInputElement>('#vib-onset')!;
		this.enabled = root.querySelector<HTMLInputElement>('#vib-on')!;
		this.onsetEnabled = root.querySelector<HTMLInputElement>('#vib-onset-on')!;
		this.unit = root.querySelector('#vib-unit')!;
		this.key.addEventListener('change', () => events.keyChanged(this.key.value));
		this.enabled.addEventListener('change', () => this.syncPenAvailability());
		this.onsetEnabled.addEventListener('change', () => this.syncPenAvailability());
		this.syncPenAvailability();
	}

	populateKeys(modes: readonly KeyModeChoice[], keys: readonly KeyChoice[]) {
		for (const mode of modes) {
			const group = document.createElement('optgroup'); group.label = mode.label;
			for (const key of keys.filter(item => item.mode === mode.id)) group.appendChild(new Option(key.label, key.id));
			this.key.appendChild(group);
		}
	}
	get keyValue() { return this.key.value; }
	get keyLabel() { return this.key.selectedOptions[0]?.textContent ?? '全部音'; }
	setPenVisible(visible: boolean) { this.penRoot.hidden = !visible; }
	setLaneUnit(id: LaneId, label: string) { this.unit.textContent = label; }
	get pen(): PenOptions {
		return {
			depth: Math.max(0, Number.parseFloat(this.depth.value) || 0),
			rate: Math.max(0.1, Number.parseFloat(this.rate.value) || 5.5),
			onsetSec: this.onsetEnabled.checked ? Math.max(0, Number.parseFloat(this.onset.value) || 0) / 1000 : 0,
			enabled: this.enabled.checked,
			onsetEnabled: this.onsetEnabled.checked,
		};
	}
	toggleVibrato(onset: boolean) {
		const input = onset ? this.onsetEnabled : this.enabled;
		input.checked = !input.checked;
		this.syncPenAvailability();
		return input.checked;
	}
	private syncPenAvailability() {
		this.depth.disabled = this.rate.disabled = !this.enabled.checked;
		this.onsetEnabled.disabled = !this.enabled.checked;
		this.onset.disabled = !this.enabled.checked || !this.onsetEnabled.checked;
	}
}
