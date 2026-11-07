/** 檢測列工具面板；範圍拖曳本身仍由 DetectionBar 負責。 */
export class DetectionControlsView {
	private status: HTMLElement;
	constructor(root: HTMLElement, events: { detectAll(): void; clear(): void }) {
		this.status = root.querySelector('#detection-status')!;
		root.querySelector<HTMLButtonElement>('#detection-all')!.addEventListener('click', events.detectAll);
		root.querySelector<HTMLButtonElement>('#detection-clear')!.addEventListener('click', events.clear);
	}
	setStatus(value: string) { this.status.textContent = value; }
}
