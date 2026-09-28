// 對曲線的各種編輯運算。
//
// 所有運算都透過 rangeWeights 套用，所以邊界一定有平滑斜坡，不會爆音。
// 三條 lane 都是「加法語意 + 中性值 0」，所以同一組函式就夠用。
import { Curves, rangeWeights, PEN_RAMP_SEC, CURVE_HOP_SEC, type LaneId } from './curves';

/** 把一段的某條 lane 整體偏移 amount（pitch 半音／gain dB／formant 半音） */
export function offsetLane(curves: Curves, id: LaneId, fromSec: number, toSec: number, amount: number) {
	const a = curves.lane(id);
	const i0 = Curves.timeToFrame(fromSec), i1 = Curves.timeToFrame(toSec);
	const { from, to, weight } = rangeWeights(curves.length, i0, i1, curves.rampSec[id]);
	for (let i = from; i < to; i++) a[i] += amount * weight(i);
}

/**
 * 把一段的某條 lane 歸零，回到原始狀態。
 *
 * 注意這裡是「用斜坡權重淡回 0」，不是直接切成 0。
 * 如果只歸零一個大編輯的中間一段，直接切會讓曲線出現跳階，聽起來就是爆音。
 * 用同一套 rangeWeights 淡回去，選取範圍內是完整歸零，兩端平滑接回原本的編輯。
 */
export function resetLane(curves: Curves, id: LaneId, fromSec: number, toSec: number) {
	// 歸零的「完全清除區」要比選取範圍再往外多一個斜坡長度。
	//
	// 因為每個編輯的斜坡本來就長在選取範圍「外面」，那些斜坡是被移除的編輯的一部分，
	// 不多清這一段的話會在邊界留下殘餘（實測一個 +1 半音的編輯歸零後，
	// 範圍外還留著 0.25 半音的凸起）。往外多清一個斜坡寬度剛好完整覆蓋。
	const a = curves.lane(id);
	const rampSec = curves.rampSec[id];
	const ramp = Math.max(1, Math.round(rampSec / CURVE_HOP_SEC));
	const i0 = Curves.timeToFrame(fromSec) - ramp;
	const i1 = Curves.timeToFrame(toSec) + ramp;
	const { from, to, weight } = rangeWeights(curves.length, i0, i1, rampSec);
	for (let i = from; i < to; i++) a[i] *= 1 - weight(i);
}

/** 三條 lane 全部歸零 */
export function resetAll(curves: Curves, fromSec: number, toSec: number) {
	resetLane(curves, 'pitch', fromSec, toSec);
	resetLane(curves, 'gain', fromSec, toSec);
	resetLane(curves, 'formant', fromSec, toSec);
}

/**
 * 畫筆：把一段時間內的 lane 值改寫成 valueAt() 給的值。
 *
 * 跟 offsetLane 不同，這是「取代」而不是「疊加」，所以兩端要用斜坡把新值
 * 跟原本的值混起來，否則畫的起點與終點會是跳階。
 * valueAt 回傳 null 表示那一格不要動（例如 pitch lane 碰到未發聲的格子）。
 */
export function drawLane(
	curves: Curves, id: LaneId, fromSec: number, toSec: number,
	valueAt: (t: number, i: number) => number | null,
) {
	const a = curves.lane(id);
	const i0 = Curves.timeToFrame(fromSec), i1 = Curves.timeToFrame(toSec);
	const { from, to, weight } = rangeWeights(curves.length, i0, Math.max(i0 + 1, i1), PEN_RAMP_SEC);
	for (let i = from; i < to; i++) {
		const v = valueAt(Curves.frameToTime(i), i);
		if (v === null) continue;
		const w = weight(i);
		a[i] = a[i] * (1 - w) + v * w;
	}
}

/**
 * 壓平（或放大）一段的音高起伏。
 *
 * 原理：把偵測到的音高 m[t] 拆成「中心線 c[t]」和「圍繞中心線的起伏 m[t]−c[t]」，
 * 然後只縮放起伏的部分：
 *
 *     Δ[t] += (α − 1) · (m[t] − c[t])
 *
 *   α = 0   → 完全壓平：整個選取範圍變成同一個音高
 *   α = 1   → 原樣不動
 *   α = 1.5 → 起伏加大一半
 *
 * 中心線的視窗長度跟著 α 走（這是使用者要的語意）：
 *   α ≥ 1 → 200ms。抖音是 4–7Hz 會被濾掉，旋律走向是 1Hz 以下會被保留，
 *           所以放大起伏時放大的是抖音，不是整條旋律。
 *   α < 1 → 從 200ms 連續拉長到「整個選取範圍」。α=0 時視窗蓋住整段，
 *           中心線退化成一個常數中位數，於是整段被推平到同一個音高。
 *           α=0.5 的視窗還是相對短，所以刻意的滑音仍然保留得住。
 *
 * 用中位數而不是平均，是因為中位數對偵測的離群值免疫。
 */
export function flattenRange(
	curves: Curves,
	pitchMidi: Float32Array,
	voiced: Uint8Array,
	fromSec: number,
	toSec: number,
	alpha: number,
	baseWindowSec = 0.2,
) {
	const i0 = Curves.timeToFrame(fromSec), i1 = Curves.timeToFrame(toSec);
	const { from, to, weight } = rangeWeights(curves.length, i0, i1, curves.rampSec.pitch);
	if (to <= from) return;

	// 把選取範圍內的音高抓出來，未發聲的空隙用線性內插補起來。
	// 不補的話中位數視窗會被 0 汙染，中心線會整個歪掉。
	const m = fillGaps(pitchMidi, voiced, from, to);

	const baseWin = Math.max(1, Math.round(baseWindowSec / CURVE_HOP_SEC));
	const fullWin = m.length;   // 整段（含兩端斜坡）
	const win = alpha >= 1
		? baseWin
		: Math.max(1, Math.round(fullWin + alpha * (baseWin - fullWin)));
	const center = movingMedian(m, win);

	for (let i = from; i < to; i++) {
		const k = i - from;
		if (!isFinite(m[k]) || !isFinite(center[k])) continue;
		curves.pitch[i] += (alpha - 1) * (m[k] - center[k]) * weight(i);
	}
}

/** 取出 [from,to) 的音高，未發聲處用兩側的值線性內插 */
export function fillGaps(pitchMidi: Float32Array, voiced: Uint8Array, from: number, to: number): Float32Array {
	const n = to - from;
	const out = new Float32Array(n).fill(NaN);
	for (let i = 0; i < n; i++) if (voiced[from + i]) out[i] = pitchMidi[from + i];

	let prev = -1;
	for (let i = 0; i < n; i++) {
		if (isNaN(out[i])) continue;
		if (prev >= 0 && i - prev > 1) {
			for (let j = prev + 1; j < i; j++) {
				const f = (j - prev) / (i - prev);
				out[j] = out[prev] * (1 - f) + out[i] * f;
			}
		}
		prev = i;
	}
	// 頭尾的空白用最近的有效值延伸
	const first = out.findIndex(v => !isNaN(v));
	if (first < 0) return out;
	for (let i = 0; i < first; i++) out[i] = out[first];
	let last = n - 1;
	while (last >= 0 && isNaN(out[last])) last--;
	for (let i = last + 1; i < n; i++) out[i] = out[last];
	return out;
}

/**
 * 移動中位數。window 是格數。
 *
 * 視窗在陣列邊緣會「往內推」而不是被截短。截短的話 window 等於整段長度時，
 * 頭尾算出來的仍然是局部中位數，α=0 就壓不成一條真正的水平線。
 * 往內推之後 window ≥ 長度時每一格的視窗都是整個陣列，中心線退化成常數。
 */
function movingMedian(x: Float32Array, window: number): Float32Array {
	const n = x.length;
	const w = Math.min(window, n);
	const half = Math.floor(w / 2);
	const out = new Float32Array(n);
	const buf: number[] = [];
	for (let i = 0; i < n; i++) {
		const lo = Math.max(0, Math.min(i - half, n - w));
		const hi = Math.min(n - 1, lo + w - 1);
		buf.length = 0;
		for (let j = lo; j <= hi; j++) {
			if (!isNaN(x[j])) buf.push(x[j]);
		}
		if (!buf.length) { out[i] = NaN; continue; }
		buf.sort((a, b) => a - b);
		out[i] = buf[buf.length >> 1];
	}
	return out;
}

/**
 * 限制音高偏移 Δ 的變化率：相鄰格子最多差 maxPerSec · CURVE_HOP_SEC 半音。
 *
 * 為什麼限制的是 Δ 而不是音高本身：原唱本身有一個很陡的音高變化（換音、滑音），
 * 使用者把它畫平，Δ 在那裡就等於「原唱變化的反向」——陡的階梯。Rubber Band 每 21ms
 * 更新一次倍率，陡的階梯聽起來是一下抽動。把 Δ 拉緩之後，原唱的變化會露出一小段，
 * 但換來的是聽不到抽動。
 *
 * 做法：上下兩條 Lipschitz 包絡取平均。
 *   up[i] = min_j (y[j] + c·|i−j|)   ≤ y，斜率 ≤ c
 *   lo[i] = max_j (y[j] − c·|i−j|)   ≥ y，斜率 ≤ c
 * 平均的斜率也 ≤ c，一定合乎限制；O(n) 兩趟就算完。性質：
 *   - 本來就合乎限制的曲線 up = lo = y，**逐位元不變**（全 0 仍是全 0，滑桿回中性仍能逐位元還原）
 *   - 高 S 的階梯變成以原位置為中心、斜率 c/2、長 2S/c 的斜坡——不偏早也不偏晚
 *   - 平均的斜率上限是 c，所以設定值就是「最多」這麼快，不會超過
 *
 * [from, to) 是格子索引，呼叫端要自己預留 maxAbsΔ / maxPerSec 以上的餘裕，
 * 否則範圍邊緣附近被拉緩的部分會截在範圍外。
 */
export function limitSlope(curve: Float32Array, from: number, to: number, maxPerSec: number) {
	if (!(maxPerSec > 0)) return;
	from = Math.max(0, from); to = Math.min(curve.length, to);
	const n = to - from;
	if (n < 2) return;
	const c = maxPerSec * CURVE_HOP_SEC;
	// 先確認有沒有違反，沒有就完全不碰（保證逐位元不變）
	let violated = false;
	for (let i = from + 1; i < to; i++) if (Math.abs(curve[i] - curve[i - 1]) > c) { violated = true; break; }
	if (!violated) return;

	const up = new Float32Array(n), lo = new Float32Array(n);
	for (let k = 0; k < n; k++) up[k] = lo[k] = curve[from + k];
	for (let k = 1; k < n; k++) { up[k] = Math.min(up[k], up[k - 1] + c); lo[k] = Math.max(lo[k], lo[k - 1] - c); }
	for (let k = n - 2; k >= 0; k--) { up[k] = Math.min(up[k], up[k + 1] + c); lo[k] = Math.max(lo[k], lo[k + 1] - c); }
	for (let k = 0; k < n; k++) curve[from + k] = up[k] === lo[k] ? up[k] : (up[k] + lo[k]) / 2;
}

/** limitSlope 需要的餘裕（格數）：最大的 |Δ| 要花多久才能拉回來 */
export function slopeMarginFrames(curve: Float32Array, from: number, to: number, maxPerSec: number): number {
	if (!(maxPerSec > 0)) return 0;
	let m = 0;
	for (let i = Math.max(0, from); i < Math.min(curve.length, to); i++) m = Math.max(m, Math.abs(curve[i]));
	return Math.ceil(m / maxPerSec / CURVE_HOP_SEC) + 2;
}
