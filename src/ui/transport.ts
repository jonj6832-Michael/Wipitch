export interface TransportEvents {
	playPause(): void;
	stop(): void;
	toggleLoop(): void;
	toggleFollow(): void;
}

/** 播放列的獨立顯示模組；Player、選取範圍與 ViewState 仍由應用層持有。 */
export class TransportView {
	private play: HTMLButtonElement;
	private stop: HTMLButtonElement;
	private loop: HTMLButtonElement;
	private follow: HTMLButtonElement;
	private clock: HTMLElement;

	constructor(root: HTMLElement, events: TransportEvents) {
		this.play = root.querySelector<HTMLButtonElement>('#play')!;
		this.stop = root.querySelector<HTMLButtonElement>('#stop')!;
		this.loop = root.querySelector<HTMLButtonElement>('#loop-btn')!;
		this.follow = root.querySelector<HTMLButtonElement>('#follow-btn')!;
		this.clock = root.querySelector<HTMLElement>('#clock')!;
		this.play.addEventListener('click', events.playPause);
		this.stop.addEventListener('click', events.stop);
		this.loop.addEventListener('click', events.toggleLoop);
		this.follow.addEventListener('click', events.toggleFollow);
	}

	setPlaying(playing: boolean) {
		this.play.textContent = playing ? '‖' : '▶';
		this.play.title = playing ? '暫停（空白鍵）' : '播放（空白鍵）';
	}
	setLoop(active: boolean) { this.loop.classList.toggle('on', active); }
	setFollow(active: boolean) { this.follow.classList.toggle('on', active); }
	setPosition(label: string) { this.clock.textContent = label; }
	setEnabled(enabled: boolean) { this.play.disabled = this.stop.disabled = !enabled; }
}
