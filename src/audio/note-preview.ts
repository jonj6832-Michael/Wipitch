export interface PreviewInstrument {
	attack(midi: number): void;
	release(midi: number): void;
}

const loadPiano = (context: AudioContext) => import('./tone-piano').then(module => module.loadPiano(context));

/** Tone.js 取樣鋼琴；不寫入音檔或算繪緩衝區。 */
export class NotePreview {
	private context: AudioContext | null = null;
	private instrument: Promise<PreviewInstrument> | null = null;
	private stopCurrent: (() => void) | null = null;
	constructor(
		private createContext = () => new AudioContext({ latencyHint: 'interactive' }),
		private loadInstrument = loadPiano,
		private onLoading: (loading: boolean) => void = () => {},
	) {}
	/** 游標進入琴鍵時預載；失敗後下一次操作可重試。 */
	async prepare(): Promise<PreviewInstrument> {
		if (!this.instrument) {
			const ctx = this.context ??= this.createContext();
			this.onLoading(true);
			this.instrument = Promise.resolve().then(() => this.loadInstrument(ctx)).catch(error => {
				this.instrument = null;
				this.context = null;
				void ctx.close().catch(() => {});
				throw error;
			}).finally(() => this.onLoading(false));
		}
		return this.instrument;
	}
	start(midi: number, onError: (error: unknown) => void): () => void {
		this.stopCurrent?.();
		if (!Number.isInteger(midi) || midi < 0 || midi > 127) return () => {};
		let cancelled = false;
		let release: (() => void) | null = null;
		const stop = () => {
			if (cancelled) return;
			cancelled = true;
			release?.();
			if (this.stopCurrent === stop) this.stopCurrent = null;
		};
		this.stopCurrent = stop;
		try {
			const ctx = this.context ??= this.createContext();
			// 在使用者按下琴鍵的事件內 resume，符合瀏覽器的音訊啟動要求。
			void Promise.all([ctx.resume(), this.prepare()]).then(([, piano]) => {
				if (cancelled) return;
				piano.attack(midi);
				release = () => piano.release(midi);
			}).catch(error => { if (!cancelled) { stop(); onError(error); } });
		} catch (error) { stop(); onError(error); }
		return stop;
	}
}
