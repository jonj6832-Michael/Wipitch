// 播放器。
//
// 播的永遠是「已經算繪好的快取 buffer」，不是即時處理鏈——
// 這樣拖曳編輯的時候不會卡到音訊執行緒，而且拖到哪就聽到哪。
//
// 另外可以掛一條背景參考音軌（伴奏、導唱），只用來監聽對不對得準：
// 跟主唱共用同一個 AudioContext 時鐘，照輸出時間軸原樣播放（不跟著錨點伸縮），
// 可以調音量與時間 offset。匯出不會包含它。

import type { Samples } from '../types';

export class Player {
	private ctx: AudioContext;
	private buffer: AudioBuffer | null = null;
	private node: AudioBufferSourceNode | null = null;
	/** 開始播放當下的 AudioContext 時間，用來反推播放頭位置 */
	private startedAt = 0;
	/** 開始播放時是從音檔的第幾秒開始 */
	private startOffset = 0;
	private playing = false;
	/** 循環播放的區間。null = 不循環 */
	private loop: { start: number; end: number } | null = null;

	// ── 背景參考音軌 ──
	private bgBuffer: AudioBuffer | null = null;
	private bgNode: AudioBufferSourceNode | null = null;
	private bgGain: GainNode;
	private bgLinear = 1;
	/** 背景相對主唱的時間位移（秒）。正數 = 背景晚開始 */
	private bgOffset = 0;
	/** 上一幀的播放位置，用來偵測循環繞回 */
	private lastPos = 0;

	onEnded: (() => void) | null = null;

	constructor() {
		this.ctx = new AudioContext();
		this.bgGain = this.ctx.createGain();
		this.bgGain.connect(this.ctx.destination);
	}

	get sampleRate() { return this.ctx.sampleRate; }
	get isPlaying() { return this.playing; }
	get loopRegion() { return this.loop; }
	get backgroundDuration() { return this.bgBuffer?.duration ?? 0; }
	get backgroundGain() { return this.bgLinear; }
	/** 測試用：背景目前有沒有排好的 node（播放中而且背景還沒結束時應該要有） */
	get backgroundNodeActive() { return !!this.bgNode; }

	/**
	 * 設定循環區間。傳 null 取消。
	 *
	 * 播放中改的話要重開 node——loopStart/loopEnd 在已經開始播的 node 上
	 * 改了雖然會生效，但如果播放頭已經在區間外就永遠回不來，不如重來一次乾淨。
	 */
	setLoop(region: { start: number; end: number } | null) {
		this.loop = region && region.end - region.start > 0.01 ? region : null;
		if (this.playing) {
			const at = this.position;
			const from = this.loop && (at < this.loop.start || at > this.loop.end) ? this.loop.start : at;
			this.stopNode();
			this.play(from);
		}
	}

	/** 換掉要播的音訊。播放中換的話會無縫接續在同一個時間位置。 */
	setAudio(channels: Samples[], sampleRate: number) {
		this.buffer = this.toBuffer(channels, sampleRate);
		if (this.playing) {
			const at = this.position;
			this.stopNode();
			this.play(at);
		}
	}

	/** 換上背景參考音軌（null = 移除）。取樣率不同也沒關係，AudioContext 會自己重取樣。 */
	setBackground(channels: Samples[] | null, sampleRate = 48000) {
		this.stopBackground();
		this.bgBuffer = channels ? this.toBuffer(channels, sampleRate) : null;
		if (this.playing) this.startBackground(this.position);
	}

	/** 背景音量（線性倍率，0 = 靜音）。用很短的斜坡，免得切換時喀一聲 */
	setBackgroundGain(linear: number) {
		this.bgLinear = linear;
		this.bgGain.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.01);
	}

	/** 背景的時間 offset（秒）。播放中改的話只重排背景，主唱不動 */
	setBackgroundOffset(sec: number) {
		this.bgOffset = sec;
		if (this.playing) this.startBackground(this.position);
	}

	/** 目前播放頭位置（秒）。停止時停在最後一次的位置。 */
	get position(): number {
		if (!this.playing) return this.startOffset;
		const t = this.startOffset + (this.ctx.currentTime - this.startedAt);
		// 循環時要自己把時間繞回來——AudioBufferSourceNode 不會告訴我們它繞了幾圈
		if (this.loop && t >= this.loop.end) {
			const span = this.loop.end - this.loop.start;
			return this.loop.start + ((t - this.loop.start) % span);
		}
		return t;
	}

	/**
	 * 每一幀呼叫一次。主唱用的是 native loop，會自己繞回；背景不能跟著用 native loop
	 * （offset 可能讓區間落到背景的負時間），所以偵測到繞回時重排背景。誤差在一幀以內。
	 */
	tick() {
		if (!this.playing) return;
		const pos = this.position;
		if (this.loop && this.bgBuffer && pos < this.lastPos - 0.05) this.startBackground(pos);
		this.lastPos = pos;
	}

	async play(from?: number) {
		if (!this.buffer) return;
		await this.ctx.resume();
		this.stopNode();

		let at = from ?? this.startOffset;
		if (at >= this.buffer.duration - 1e-3) at = 0;   // 播到底了就從頭來

		const node = this.ctx.createBufferSource();
		node.buffer = this.buffer;
		node.connect(this.ctx.destination);
		if (this.loop) {
			node.loop = true;
			node.loopStart = this.loop.start;
			node.loopEnd = this.loop.end;
			if (at < this.loop.start || at >= this.loop.end) at = this.loop.start;
		}
		node.onended = () => {
			// 只有「自然播完」才算結束；手動 stop 會先把 node 清掉
			if (this.node === node) { this.playing = false; this.stopBackground(); this.onEnded?.(); }
		};
		node.start(0, at);

		this.node = node;
		this.startedAt = this.ctx.currentTime;
		this.startOffset = at;
		this.playing = true;
		this.lastPos = at;
		this.startBackground(at);
	}

	pause() {
		if (!this.playing) return;
		const at = this.position;
		this.stopNode();
		this.startOffset = at;
		this.playing = false;
	}

	seek(t: number) {
		const at = Math.max(0, t);
		if (this.playing) this.play(at);
		else this.startOffset = at;
	}

	/** 讓背景對齊主唱的播放位置 at（秒）開始播 */
	private startBackground(at: number) {
		this.stopBackground();
		if (!this.bgBuffer) return;
		const pos = at - this.bgOffset;
		if (pos >= this.bgBuffer.duration) return;   // 背景已經播完了
		const n = this.ctx.createBufferSource();
		n.buffer = this.bgBuffer;
		n.connect(this.bgGain);
		// 位置是負的 = 背景還沒開始，延後這麼久再開始播
		if (pos >= 0) n.start(0, pos);
		else n.start(this.ctx.currentTime - pos, 0);
		n.onended = () => { if (this.bgNode === n) this.bgNode = null; };
		this.bgNode = n;
	}

	private stopBackground() {
		if (!this.bgNode) return;
		const n = this.bgNode;
		this.bgNode = null;
		try { n.stop(); } catch { /* 已經停了或還沒開始 */ }
		n.disconnect();
	}

	private stopNode() {
		this.stopBackground();
		if (!this.node) return;
		const n = this.node;
		this.node = null;          // 先清掉，讓 onended 知道這是手動停止
		try { n.stop(); } catch { /* 已經停了 */ }
		n.disconnect();
	}

	private toBuffer(channels: Samples[], sampleRate: number): AudioBuffer {
		const buf = this.ctx.createBuffer(channels.length, channels[0].length, sampleRate);
		channels.forEach((c, i) => buf.copyToChannel(c, i));
		return buf;
	}
}
