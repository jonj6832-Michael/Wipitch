export type GuideStepId =
	| 'main-audio' | 'reference-audio' | 'range' | 'key' | 'anchor'
	| 'meter' | 'bpm' | 'beats' | 'ai' | 'review' | 'complete' | 'next-range';

export interface GuideStep {
	id: GuideStepId;
	title: string;
	description: string;
	actionLabel?: string;
	action?: () => unknown | Promise<unknown>;
	optional?: boolean;
	ready: () => boolean;
}

export interface GuideModeOptions {
	hasMainAudio: () => boolean;
	hasReferenceAudio: () => boolean;
	openMainAudio: () => void;
	openReferenceAudio: () => void;
	startReferenceAnalysis: () => Promise<boolean>;
	startAI: () => Promise<'completed'|'unchanged'|'cancelled'|'failed'|'busy'|'invalid'>;
	completeAI: () => Promise<boolean>;
	getRange: () => { start: number; end: number } | null;
	hasKey: () => boolean;
	hasAnchor: () => boolean;
	hasBeats: () => boolean;
	hasAIRegions: () => boolean;
	hasAIReview: () => boolean;
	hasCompletedAI: () => boolean;
	resetRange: () => void;
}

/**
 * 工作流程引導只負責流程狀態與提示；實際的音訊、分析與編輯仍由 main.ts 持有。
 */
export class GuideModeView {
	private dialog: HTMLDialogElement;
	private title: HTMLElement;
	private description: HTMLElement;
	private progress: HTMLElement;
	private steps: HTMLElement;
	private actionButton: HTMLButtonElement;
	private nextButton: HTMLButtonElement;
	private skipButton: HTMLButtonElement;
	private finishButton: HTMLButtonElement;
	private closeButton: HTMLButtonElement;
	private current = 0;
	private aiRunCompleted = false;
	private reviewCommitted = false;
	private pollId: number | null = null;
	private running = false;
	private stepsForRun: GuideStep[] = [];

	constructor(private root: HTMLElement, private options: GuideModeOptions) {
		this.dialog = root as HTMLDialogElement;
		this.title = root.querySelector('#guide-title')!;
		this.description = root.querySelector('#guide-description')!;
		this.progress = root.querySelector('#guide-progress')!;
		this.steps = root.querySelector('#guide-steps')!;
		this.actionButton = root.querySelector<HTMLButtonElement>('#guide-action')!;
		this.nextButton = root.querySelector<HTMLButtonElement>('#guide-next')!;
		this.skipButton = root.querySelector<HTMLButtonElement>('#guide-skip')!;
		this.finishButton = root.querySelector<HTMLButtonElement>('#guide-finish')!;
		this.closeButton = root.querySelector<HTMLButtonElement>('#guide-close')!;

		this.actionButton.addEventListener('click', () => { void this.runAction(); });
		this.nextButton.addEventListener('click', () => this.next());
		this.skipButton.addEventListener('click', () => this.skipOptional());
		this.finishButton.addEventListener('click', () => this.close());
		this.closeButton.addEventListener('click', () => this.close());
		this.dialog.addEventListener('cancel', () => this.stopPolling());
	}

	open() {
		if (this.running) return;
		this.running = true;
		this.current = 0;
		this.aiRunCompleted = false;
		this.reviewCommitted = false;
		this.stepsForRun = this.createSteps();
		this.render();
		this.dialog.showModal();
		this.startPolling();
	}

	private createSteps(): GuideStep[] {
		const referenceReady = () => this.options.hasReferenceAudio();
		return [
			{ id: 'main-audio', title: '導入主音軌', description: '先載入要修音的主音軌。載入完成後按「下一步」。', actionLabel: '選擇主音軌', action: this.options.openMainAudio, ready: this.options.hasMainAudio },
			{ id: 'reference-audio', title: '導入參考音軌', description: '可載入伴奏、導唱或節奏參考。若不需要參考音軌，可略過此步驟，後面的參考音軌設定也會一併略過。', actionLabel: '選擇參考音軌', action: this.options.openReferenceAudio, optional: true, ready: referenceReady },
			{ id: 'range', title: '設定偵測範圍', description: '在編輯區的「檢測」列拖曳選取這一次要處理的範圍。每個新範圍都從這一步重新開始。', ready: () => { const range = this.options.getRange(); return !!range && range.end > range.start; } },
			{ id: 'key', title: '設定 Key', description: '在上方 Key 選單選擇這個範圍的目標調性。', ready: this.options.hasKey },
			{ id: 'anchor', title: '設定參考音軌第一拍', description: '播放或點擊波形把播放紅線放到第一拍，再按參考音軌列的「⚓ 錨定」。', optional: true, ready: () => !referenceReady() || this.options.hasAnchor() },
			{ id: 'meter', title: '設定拍號', description: '在參考音軌列選擇這個範圍使用的拍號。', optional: true, ready: () => !referenceReady() || !!document.querySelector<HTMLSelectElement>('#tempo-meter')?.value },
			{ id: 'bpm', title: '設定 BPM', description: '在參考音軌列輸入預估 BPM，之後分析會以此作為起始值。', optional: true, ready: () => !referenceReady() || Number(document.querySelector<HTMLInputElement>('#tempo-bpm')?.value) > 0 },
			{ id: 'beats', title: '抓取拍點', description: '按下「分析節拍與和弦」，等待目前範圍完成分析。', actionLabel: '分析節拍與和弦', action: async () => { await this.options.startReferenceAnalysis(); }, optional: true, ready: () => !referenceReady() || this.options.hasBeats() },
			{ id: 'ai', title: 'AI 檢測', description: '確認 Key 與範圍後，執行 AI 檢測。', actionLabel: '執行 AI 檢測', action: () => this.options.startAI(), ready: () => this.aiRunCompleted || this.options.hasAIRegions() },
			{ id: 'review', title: '檢視 AI 調整內容', description: '查看黃色 AI 區域；需要時可直接拖曳調整。確認內容後進入下一步。', ready: () => this.options.hasAIRegions() || this.aiRunCompleted },
			{ id: 'complete', title: '完成工作', description: '按「完成工作」保存本次 AI 審核結果，結束這一個範圍。', actionLabel: '完成工作', action: () => this.options.completeAI(), ready: () => this.reviewCommitted },
			{ id: 'next-range', title: '是否處理下一個範圍？', description: '這個範圍已完成。若還有其他段落，選擇下一個範圍並重新從「設定偵測範圍」開始。', ready: () => true },
		];
	}

	private render() {
		const step = this.stepsForRun[this.current];
		if (!step) return;
		this.title.textContent = step.title;
		this.description.textContent = step.description;
		this.progress.textContent = `步驟 ${this.current + 1} / ${this.stepsForRun.length}`;
		this.actionButton.hidden = !step.action;
		this.actionButton.textContent = step.actionLabel ?? '執行';
		this.actionButton.disabled = !step.action;
		this.skipButton.hidden = !step.optional;
		this.finishButton.hidden = step.id !== 'next-range';
		this.nextButton.hidden = step.id === 'next-range';
		this.nextButton.disabled = !step.ready();
		this.nextButton.textContent = step.id === 'complete' ? '確認完成' : '下一步';
		if (step.id === 'next-range') {
			this.actionButton.hidden = false;
			this.actionButton.textContent = '處理下一個範圍';
			this.actionButton.disabled = false;
		}
		this.steps.replaceChildren(...this.stepsForRun.map((item, index) => {
			const node = document.createElement('li');
			node.textContent = item.title;
			node.className = index < this.current ? 'done' : index === this.current ? 'current' : '';
			return node;
		}));
	}

	private async runAction() {
		const step = this.stepsForRun[this.current];
		if (step.id === 'next-range') {
			this.options.resetRange();
			this.current = 2;
				this.aiRunCompleted = false;
				this.reviewCommitted = false;
			this.render();
			return;
		}
		if (!step.action) return;
		this.actionButton.disabled = true;
		try {
			const result=await step.action();
			if (step.id === 'ai') {
				this.aiRunCompleted = result==='completed'||result==='unchanged';
				this.reviewCommitted = result==='unchanged';
			}
			if (step.id === 'complete') this.reviewCommitted = result===true&&this.options.hasCompletedAI();
		} finally {
			this.render();
		}
	}

	private next() {
		if (!this.stepsForRun[this.current]?.ready()) return;
		if (this.stepsForRun[this.current].id === 'next-range') return;
		this.current++;
		this.skipReferenceStepsIfNeeded();
		this.render();
	}

	private skipOptional() {
		const step = this.stepsForRun[this.current];
		if (!step.optional) return;
		this.current++;
		this.skipReferenceStepsIfNeeded();
		this.render();
	}

	private skipReferenceStepsIfNeeded() {
		if (this.options.hasReferenceAudio()) return;
		const referenceSteps = new Set<GuideStepId>(['anchor', 'meter', 'bpm', 'beats']);
		while (referenceSteps.has(this.stepsForRun[this.current]?.id)) this.current++;
	}

	private startPolling() {
		this.stopPolling();
		this.pollId = window.setInterval(() => {
			if (!this.running) return;
			const step = this.stepsForRun[this.current];
			if (!step) return;
			this.nextButton.disabled = !step.ready();
			if (step.id === 'ai') this.actionButton.disabled = false;
		}, 250);
	}

	private stopPolling() {
		if (this.pollId !== null) window.clearInterval(this.pollId);
		this.pollId = null;
	}

	close() {
		this.running = false;
		this.stopPolling();
		if (this.dialog.open) this.dialog.close();
	}
}
