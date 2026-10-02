import { Context, Frequency, Sampler, setContext } from 'tone';
import type { PreviewInstrument } from './note-preview';

/** 與 Tone.js 官方 Sampler 範例相同的 Salamander 30 個取樣。 */
export function loadPiano(audioContext: AudioContext): Promise<PreviewInstrument> {
	const context = new Context({ context: audioContext, lookAhead: 0 });
	setContext(context);
	const urls: Record<string, string> = { A0: 'A0.mp3', C8: 'C8.mp3' };
	for (let octave = 1; octave <= 7; octave++) {
		for (const [note, file] of [['C', 'C'], ['D#', 'Ds'], ['F#', 'Fs'], ['A', 'A']]) {
			urls[`${note}${octave}`] = `${file}${octave}.mp3`;
		}
	}
	return new Promise((resolve, reject) => {
		let sampler: Sampler | undefined;
		let settled = false;
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			sampler?.dispose();
			context.dispose();
			reject(error);
		};
		const timeout = setTimeout(() => fail(new Error('鋼琴音色載入逾時，請再按琴鍵重試。')), 30_000);
		try {
			sampler = new Sampler({
				context, urls, baseUrl: `${import.meta.env.BASE_URL}audio/salamander/`,
				attack: 0, release: 0.25, volume: -9,
				onload: () => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					const piano = sampler!;
					// Tone 的數字音高代表 Hz，因此先明確由 MIDI 轉換。
					resolve({
						attack: midi => piano.triggerAttack(Frequency(midi, 'midi').toFrequency(), context.immediate(), 0.8),
						release: midi => piano.triggerRelease(Frequency(midi, 'midi').toFrequency(), context.immediate()),
					});
				},
				onerror: () => fail(new Error('無法載入鋼琴音色，請確認音色檔案可讀取後再試。')),
			}).toDestination();
		} catch (error) { fail(error); }
	});
}
