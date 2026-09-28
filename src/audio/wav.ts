// 匯出 WAV。用 24-bit 整數，跟常見的 DAW 匯出格式一致，
// 而且比 16-bit 多出的動態範圍對修過音的素材是有意義的。
import type { Samples } from '../types';

export function encodeWav24(channels: Samples[], sampleRate: number): Blob {
	const nch = channels.length;
	const frames = channels[0].length;
	const dataBytes = frames * nch * 3;
	const buf = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buf);

	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};

	ascii(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);              // PCM
	view.setUint16(22, nch, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * nch * 3, true);
	view.setUint16(32, nch * 3, true);
	view.setUint16(34, 24, true);
	ascii(36, 'data');
	view.setUint32(40, dataBytes, true);

	let o = 44;
	for (let i = 0; i < frames; i++) {
		for (let c = 0; c < nch; c++) {
			let v = channels[c][i];
			v = v > 1 ? 1 : v < -1 ? -1 : v;
			const s = Math.round(v * 8388607);
			view.setUint8(o, s & 0xff);
			view.setUint8(o + 1, (s >> 8) & 0xff);
			view.setUint8(o + 2, (s >> 16) & 0xff);
			o += 3;
		}
	}
	return new Blob([buf], { type: 'audio/wav' });
}

export function downloadBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
