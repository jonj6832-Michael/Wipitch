export interface ReferenceTrackState {
	name: string | null;
	gainDb: number;
	muted: boolean;
	offsetSec: number;
}

export interface ReferenceTrackEvents {
	load(file: File): void;
	remove(): void;
	toggleMute(): void;
	changeGain(gainDb: number): void;
	changeOffset(offsetSec: number): void;
}

/** 參考音軌控制列的顯示模組；解碼、Player 與波形仍由應用層負責。 */
export class ReferenceTrackControlsView {
	private file: HTMLInputElement;
	private fileText: HTMLElement;
	private name: HTMLElement;
	private controls: HTMLElement;
	private mute: HTMLButtonElement;
	private volume: HTMLInputElement;
	private volumeOutput: HTMLOutputElement;
	private offset: HTMLInputElement;

	constructor(private root: HTMLElement, events: ReferenceTrackEvents) {
		this.file = root.querySelector<HTMLInputElement>('#bg-file')!;
		this.fileText = root.querySelector<HTMLElement>('#bg-file-text')!;
		this.name = root.querySelector<HTMLElement>('#bg-name')!;
		this.controls = root.querySelector<HTMLElement>('#bg-controls')!;
		this.mute = root.querySelector<HTMLButtonElement>('#bg-mute')!;
		this.volume = root.querySelector<HTMLInputElement>('#bg-vol')!;
		this.volumeOutput = root.querySelector<HTMLOutputElement>('#bg-vol-out')!;
		this.offset = root.querySelector<HTMLInputElement>('#bg-offset')!;
		this.file.addEventListener('change', () => {
			const selected = this.file.files?.[0];
			if (selected) events.load(selected);
			this.file.value = '';
		});
		root.querySelector('#bg-remove')!.addEventListener('click', events.remove);
		this.mute.addEventListener('click', events.toggleMute);
		this.volume.addEventListener('input', () => events.changeGain(Number.parseFloat(this.volume.value)));
		this.volume.addEventListener('dblclick', () => events.changeGain(0));
		this.offset.addEventListener('change', () => events.changeOffset((Number.parseFloat(this.offset.value) || 0) / 1000));
		root.querySelectorAll<HTMLElement>('[data-bg-nudge]').forEach(button => button.addEventListener('click', () => {
			const currentMs = Number.parseFloat(this.offset.value) || 0;
			events.changeOffset(Math.round(currentMs + Number.parseFloat(button.dataset.bgNudge!)) / 1000);
		}));
	}

	render(state: Readonly<ReferenceTrackState>) {
		this.name.textContent = state.name ?? '無';
		this.controls.hidden = !state.name; this.name.hidden = !state.name;
		this.fileText.textContent = state.name ? '更換' : '載入參考音軌';
		this.mute.classList.toggle('on', state.muted);
		this.volume.value = String(state.gainDb);
		this.volumeOutput.textContent = `${state.gainDb > 0 ? '+' : ''}${state.gainDb.toFixed(1)} dB`;
		if (document.activeElement !== this.offset) this.offset.value = String(Math.round(state.offsetSec * 1000));
	}

	setDisabled(disabled: boolean) { this.file.disabled = disabled; }
}
