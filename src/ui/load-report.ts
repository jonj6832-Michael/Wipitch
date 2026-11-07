/** 載入診斷顯示面板；記錄計算與資料收集保留在應用層。 */
export class LoadReportView {
	private summary: HTMLElement;
	private detail: HTMLElement;
	constructor(private root: HTMLDetailsElement) {
		this.summary = root.querySelector('summary')!;
		this.detail = root.querySelector('pre')!;
	}
	reset() { this.root.hidden = true; this.root.open = false; }
	show(summary: string, detail: string) {
		this.summary.textContent = summary;
		this.detail.textContent = detail;
		this.root.hidden = false;
	}
}
