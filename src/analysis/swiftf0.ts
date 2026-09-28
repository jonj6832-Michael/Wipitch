// SwiftF0 音高偵測的規格常數與資料型別。
//
// 這些數字直接抄自官方實作（swift_f0/core.py），不要自己改：
// 時間戳的計算方式跟模型內部的 STFT 對齊方式綁在一起，改了會讓
// 音高曲線跟波形對不上——而且不會報錯，只會看起來怪怪的。

export const SR = 16000;
export const HOP = 256;                 // 16ms 一格
export const FRAME = 1024;
/** 第一格的中心落在原始音訊的第幾個 sample。(FRAME-1)/2 - (FRAME-HOP)/2 */
export const CENTER_OFFSET = 127.5;
export const HOP_SEC = HOP / SR;        // 0.016

export const MODEL_FMIN = 46.875;
export const MODEL_FMAX = 2093.75;
export const CONFIDENCE_THRESHOLD = 0.9;

/** 第 i 格對應的時間（秒） */
export function frameTime(i: number): number {
	return (i * HOP + CENTER_OFFSET) / SR;
}

export interface PitchTrack {
	/** 每格的基頻（Hz）。未發聲的格子仍然有值，但 voiced 會是 false */
	f0: Float32Array;
	confidence: Float32Array;
	voiced: Uint8Array;
	/** 格數 */
	length: number;
}

/** Hz → MIDI 音高號碼（連續值，不取整） */
export function hzToMidi(hz: number): number {
	return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
	return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI 號碼 → 音名，例如 60 → "C4" */
export function midiToName(midi: number): string {
	const n = Math.round(midi);
	return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}
