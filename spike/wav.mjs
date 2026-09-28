// 最小 WAV 讀寫。支援 16/24/32-bit 整數與 32-bit float。
// 會正確跳過 smpl / JUNK / LIST 之類的額外 chunk（DAW 匯出的檔常常有）。
import fs from 'node:fs';

export function readWav(path) {
	const buf = fs.readFileSync(path);
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error('不是 WAV 檔：' + path);
	}

	let fmt = null, dataOffset = -1, dataLength = 0;
	let pos = 12;
	while (pos + 8 <= buf.length) {
		const id = buf.toString('ascii', pos, pos + 4);
		const size = buf.readUInt32LE(pos + 4);
		const body = pos + 8;
		if (id === 'fmt ') {
			fmt = {
				format: buf.readUInt16LE(body),
				channels: buf.readUInt16LE(body + 2),
				sampleRate: buf.readUInt32LE(body + 4),
				bits: buf.readUInt16LE(body + 14),
			};
		} else if (id === 'data') {
			dataOffset = body;
			dataLength = size;
		}
		pos = body + size + (size & 1); // chunk 要對齊到偶數位元組
	}
	if (!fmt || dataOffset < 0) throw new Error('WAV 缺少 fmt 或 data chunk');

	const { channels, bits } = fmt;
	const bytes = bits / 8;
	const frames = Math.floor(dataLength / (bytes * channels));
	const out = [];
	for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));

	const isFloat = fmt.format === 3;
	for (let i = 0; i < frames; i++) {
		for (let c = 0; c < channels; c++) {
			const o = dataOffset + (i * channels + c) * bytes;
			let v;
			if (isFloat) {
				v = buf.readFloatLE(o);
			} else if (bits === 16) {
				v = buf.readInt16LE(o) / 32768;
			} else if (bits === 24) {
				// 24-bit 沒有現成的 read 方法，自己組並做符號延伸
				let raw = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
				if (raw & 0x800000) raw |= ~0xffffff;
				v = raw / 8388608;
			} else if (bits === 32) {
				v = buf.readInt32LE(o) / 2147483648;
			} else {
				throw new Error('不支援的位元深度：' + bits);
			}
			out[c][i] = v;
		}
	}
	return { channels: out, sampleRate: fmt.sampleRate, bits, frames };
}

export function writeWav(path, channels, sampleRate) {
	const nch = channels.length;
	const frames = channels[0].length;
	const dataLength = frames * nch * 2; // 輸出固定 16-bit，試聽夠用
	const buf = Buffer.alloc(44 + dataLength);

	buf.write('RIFF', 0, 'ascii');
	buf.writeUInt32LE(36 + dataLength, 4);
	buf.write('WAVE', 8, 'ascii');
	buf.write('fmt ', 12, 'ascii');
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(nch, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * nch * 2, 28);
	buf.writeUInt16LE(nch * 2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36, 'ascii');
	buf.writeUInt32LE(dataLength, 40);

	let o = 44;
	for (let i = 0; i < frames; i++) {
		for (let c = 0; c < nch; c++) {
			let v = Math.max(-1, Math.min(1, channels[c][i]));
			buf.writeInt16LE(Math.round(v * 32767), o);
			o += 2;
		}
	}
	fs.writeFileSync(path, buf);
}
