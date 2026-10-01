import { midiToHz } from '../analysis/swiftf0';

/** 輕量合成試聽音，MIDI 音號轉頻率；不寫入音檔或算繪緩衝區。 */
export class NotePreview {
	private context: AudioContext | null = null;
	private stopCurrent: (() => void) | null = null;
	constructor(private createContext = () => new AudioContext()) {}
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
			void ctx.resume().then(() => {
				if (cancelled) return;
				const oscillator = ctx.createOscillator();
				const gain = ctx.createGain();
				oscillator.type = 'triangle';
				oscillator.frequency.setValueAtTime(midiToHz(midi), ctx.currentTime);
				gain.gain.setValueAtTime(0, ctx.currentTime);
				gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.015);
				oscillator.connect(gain); gain.connect(ctx.destination);
				oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
				release = () => {
					gain.gain.cancelAndHoldAtTime(ctx.currentTime);
					gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.04);
					oscillator.stop(ctx.currentTime + 0.05);
				};
				oscillator.start();
			}).catch(error => { if (!cancelled) { stop(); onError(error); } });
		} catch (error) { stop(); onError(error); }
		return stop;
	}
}
