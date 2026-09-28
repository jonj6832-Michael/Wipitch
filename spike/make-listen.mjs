// 產生 A/B 試聽檔：把「原始 → Signalsmith → Rubber Band」串成一個檔，
// 中間插入短暫靜音。這樣一次播放就能直接比較，不用切檔案。
import { readWav, writeWav } from './wav.mjs';
import { loadWasm, OfflineStretch } from './stretch-node.mjs';
import { loadRubberBand, rbPitchShift } from './rubberband-node.mjs';

const START = 45, DUR = 5, GAP = 0.5;
const w = readWav('Vocal.wav');
const sr = w.sampleRate;
const x = w.channels[0].subarray(START * sr, (START + DUR) * sr);

const wasm = await loadWasm(sr);
const ss = new OfflineStretch(wasm, sr, 1);
const rbApi = await loadRubberBand();

function join(parts) {
	const gap = Math.round(GAP * sr);
	const total = parts.reduce((s, p) => s + p.length, 0) + gap * (parts.length - 1);
	const out = new Float32Array(total);
	let o = 0;
	parts.forEach((p, i) => { out.set(p, o); o += p.length + (i < parts.length - 1 ? gap : 0); });
	return out;
}

for (const k of [-7, -5, -2, 2, 5, 7]) {
	ss.wasm._reset();
	const sig = ss.render([x], () => ({ semitones: k, formantCompensation: true, formantBaseHz: 0 }), 1024)[0];
	const rub = rbPitchShift(rbApi, [x], sr, k, true)[0];
	const name = `spike/out/listen_${k >= 0 ? '+' : ''}${k}.wav`;
	writeWav(name, [join([x, Float32Array.from(sig), Float32Array.from(rub)])], sr);
	console.log(`${name}  （順序：原始 → Signalsmith → RubberBand，各 ${DUR} 秒）`);
}
