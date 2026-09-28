// Time stretch 的時間對應。
//
// 程式裡有兩個時間軸：
//   原始時間（src）：原始音訊、音高偵測、三條曲線都存在這裡，永遠不變。
//   輸出時間（out）：畫面、播放頭、選取、匯出——使用者看到和聽到的時間。
//
// 錨點記住「原本在 src 哪裡、現在被拉到 out 哪裡」，兩個錨點之間線性伸縮。
// 隱含的起點是 (0, 0)；第一個錨點之前照 (0,0)→錨點 的比例伸縮，
// 最後一個錨點之後倍率固定是 1（只是整段平移）。
//
// 刪除錨點就是把它從陣列拿掉，對應自然重算——所以「刪掉錨點時伸縮回復、
// 但曲線數值不動」不需要任何特別處理：曲線本來就存在 src 上。

export interface Anchor {
	id: number;
	/** 原始時間（秒） */
	src: number;
	/** 輸出時間（秒） */
	out: number;
}

/**
 * 相鄰錨點之間的最小間距（秒）。這不是介面上的限制，是技術性的：
 * 段長為 0 會讓倍率變成 0 或無限大（除以零）。
 */
export const MIN_GAP_SEC = 0.001;

export class TimeMap {
	/** 依 src 排序，out 也必然遞增 */
	private list: Anchor[];
	private nextId: number;

	constructor(anchors: Anchor[] = []) {
		this.list = anchors.map(a => ({ ...a })).sort((a, b) => a.src - b.src);
		this.nextId = this.list.reduce((m, a) => Math.max(m, a.id + 1), 1);
	}

	get anchors(): readonly Anchor[] { return this.list; }
	get isIdentity(): boolean { return this.list.every(a => a.src === a.out); }

	clone(): TimeMap { return new TimeMap(this.list); }

	equals(other: TimeMap): boolean {
		const a = this.list, b = other.list;
		return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.src === b[i].src && x.out === b[i].out);
	}

	/** src → out */
	srcToOut(t: number): number {
		const a = this.list;
		if (!a.length) return t;
		const k = upper(a, t, 'src');
		if (k === a.length) return a[k - 1].out + (t - a[k - 1].src);
		const p0 = k === 0 ? 0 : a[k - 1].src, q0 = k === 0 ? 0 : a[k - 1].out;
		return q0 + (t - p0) * (a[k].out - q0) / (a[k].src - p0);
	}

	/** out → src */
	outToSrc(t: number): number {
		const a = this.list;
		if (!a.length) return t;
		const k = upper(a, t, 'out');
		if (k === a.length) return a[k - 1].src + (t - a[k - 1].out);
		const p0 = k === 0 ? 0 : a[k - 1].src, q0 = k === 0 ? 0 : a[k - 1].out;
		return p0 + (t - q0) * (a[k].src - p0) / (a[k].out - q0);
	}

	/** 在 src 時間 t 的伸縮倍率（out 長度 / src 長度）。1 = 沒有伸縮 */
	ratioAt(t: number): number {
		const a = this.list;
		if (!a.length) return 1;
		const k = upper(a, t, 'src');
		if (k === a.length) return 1;
		const p0 = k === 0 ? 0 : a[k - 1].src, q0 = k === 0 ? 0 : a[k - 1].out;
		return (a[k].out - q0) / (a[k].src - p0);
	}

	/**
	 * 在輸出時間 t 加一個錨點。加錨點本身不改變對應（新錨點落在原本的直線上）。
	 * 跟既有錨點太近（段長會變 0）就不加，回傳 null。
	 */
	add(outT: number): Anchor | null {
		const src = this.outToSrc(outT);
		if (src < MIN_GAP_SEC) return null;
		if (this.list.some(a => Math.abs(a.src - src) < MIN_GAP_SEC)) return null;
		const anchor = { id: this.nextId++, src, out: outT };
		this.list.push(anchor);
		this.list.sort((a, b) => a.src - b.src);
		return anchor;
	}

	/** 把錨點拉到輸出時間 out。只夾在相鄰錨點之間（不能越過），沒有倍率上下限。 */
	move(id: number, out: number): Anchor | null {
		const k = this.list.findIndex(a => a.id === id);
		if (k < 0) return null;
		const lo = (k === 0 ? 0 : this.list[k - 1].out) + MIN_GAP_SEC;
		const hi = k === this.list.length - 1 ? Infinity : this.list[k + 1].out - MIN_GAP_SEC;
		this.list[k].out = Math.max(lo, Math.min(hi, out));
		return this.list[k];
	}

	/**
	 * 一群錨點一起移動：全部照 base 裡的位置平移 delta 秒。
	 * 限制只來自「沒被選到」的相鄰錨點（和起點 0）；被選到的彼此一起動，順序不會變。
	 * 回傳實際套用的位移（被夾過之後）。
	 */
	moveGroup(base: TimeMap, ids: ReadonlySet<number>, delta: number): number {
		const a = base.list;
		let lo = -Infinity, hi = Infinity;
		for (let k = 0; k < a.length; k++) {
			if (!ids.has(a[k].id)) continue;
			if (k === 0) lo = Math.max(lo, MIN_GAP_SEC - a[k].out);
			else if (!ids.has(a[k - 1].id)) lo = Math.max(lo, a[k - 1].out + MIN_GAP_SEC - a[k].out);
			if (k < a.length - 1 && !ids.has(a[k + 1].id)) hi = Math.min(hi, a[k + 1].out - MIN_GAP_SEC - a[k].out);
		}
		const d = Math.max(lo, Math.min(hi, delta));
		this.list = a.map(x => (ids.has(x.id) ? { ...x, out: x.out + d } : { ...x }));
		return d;
	}

	remove(id: number): boolean {
		const k = this.list.findIndex(a => a.id === id);
		if (k < 0) return false;
		this.list.splice(k, 1);
		return true;
	}

	get(id: number): Anchor | undefined { return this.list.find(a => a.id === id); }

	/**
	 * 包含 src 時間 t 的「倍率 = 1」最大連續區間（src 秒）；t 所在的段落有伸縮就回傳 null。
	 *
	 * 區間內 out − src 是同一個常數，所以可以把原始音訊整段平移複製過去。
	 * 相鄰兩段都是 1× 但位移不同是不可能的（中間一定隔著一段伸縮），所以只看倍率就夠。
	 */
	unityRun(t: number, durationSec: number): { from: number; to: number } | null {
		const a = this.list;
		const bounds = [0, ...a.map(x => x.src), Infinity];
		const k = upper(a, t, 'src');   // t 落在 bounds[k] ~ bounds[k+1]
		const isUnity = (seg: number) => Math.abs(this.segRatio(seg) - 1) < 1e-9;
		if (!isUnity(k)) return null;
		let lo = k, hi = k;
		while (lo > 0 && isUnity(lo - 1)) lo--;
		while (hi < a.length && isUnity(hi + 1)) hi++;
		return { from: bounds[lo], to: Math.min(durationSec, bounds[hi + 1]) };
	}

	/** 第 seg 段（0 = 起點到第一個錨點；a.length = 最後一個錨點之後）的倍率 */
	private segRatio(seg: number): number {
		const a = this.list;
		if (seg >= a.length) return 1;
		const p0 = seg === 0 ? 0 : a[seg - 1].src, q0 = seg === 0 ? 0 : a[seg - 1].out;
		return (a[seg].out - q0) / (a[seg].src - p0);
	}
}

/** 第一個 key 值 > t 的索引（t 剛好落在錨點上時算進左邊那段） */
function upper(a: Anchor[], t: number, key: 'src' | 'out'): number {
	let lo = 0, hi = a.length;
	while (lo < hi) {
		const m = (lo + hi) >> 1;
		if (a[m][key] > t) hi = m; else lo = m + 1;
	}
	return lo;
}
