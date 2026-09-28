// 在 Node 裡直接驅動 Signalsmith Stretch 的 WASM，繞過 AudioWorklet。
//
// 為什麼要這樣做：npm 套件對外只給一個 AudioWorkletNode 工廠函式，那是為了
// 即時播放設計的。但我們要的是「離線、精確、可逐 block 改音高」的算繪。
// 好消息是底層 WASM 已經把需要的東西都匯出了（_process / _seek / _flush /
// _setTransposeSemitones / _setFormantSemitones / _setFormantBase），
// 只是被 worklet 那層包起來而已。
//
// 所以這裡的手法是：把 worklet 的全域環境「墊」出來，讓模組以為自己在 worklet
// 裡面，藉此攔截到它註冊的 processor class，再從 class 實體上把 wasmModule 撈出來。
// 同樣的手法在瀏覽器的 Web Worker 裡也能用。

export async function loadWasm(sampleRate) {
	let captured = null;

	// --- worklet 環境墊片 ---
	globalThis.sampleRate = sampleRate;
	globalThis.currentTime = 0;
	globalThis.AudioWorkletProcessor = class { constructor() { this.port = fakePort(); } };
	globalThis.registerProcessor = (name, cls) => { captured = cls; };

	// 每次 import 都要是新的，否則第二次呼叫拿不到 registerProcessor 的回呼
	await import('../node_modules/signalsmith-stretch/SignalsmithStretch.mjs?t=' + Math.random());

	if (!captured) throw new Error('沒攔截到 worklet processor class，套件結構可能變了');

	const proc = new captured({ numberOfOutputs: 0 });

	// 等 WASM 載入完成（建構式裡是 Module().then(...)）
	for (let i = 0; i < 2000 && !proc.wasmReady; i++) {
		await new Promise(r => setTimeout(r, 1));
	}
	if (!proc.wasmReady) throw new Error('WASM 載入逾時');

	return proc.wasmModule;
}

function fakePort() {
	// 真的要是可讀寫的屬性：模組載入完會做 pendingMessages.forEach(this.port.onmessage)
	return { postMessage() {}, onmessage: () => {} };
}

/**
 * 離線算繪器。
 *
 * @param wasm         loadWasm() 回傳的模組
 * @param sampleRate   取樣率
 * @param channels     聲道數
 */
export class OfflineStretch {
	constructor(wasm, sampleRate, channels) {
		this.wasm = wasm;
		this.sampleRate = sampleRate;
		this.channels = channels;

		wasm._presetDefault(channels, sampleRate);
		wasm._reset();

		this.inputLatency = wasm._inputLatency();
		this.outputLatency = wasm._outputLatency();
		this.latency = this.inputLatency + this.outputLatency;

		// buffer 要夠長，至少容得下我們一次送進去的 block
		this.bufferLength = Math.max(this.latency, 4096);
		const ptr = wasm._setBuffers(channels, this.bufferLength);
		const bytes = this.bufferLength * 4;

		this.inPtr = [];
		this.outPtr = [];
		for (let c = 0; c < channels; c++) {
			this.inPtr.push(ptr + bytes * c);
			this.outPtr.push(ptr + bytes * (c + channels));
		}
	}

	// WASM 的 heap 可能因為成長而換掉 ArrayBuffer，每次都要重新取
	_heap() {
		return this.wasm.exports ? this.wasm.exports.memory.buffer : this.wasm.HEAP8.buffer;
	}

	/**
	 * 逐 block 算繪整段音訊。
	 *
	 * @param input     Float32Array[]，一個聲道一個
	 * @param settings  (timeSec) => {semitones, formantSemitones, formantCompensation, formantBaseHz}
	 *                  每個 block 呼叫一次，這就是「時變音高曲線」的餵入點
	 * @param blockSize 每次處理幾個 sample
	 * @returns Float32Array[]，與輸入等長且時間對齊
	 */
	render(input, settings, blockSize = 1024) {
		const n = input[0].length;
		const wasm = this.wasm;
		const sr = this.sampleRate;

		// 尾巴補上 latency 長度的靜音，好把管線裡剩下的東西沖出來
		const totalIn = n + this.latency;
		const out = [];
		for (let c = 0; c < this.channels; c++) out.push(new Float32Array(totalIn));

		let pos = 0;
		while (pos < totalIn) {
			const count = Math.min(blockSize, totalIn - pos);

			const s = settings(pos / sr);
			wasm._setTransposeSemitones(s.semitones ?? 0, (s.tonalityHz ?? 8000) / sr);
			wasm._setFormantSemitones(s.formantSemitones ?? 0, s.formantCompensation ? 1 : 0);
			wasm._setFormantBase((s.formantBaseHz ?? 0) / sr);

			const heap = this._heap();
			for (let c = 0; c < this.channels; c++) {
				const dst = new Float32Array(heap, this.inPtr[c], count);
				const src = input[c % input.length];
				if (pos < n) {
					const avail = Math.min(count, n - pos);
					dst.set(src.subarray(pos, pos + avail));
					if (avail < count) dst.fill(0, avail);
				} else {
					dst.fill(0);
				}
			}

			wasm._process(count, count);

			const heap2 = this._heap();
			for (let c = 0; c < this.channels; c++) {
				out[c].set(new Float32Array(heap2, this.outPtr[c], count), pos);
			}
			pos += count;
		}

		// 丟掉開頭的 latency，讓輸出跟輸入逐 sample 對齊
		return out.map(b => b.subarray(this.latency, this.latency + n));
	}
}
