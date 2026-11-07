/**
 * 頂端工作列的顯示模組。
 *
 * 此模組只轉送使用者意圖及呈現狀態；音檔讀取、專案序列化、播放器與算繪仍由
 * 應用層處理，避免面板直接依賴音訊引擎。
 */
export interface HeaderPanelEvents {
	selectAudio(file: File): void;
	openAudio(): void;
	exportWav(): void;
	saveProject(): void;
	openProject(file: File): void;
	setFormantFollow(follow: 0 | 1): void;
}

export class HeaderPanelView {
	private file: HTMLInputElement;
	private openAudio: HTMLButtonElement;
	private exportButton: HTMLButtonElement;
	private saveButton: HTMLButtonElement;
	private project: HTMLInputElement;
	private voice: HTMLButtonElement;
	private instrument: HTMLButtonElement;
	private status: HTMLElement;
	private hint: HTMLElement;
	private background: HTMLElement;
	private backgroundText: HTMLElement;

	constructor(private root: HTMLElement, events: HeaderPanelEvents) {
		this.file = root.querySelector<HTMLInputElement>('#file')!;
		this.openAudio = root.querySelector<HTMLButtonElement>('#open-audio')!;
		this.exportButton = root.querySelector<HTMLButtonElement>('#export')!;
		this.saveButton = root.querySelector<HTMLButtonElement>('#save')!;
		this.project = root.querySelector<HTMLInputElement>('#open-project')!;
		this.voice = root.querySelector<HTMLButtonElement>('#mode-voice')!;
		this.instrument = root.querySelector<HTMLButtonElement>('#mode-instrument')!;
		this.status = root.querySelector('#status')!;
		this.hint = root.querySelector('#hint')!;
		this.background = root.querySelector('#bg-status')!;
		this.backgroundText = root.querySelector('#bg-text')!;
		this.file.addEventListener('change', () => {
			const selected = this.file.files?.[0];
			if (selected) events.selectAudio(selected);
			this.file.value = '';
		});
		this.openAudio.addEventListener('click', events.openAudio);
		this.exportButton.addEventListener('click', events.exportWav);
		this.saveButton.addEventListener('click', events.saveProject);
		this.project.addEventListener('change', () => {
			const selected = this.project.files?.[0];
			if (selected) events.openProject(selected);
			this.project.value = '';
		});
		this.voice.addEventListener('click', () => events.setFormantFollow(0));
		this.instrument.addEventListener('click', () => events.setFormantFollow(1));
	}

	setBuildVersion(value: string) { this.root.querySelector('#build-version')!.textContent = value; }
	setStatus(value: string) { this.status.textContent = value; }
	setHint(value: string) { this.hint.textContent = value; }
	setFormantFollow(follow: 0 | 1) {
		this.voice.classList.toggle('on', follow === 0);
		this.instrument.classList.toggle('on', follow === 1);
	}
	setBackgroundProgress(label: string | null) {
		this.background.hidden = label === null;
		this.backgroundText.textContent = label ?? '背景精算（等待中）';
	}
	setActions(state: { canOpenAudio: boolean; canOpenProject: boolean; canExport: boolean; canSave: boolean }) {
		this.openAudio.disabled = !state.canOpenAudio;
		this.file.disabled = !state.canOpenAudio;
		this.project.disabled = !state.canOpenProject;
		this.exportButton.disabled = !state.canExport;
		this.saveButton.disabled = !state.canSave;
	}
	setInert(inert: boolean) { this.root.inert = inert; }
}
