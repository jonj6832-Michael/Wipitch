// 算繪器的主執行緒介面。
//
// 維護一份「輸出時間軸上的已算繪 buffer」。第一次要整段算過一次，
// 之後每次編輯只重算被改動的區域，用交叉淡化貼回去。
//
// 有 time stretch 時 buffer 的長度跟原檔不同：所有 fromSec / toSec 都是輸出時間，
// 曲線（原始時間）要經過 timeMap 換算。
//
// ── 背景精算 ──
//
// Rubber Band 即時模式每經過一次倍率切換，輸出時間就會留下 3~10ms 無法預測的殘差
// （spike/stretch-truth.mjs 掃過補償值，殘差不隨補償值平滑變化）。從不同位置開始算，
// 伸縮段裡的相位也不一樣。所以只要重算範圍碰到伸縮段，新算的聲音跟旁邊留著的舊聲音
// 就可能差幾毫秒，接縫處會有相位感。
//
// 解法：編輯時照樣先做快速的局部重算讓使用者繼續工作，同時在另一個 worker 裡把
// 「改動前後最近的兩個無聲處之間」一口氣算完。無聲的地方新舊差幾毫秒也聽不到，
// 所以接縫只要落在無聲處就沒有問題。算完瞬間換上；中途再有編輯就丟掉重來。
import RenderWorker from './render.worker?worker';
import { CURVE_HOP_SEC, type Curves } from '../model/curves';
import { TimeMap } from '../model/timemap';
import { HOP_SEC } from '../analysis/swiftf0';
import { samples, type Samples } from '../types';

/** 貼回去時的交叉淡化長度。實測 15ms 以上就聽不到接縫，取 25ms 留餘裕。 */
const CROSSFADE_SEC = 0.025;
/** 從中途開始算繪時，要多讀多少前文讓相位聲碼器暖機 */
const PRE_ROLL_SEC = 0.5;
/** 比整檔最大音量低多少 dB 算「無聲」 */
const SILENCE_DB = -40;
/**
 * 無聲至少要多長（**輸出時間**，秒）。交叉淡化 25ms 要整個放得進去，
 * 還要留一點給相位聲碼器的尾音。
 *
 * 用輸出時間算是因為壓縮會把間隙變短：60ms 的無聲壓成 0.5× 只剩 30ms，
 * 中間量到 −29dB（聽得到）；100ms 壓成 50ms 就是 −63dB（spike/stretch-truth.mjs 第 5 部分）。
 */
const SILENCE_MIN_SEC = 0.048;
/** 往外找無聲處最多找多遠；找不到就延伸到檔頭／檔尾 */
const SILENCE_SEARCH_SEC = 8;
/**
 * 重算範圍在選取範圍之外要多留多少，好讓接縫落在 Δ=0 的區域。
 *
 * 必須蓋得住最長的那條 lane 的邊界斜坡，否則接縫會落在 Δ≠0 的地方，
 * 那是聽得見的爆音（見 DESIGN.md 的交叉淡化實測）。斜坡之外再留 0.05s 餘裕。
 */
function marginSec(curves: Curves): number {
	return Math.max(0.15, curves.maxRampSec() + 0.05);
}

type Range = { from: number; to: number };

/** 一個算繪 worker 的連線。背景精算要能隨時整個丟掉，所以包成可以單獨終止的單位。 */
class WorkerLink {
	private worker: Worker;
	readonly ready: Promise<void>;
	private nextId = 1;
	private pending = new Map<number, {
		resolve: (c: Float32Array[]) => void;
		reject: (e: Error) => void;
		onProgress?: (f: number) => void;
	}>();

	constructor(channels: Samples[], sampleRate: number) {
		this.worker = new RenderWorker();
		this.ready = new Promise<void>(resolve => {
			this.worker.onmessage = (e: MessageEvent) => {
				const d = e.data;
				if (d.type === 'ready') { resolve(); return; }
				const p = this.pending.get(d.id);
				if (!p) return;
				// 進度訊息不算「完成」，不能把 pending 清掉
				if (d.type === 'progress') { p.onProgress?.(d.fraction); return; }
				this.pending.delete(d.id);
				if (d.type === 'error') p.reject(new Error(d.error));
				else p.resolve(d.channels);
			};
		});
		// 傳一份複本過去，主執行緒這邊的原始資料要留著
		const copies = channels.map(c => c.slice());
		this.worker.postMessage({ type: 'init', channels: copies, sampleRate }, copies.map(c => c.buffer));
	}

	async render(msg: object, onProgress?: (f: number) => void): Promise<Float32Array[]> {
		await this.ready;
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onProgress });
			this.worker.postMessage({ ...msg, type: 'render', id });
		});
	}

	terminate() {
		this.worker.terminate();
		for (const p of this.pending.values()) p.reject(new Error('cancelled'));
		this.pending.clear();
	}
}

export class Renderer {
	private link: WorkerLink | null = null;
	/** 算繪進度（0~1）。每次 patch / renderAll 期間會被反覆呼叫。 */
	onProgress: ((fraction: number) => void) | null = null;

	/** 目前聽到的聲音（輸出時間軸）。編輯會就地修補這份資料。 */
	rendered: Samples[] = [];
	/** 原始音訊，永遠不動。曲線回到中性、而且沒有伸縮的區域直接從這裡複製。 */
	private original: Samples[] = [];
	/**
	 * 送進 Rubber Band 的聲道。dual-mono（每個聲道逐 sample 相同）只送一個：
	 * 分開算兩次不但時間多一倍，兩個聲道的相位聲碼器還可能各自走出不同的相位。
	 */
	private renderChannels: Samples[] = [];
	sampleRate = 48000;
	/** formant 跟隨音高的比例（0 = 完全保留音色、1 = 完全跟著移調） */
	formantFollow = 0;
	/** rendered 目前是照哪一組錨點算的 */
	private timeMap = new TimeMap();
	/** 原始音訊每格（HOP_SEC）是不是無聲 */
	private silent = new Uint8Array(0);
	/** 原始音訊最大的格子 RMS。量接縫音量的基準 */
	private peakRms = 1;
	/** 最近一次換上的背景串流範圍（輸出秒）。測試用：確認接縫真的落在無聲處 */
	lastStream: Range | null = null;

	/** 背景精算的進度：null = 沒有在跑，否則 0~1 */
	backgroundProgress: number | null = null;
	/** 背景精算開始、有進度、結束或取消時呼叫 */
	onBackground: (() => void) | null = null;
	private bgLink: WorkerLink | null = null;
	/** 每次取消就加一；算完時世代對不上就表示中間有新的編輯，結果作廢 */
	private bgGen = 0;
	/**
	 * 背景串流算過的區間（原始時間）。那些地方就算曲線是中性的，也不是原始音訊的逐 sample 複本。
	 * 錨點全部拿掉之後，要把這些區間還原成「中性 = 原始音訊」。
	 */
	private streamed: Range[] = [];

	async init(channels: Samples[], sampleRate: number) {
		this.cancelBackground();
		this.link?.terminate();
		this.sampleRate = sampleRate;
		this.original = channels;
		this.renderChannels = isDualMono(channels) ? [channels[0]] : channels;
		this.rendered = channels.map(c => c.slice() as Samples);
		this.timeMap = new TimeMap();
		this.streamed = [];
		this.lastStream = null;
		({ silent: this.silent, peakRms: this.peakRms } = findSilence(channels, sampleRate));
		this.link = new WorkerLink(this.renderChannels, sampleRate);
		await this.link.ready;
	}

	private get srcDuration() { return this.original[0].length / this.sampleRate; }

	private outLength(map: TimeMap): number {
		return map.isIdentity
			? this.original[0].length
			: Math.round(map.srcToOut(this.srcDuration) * this.sampleRate);
	}

	/**
	 * 換上新的一組錨點。
	 *
	 * 伸縮倍率沒變的段落內容也不變，只是可能被平移了——直接從舊的 buffer 搬過去。
	 * 回傳倍率有變、必須重算的輸出範圍（秒）；呼叫端要接著對這段 patch()。
	 *
	 * 搬移時沒被填到的地方（也就是要重算的段落）先留 0，patch 會把它整段蓋掉；
	 * patch 的交叉淡化落在兩側的餘裕區，那裡是搬過來的正確內容。
	 */
	setTimeMap(next: TimeMap): Range | null {
		const old = this.timeMap;
		if (old.equals(next)) return null;
		this.cancelBackground();
		const sr = this.sampleRate;
		const dur = this.srcDuration;
		const newLen = this.outLength(next);
		const oldR = this.rendered;
		const newR = oldR.map(() => samples(newLen));

		// 兩組錨點的所有邊界切出來的每一小段，要嘛倍率相同（搬），要嘛不同（重算）
		const cuts = [...new Set([0, dur, ...old.anchors.map(a => a.src), ...next.anchors.map(a => a.src)])]
			.filter(t => t >= 0 && t <= dur).sort((a, b) => a - b);
		let dirtyFrom = Infinity, dirtyTo = -Infinity;
		for (let k = 0; k + 1 < cuts.length; k++) {
			const p = cuts[k], q = cuts[k + 1];
			const mid = (p + q) / 2;
			const o0 = Math.round(next.srcToOut(p) * sr), o1 = Math.min(newLen, Math.round(next.srcToOut(q) * sr));
			if (Math.abs(old.ratioAt(mid) - next.ratioAt(mid)) > 1e-12) {
				dirtyFrom = Math.min(dirtyFrom, o0 / sr);
				dirtyTo = Math.max(dirtyTo, o1 / sr);
				continue;
			}
			const shift = Math.round(old.srcToOut(p) * sr) - o0;
			for (let c = 0; c < newR.length; c++) {
				const src = oldR[c], dst = newR[c];
				const a = Math.max(o0, -shift), b = Math.min(o1, src.length - shift);
				if (b > a) dst.set(src.subarray(a + shift, b + shift), a);
			}
		}
		this.rendered = newR;
		this.timeMap = next.clone();
		return dirtyFrom < dirtyTo ? { from: dirtyFrom, to: dirtyTo } : null;
	}

	/** 整段重算。載入之後要先做一次，之後只有「全域性」的改動才需要。 */
	async renderAll(curves: Curves): Promise<void> {
		this.setTimeMap(curves.timeMap);
		this.cancelBackground();
		const out = this.expand(await this.link!.render(this.renderMsg(curves, 0, this.rendered[0].length, 0), f => this.onProgress?.(f)));
		out.forEach((c, i) => this.rendered[i].set(c, 0));
		// 整段一次算完本來就沒有接縫；有伸縮的話整段都算是串流算出來的
		this.streamed = this.timeMap.isIdentity ? [] : [{ from: 0, to: this.srcDuration }];
	}

	/**
	 * 只重算輸出時間 [fromSec, toSec) 這段並貼回去。
	 * curves.timeMap 必須已經透過 setTimeMap 套用過。
	 */
	async patch(curves: Curves, fromSec: number, toSec: number): Promise<void> {
		this.cancelBackground();
		const sr = this.sampleRate;
		const total = this.rendered[0].length;
		const fade = Math.round(CROSSFADE_SEC * sr);
		const map = this.timeMap;
		const dur = this.srcDuration;
		// 餘裕是原始時間的量（斜坡長在曲線上），換到輸出時間要乘上當地的倍率
		const margin = marginSec(curves);
		const fromOut = map.srcToOut(Math.max(0, map.outToSrc(fromSec) - margin));
		const toOut = map.srcToOut(Math.min(dur, map.outToSrc(toSec) + margin));

		// 重算範圍要涵蓋：選取範圍 + 斜坡 + 餘裕 + 兩端的交叉淡化區
		let from = Math.max(0, Math.round(fromOut * sr) - fade);
		let to = Math.min(total, Math.round(toOut * sr) + fade);
		if (to <= from) return;

		const srcA = map.outToSrc(from / sr), srcB = map.outToSrc(to / sr);
		const unity = map.unityRun((srcA + srcB) / 2, dur);
		if (unity && unity.from <= srcA && unity.to >= Math.min(dur, srcB) && isPitchNeutral(curves, srcA, srcB)) {
			// 音高與 formant 都是中性、而且這段沒有伸縮：直接從原始音訊複製（乘上音量曲線），
			// 不要再送進 Rubber Band。純音量編輯因此是即時的。
			//
			// 這不只是省時間，更是為了「正確」：Rubber Band 即使在 0 半音也是重新合成，
			// 相關係數只有 0.9975，復原之後聲音回不到真正的原始狀態。
			//
			// 有伸縮的段落**不能**走這條路——歸零之後那段仍然要被拉長或壓縮，
			// 原始音訊的長度根本對不上。
			//
			// 範圍要往外擴到「整段連續中性」為止。只還原請求的那一小段是不夠的——
			// 交叉淡化的邊緣會保留一部分舊的算繪內容，累積下來就是還原不乾淨
			// （實測殘留 1.1% RMS）。擴展之後，只有真正鄰接「還有編輯」的地方才需要淡化。
			// 擴展同樣不能越過伸縮的邊界。
			const run = neutralRun(curves, srcA, srcB, unity);
			// 這段 out − src 是常數，原始音訊整段平移過去
			const shift = Math.round(map.srcToOut(run.fromSec) * sr) - Math.round(run.fromSec * sr);
			from = Math.max(0, Math.round(run.fromSec * sr) + shift);
			to = Math.min(total, Math.round(run.toSec * sr) + shift);
			this.pasteOriginal(curves, this.rendered, from, to, shift, from > 0, to < total);
			return;
		}

		const preRoll = Math.min(Math.round(srcA * sr), Math.round(PRE_ROLL_SEC * sr));
		const out = this.expand(await this.link!.render(this.renderMsg(curves, from, to, preRoll), f => this.onProgress?.(f)));
		pasteWithFades(this.rendered, out, from, from > 0, to < total, sr);
	}

	// ── 背景精算 ────────────────────────────────────────────────────────────

	/**
	 * 針對剛才改動的輸出範圍開始背景精算（會先取消正在跑的那一個）。
	 * 算完而且中間沒有新的編輯才會換上，回傳 true；不需要或被取消回傳 false。
	 */
	async renderBackground(curves: Curves, changed: Range): Promise<boolean> {
		this.cancelBackground();
		const plan = this.backgroundPlan(curves, changed);
		if (!plan) return false;

		const gen = ++this.bgGen;
		const sr = this.sampleRate;
		const total = this.rendered[0].length;
		const map = this.timeMap;
		this.bgLink ??= new WorkerLink(this.renderChannels, sr);
		const link = this.bgLink;
		const alive = () => gen === this.bgGen;
		this.setBackground(0);

		// 每一段都先在複本上組好，全部算完才一次換上——算到一半被取消的話 rendered 完全沒被動過
		const staged: { at: number; data: Float32Array[] }[] = [];
		try {
			if (plan.kind === 'stream') {
				const { from: srcFrom, to: srcTo } = plan.src;
				const a = Math.round(map.srcToOut(srcFrom) * sr), b = Math.min(total, Math.round(map.srcToOut(srcTo) * sr));
				const preRoll = Math.min(Math.round(srcFrom * sr), Math.round(PRE_ROLL_SEC * sr));
				const out = this.expand(await link.render(this.renderMsg(curves, a, b, preRoll), f => { if (alive()) this.setBackground(f); }));
				staged.push({ at: a, data: out });
			} else {
				// 錨點都拿掉了：把串流算過的區間照「剛載入、做同樣編輯」的方式重建——
				// 中性的地方貼原始音訊，有編輯的地方一段一段重算
				const margin = marginSec(curves), fade = Math.round(CROSSFADE_SEC * sr);
				const jobs = this.streamed.map(r => ({ r, runs: editedRuns(curves, r, margin) }));
				const totalRuns = Math.max(1, jobs.reduce((s, j) => s + j.runs.length, 0));
				let done = 0;
				for (const { r, runs } of jobs) {
					const a = Math.round(r.from * sr), b = Math.min(total, Math.round(r.to * sr));
					const buf = this.original.map(c => c.slice(a, b) as Samples);
					for (const run of runs) {
						const ra = Math.max(0, Math.round(run.from * sr) - fade), rb = Math.min(total, Math.round(run.to * sr) + fade);
						const preRoll = Math.min(ra, Math.round(PRE_ROLL_SEC * sr));
						const out = this.expand(await link.render(this.renderMsg(curves, ra, rb, preRoll)));
						if (!alive()) return false;
						pasteWithFades(buf, out, ra - a, ra > a, rb < b, sr);
						this.setBackground(++done / totalRuns);
					}
					staged.push({ at: a, data: buf });
				}
			}
		} catch {
			return false;   // 被取消（worker 被終止）
		}
		if (!alive() || this.rendered[0].length !== total) return false;

		// 換上。每一段的兩端都落在無聲處（重建模式則是原始音訊），新舊內容差一點也聽不到
		for (const s of staged) pasteWithFades(this.rendered, s.data, s.at, s.at > 0, s.at + s.data[0].length < total, sr);
		this.streamed = plan.kind === 'stream' ? mergeRanges([...this.streamed, plan.src]) : [];
		this.lastStream = plan.kind === 'stream'
			? { from: map.srcToOut(plan.src.from), to: map.srcToOut(plan.src.to) }
			: null;
		this.setBackground(null);
		return true;
	}

	/** 目前算繪結果在輸出時間 t 附近（±12.5ms）的音量，相對原始音訊最大格子的 dB。測試用 */
	levelDbAt(t: number): number {
		const sr = this.sampleRate, half = Math.round(0.0125 * sr);
		const c0 = Math.round(t * sr);
		let s = 0, n = 0;
		for (const ch of this.rendered) {
			for (let i = Math.max(0, c0 - half); i < Math.min(ch.length, c0 + half); i++) { s += ch[i] * ch[i]; n++; }
		}
		return 20 * Math.log10(Math.sqrt(s / Math.max(1, n)) / this.peakRms + 1e-12);
	}

	cancelBackground() {
		if (this.backgroundProgress === null) return;
		this.bgGen++;
		this.bgLink?.terminate();
		this.bgLink = null;
		this.setBackground(null);
	}

	/**
	 * 背景要算哪一段、怎麼算。
	 *   stream：有伸縮。改動前後最近的兩個無聲處之間（原始時間），用一個串流算完。
	 *   rebuild：沒有伸縮了，但之前串流算過的區間要還原成「中性就是原始音訊」。
	 */
	private backgroundPlan(curves: Curves, changed: Range): { kind: 'stream'; src: Range } | { kind: 'rebuild' } | null {
		const map = this.timeMap;
		if (map.isIdentity) return this.streamed.length ? { kind: 'rebuild' } : null;

		const margin = marginSec(curves);
		const src = {
			from: this.silenceBefore(Math.max(0, map.outToSrc(changed.from) - margin)),
			to: this.silenceAfter(Math.min(this.srcDuration, map.outToSrc(changed.to) + margin)),
		};
		// 這段裡完全沒有伸縮、也從來沒被串流算過的話，快速的局部重算本來就是精確的
		const unity = map.unityRun((src.from + src.to) / 2, this.srcDuration);
		const touchesStretch = !unity || unity.from > src.from || unity.to < src.to;
		const touchesStreamed = this.streamed.some(r => r.from < src.to && r.to > src.from);
		return touchesStretch || touchesStreamed ? { kind: 'stream', src } : null;
	}

	/** 原始時間 t 之前最近的無聲處（那段無聲的中間）；找不到就是檔頭 */
	private silenceBefore(t: number): number {
		const stop = Math.max(0, Math.floor((t - SILENCE_SEARCH_SEC) / HOP_SEC));
		let run = 0, outLen = 0;
		for (let i = Math.min(this.silent.length - 1, Math.floor(t / HOP_SEC)); i >= stop; i--) {
			if (this.silent[i]) { run++; outLen += HOP_SEC * this.timeMap.ratioAt((i + 0.5) * HOP_SEC); }
			else { run = 0; outLen = 0; }
			if (outLen >= SILENCE_MIN_SEC) return (i + run / 2) * HOP_SEC;
		}
		return 0;
	}

	/** 原始時間 t 之後最近的無聲處（那段無聲的中間）；找不到就是檔尾 */
	private silenceAfter(t: number): number {
		const stop = Math.min(this.silent.length, Math.ceil((t + SILENCE_SEARCH_SEC) / HOP_SEC));
		let run = 0, outLen = 0;
		for (let i = Math.max(0, Math.ceil(t / HOP_SEC)); i < stop; i++) {
			if (this.silent[i]) { run++; outLen += HOP_SEC * this.timeMap.ratioAt((i + 0.5) * HOP_SEC); }
			else { run = 0; outLen = 0; }
			if (outLen >= SILENCE_MIN_SEC) return (i - run / 2 + 1) * HOP_SEC;
		}
		return this.srcDuration;
	}

	/** 單聲道算繪的結果複製到每個輸出聲道 */
	private expand(out: Float32Array[]): Float32Array[] {
		return this.original.map((_, c) => out[Math.min(c, out.length - 1)]);
	}

	private setBackground(p: number | null) {
		this.backgroundProgress = p;
		this.onBackground?.();
	}

	/**
	 * 把原始音訊貼到 dst[from, to)。dst[i] 對應原始音訊的 i − offset（offset 可正可負）。
	 * fadeHead / fadeTail：兩端要不要跟 dst 原本的內容交叉淡化。
	 */
	private pasteOriginal(curves: Curves, dst: Samples[], from: number, to: number, offset: number, fadeHead: boolean, fadeTail: boolean) {
		const fade = Math.round(CROSSFADE_SEC * this.sampleRate);
		const sr = this.sampleRate, g = curves.gainDb, n = curves.length;
		// 音量曲線乘在原始音訊上，跟 rbcore 乘在輸出上的是同一個時間（原始時間、沒有延遲）。
		// 0dB 的地方直接用原值，確保「回到中性就逐 sample 等於原始音訊」
		const gainAt = (srcIdx: number) => {
			const p = srcIdx / sr / CURVE_HOP_SEC;
			const k = Math.max(0, Math.min(n - 1, Math.floor(p))), f = Math.max(0, Math.min(1, p - k));
			const db = k + 1 < n ? g[k] * (1 - f) + g[k + 1] * f : g[k];
			return db === 0 ? 1 : Math.pow(10, db / 20);
		};
		for (let c = 0; c < dst.length; c++) {
			const d = dst[c], s = this.original[c];
			for (let i = from; i < to; i++) {
				const raw = s[i - offset] ?? 0;
				const gi = gainAt(i - offset);
				const v = gi === 1 ? raw : raw * gi;
				let a = 1;
				if (fadeHead && i - from < fade) a = 0.5 - 0.5 * Math.cos(Math.PI * (i - from) / fade);
				else if (fadeTail && to - i < fade) a = 0.5 - 0.5 * Math.cos(Math.PI * (to - i) / fade);
				d[i] = a === 1 ? v : d[i] * (1 - a) + v * a;
			}
		}
	}

	private renderMsg(curves: Curves, fromSample: number, toSample: number, preRollSamples: number) {
		return {
			delta: curves.pitch.slice(),
			gainDb: curves.gainDb.slice(),
			formant: curves.formant.slice(),
			formantFollow: this.formantFollow,
			hopSec: CURVE_HOP_SEC,
			anchors: this.timeMap.anchors.map(a => ({ src: a.src, out: a.out })),
			fromSample, toSample, preRollSamples,
		};
	}
}

/**
 * 把 src 貼到 dst 的 at 位置，兩端做 raised-cosine 交叉淡化。沒有淡化的話，Δ≠0 的接縫
 * 會產生自然跳躍量 4~5 倍的不連續，那是聽得見的爆音。
 */
function pasteWithFades(dst: Samples[], src: Float32Array[], at: number, fadeHead: boolean, fadeTail: boolean, sampleRate: number) {
	const fade = Math.round(CROSSFADE_SEC * sampleRate);
	for (let c = 0; c < dst.length; c++) {
		const d = dst[c], s = src[c];
		const n = Math.min(s.length, d.length - at);
		for (let i = 0; i < n; i++) {
			let a = 1;
			if (fadeHead && i < fade) a = 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
			else if (fadeTail && i > n - fade) a = 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / fade);
			d[at + i] = a === 1 ? s[i] : d[at + i] * (1 - a) + s[i] * a;
		}
	}
}

/**
 * 原始音訊每格（HOP_SEC）是不是無聲：該格 RMS 比整檔最大的格子低 SILENCE_DB 以上。
 * 同時回傳最大的格子 RMS，量接縫音量時當基準。
 */
function findSilence(channels: Samples[], sampleRate: number): { silent: Uint8Array<ArrayBuffer>; peakRms: number } {
	const hop = Math.round(HOP_SEC * sampleRate);
	const n = Math.ceil(channels[0].length / hop);
	const rms = new Float32Array(n);
	let peak = 0;
	for (let k = 0; k < n; k++) {
		let s = 0, cnt = 0;
		for (const ch of channels) {
			for (let i = k * hop; i < Math.min(ch.length, (k + 1) * hop); i++) { s += ch[i] * ch[i]; cnt++; }
		}
		rms[k] = Math.sqrt(s / Math.max(1, cnt));
		peak = Math.max(peak, rms[k]);
	}
	const threshold = peak * Math.pow(10, SILENCE_DB / 20);
	const silent = new Uint8Array(n);
	for (let k = 0; k < n; k++) silent[k] = rms[k] < threshold ? 1 : 0;
	return { silent, peakRms: peak };
}

function mergeRanges(ranges: Range[]): Range[] {
	const sorted = ranges.slice().sort((a, b) => a.from - b.from);
	const out: Range[] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
		else out.push({ ...r });
	}
	return out;
}

/** 區間 r（原始時間 = 沒有伸縮時的輸出時間）裡所有「有編輯」的範圍，相距不到兩倍餘裕的合併 */
function editedRuns(curves: Curves, r: Range, margin: number): Range[] {
	const runs: Range[] = [];
	const end = Math.min(curves.length, Math.ceil(r.to / CURVE_HOP_SEC));
	for (let i = Math.max(0, Math.floor(r.from / CURVE_HOP_SEC)); i < end; i++) {
		if (curves.isNeutralAt(i)) continue;
		let j = i;
		while (j < curves.length && !curves.isNeutralAt(j)) j++;
		const from = Math.max(r.from, i * CURVE_HOP_SEC - margin), to = Math.min(r.to, j * CURVE_HOP_SEC + margin);
		const last = runs[runs.length - 1];
		if (last && from <= last.to + margin) last.to = to;
		else runs.push({ from, to });
		i = j;
	}
	return runs;
}

/**
 * 從一段已知中性的範圍（原始時間）往兩側擴展，找出「整段連續中性」的最大範圍。
 * 不會越過 limit（沒有伸縮的區間）。
 */
function neutralRun(curves: Curves, fromSec: number, toSec: number, limit: Range) {
	const lo = Math.ceil(limit.from / CURVE_HOP_SEC), hi = Math.floor(limit.to / CURVE_HOP_SEC);
	let i = Math.max(0, Math.floor(fromSec / CURVE_HOP_SEC));
	let j = Math.min(curves.length, Math.ceil(toSec / CURVE_HOP_SEC));
	while (i > lo && curves.isPitchNeutralAt(i - 1)) i--;
	while (j < Math.min(curves.length, hi) && curves.isPitchNeutralAt(j)) j++;
	return {
		fromSec: i <= lo ? limit.from : i * CURVE_HOP_SEC,
		toSec: j >= Math.min(curves.length, hi) ? limit.to : j * CURVE_HOP_SEC,
	};
}

/** 聲道是不是逐 sample 相同（dual-mono） */
function isDualMono(channels: Samples[]): boolean {
	if (channels.length < 2) return false;
	const a = channels[0];
	for (let c = 1; c < channels.length; c++) {
		const b = channels[c];
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	}
	return true;
}

/** 這段原始時間範圍內的音高與 formant 是不是完全中性？（音量可以不是） */
function isPitchNeutral(curves: Curves, fromSec: number, toSec: number): boolean {
	const i0 = Math.max(0, Math.floor(fromSec / CURVE_HOP_SEC) - 1);
	const i1 = Math.min(curves.length, Math.ceil(toSec / CURVE_HOP_SEC) + 1);
	for (let i = i0; i < i1; i++) {
		if (!curves.isPitchNeutralAt(i)) return false;
	}
	return true;
}
