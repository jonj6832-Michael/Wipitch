// 編輯狀態的核心資料結構。
//
// 整個程式的設計前提：**原始音訊永遠不動**。所有編輯都只是在改下面這幾條
// 每 2ms 一格的曲線。算繪永遠是「原始音訊 + 當前曲線」，所以不管編輯幾次
// 都不會累積劣化，也自動滿足「每個編輯都從最初的 audio 開始算」。
//
// 三條曲線（lane）共用同一套介面：pitch（半音）、gain（dB）、formant（半音）。
// 全部都是「加法語意 + 中性值」，所以選取、拖曳、畫筆、歸零只要寫一次。
import { HOP_SEC } from '../analysis/swiftf0';
import { TimeMap } from './timemap';

/**
 * 曲線格子比音高偵測（16ms）細幾倍。
 *
 * 曲線存在原始時間上，time stretch 拉長 N 倍時每格在輸出時間上也變 N 倍長。
 * 如果跟偵測共用 16ms，拉 3 倍就剩 48ms 一格，畫上去的抖音會變成折線。
 * 2ms 一格讓拉到 8 倍時仍然有不伸縮時的解析度。
 */
export const CURVE_SUB = 8;
export const CURVE_HOP_SEC = HOP_SEC / CURVE_SUB;

/**
 * 把偵測格（16ms）上的陣列線性內插到曲線格上。
 * 曲線第 k 格對應偵測格的位置 k / CURVE_SUB，最後幾格沿用最後一個偵測值。
 */
export function upsample(a: Float32Array): Float32Array {
	const out = new Float32Array(a.length * CURVE_SUB);
	for (let k = 0; k < out.length; k++) {
		const pos = k / CURVE_SUB, i = Math.floor(pos), f = pos - i;
		out[k] = i + 1 < a.length ? a[i] * (1 - f) + a[i + 1] * f : a[a.length - 1];
	}
	return out;
}

/** 發聲旗標放到曲線格上：夾在兩個發聲偵測格之間才算發聲（跟畫面上的斷線一致） */
export function upsampleVoiced(v: Uint8Array): Uint8Array {
	const out = new Uint8Array(v.length * CURVE_SUB);
	for (let k = 0; k < out.length; k++) {
		const i = Math.floor(k / CURVE_SUB);
		const next = i + 1 < v.length ? v[i + 1] : v[i];
		out[k] = k % CURVE_SUB === 0 ? v[i] : (v[i] && next ? 1 : 0);
	}
	return out;
}

export type LaneId = 'pitch' | 'gain' | 'formant';

export interface LaneSpec {
	label: string;
	unit: string;
	/** 沒有編輯時的值 */
	neutral: number;
	/** 畫面上的顯示範圍（pitch 不用，它跟著 piano roll 的 MIDI 範圍走） */
	min: number;
	max: number;
	color: string;
	/** 垂直拖曳一個畫面高度等於多少單位（pitch 不用） */
	step: number;
}

export const LANE_IDS: LaneId[] = ['pitch', 'gain', 'formant'];

export const LANES: Record<LaneId, LaneSpec> = {
	pitch:   { label: '音高',    unit: '半音', neutral: 0, min: -12, max: 12, color: '#5ac8fa', step: 0.01 },
	gain:    { label: '音量',    unit: 'dB',   neutral: 0, min: -24, max: 12, color: '#9ae66e', step: 0.1 },
	formant: { label: 'Formant', unit: '半音', neutral: 0, min: -12, max: 12, color: '#ffb86c', step: 0.01 },
};

/** 選取範圍邊界的淡入淡出長度（秒）。太短會爆音，太長會糊到旁邊。 */
export const DEFAULT_RAMP_SEC = 0.1;
/**
 * 畫筆的邊界斜坡長度，固定很短、不跟著「邊界過渡」設定走——
 * 畫筆要精確畫出想要的形狀，長斜坡會把筆畫的頭尾抹掉。
 */
export const PEN_RAMP_SEC = 0.02;
/**
 * 音高偏移 Δ 每秒最多變化幾個半音（0 = 不限制）。見 edits.ts 的 limitSlope。
 *
 * 60 半音/秒：1 半音的階梯會被拉成約 33ms 的斜坡，聽不出是滑音；
 * 深 1 半音、6Hz 的抖音峰值斜率約 38 半音/秒，壓平或畫筆抖音都不受影響。
 */
export const DEFAULT_PITCH_SLOPE_LIMIT = 60;

export class Curves {
	/** 每格的半音偏移量。0 = 不動 */
	pitch: Float32Array;
	/** 每格的增益，單位 dB。0 = 不動
	 *
	 * 存 dB 而不是線性倍率，是因為 automation 線需要等距的刻度，
	 * 而且「+3dB 再 +3dB」在 dB 上就是單純的加法，跟另外兩條 lane 語意一致。
	 */
	gainDb: Float32Array;
	/** 每格的 formant 偏移量（半音）。0 = 完全保留原本的音色 */
	formant: Float32Array;
	/** 每條 lane 的邊界斜坡長度（秒） */
	rampSec: Record<LaneId, number>;
	/** 音高偏移每秒最多變化幾個半音（0 = 不限制） */
	pitchSlopeLimit = DEFAULT_PITCH_SLOPE_LIMIT;
	/**
	 * Time stretch 的錨點。
	 *
	 * 放在這裡是因為它跟曲線一樣屬於「編輯狀態」：復原／重做、存檔都要一起帶著走。
	 * 三條曲線永遠存在原始時間上，錨點只決定它們被攤在輸出時間的哪裡。
	 */
	timeMap: TimeMap;
	readonly length: number;

	constructor(length: number) {
		this.length = length;
		this.pitch = new Float32Array(length);
		this.gainDb = new Float32Array(length);
		this.formant = new Float32Array(length);
		this.rampSec = { pitch: DEFAULT_RAMP_SEC, gain: DEFAULT_RAMP_SEC, formant: DEFAULT_RAMP_SEC };
		this.timeMap = new TimeMap();
	}

	static timeToFrame(t: number) { return Math.round(t / CURVE_HOP_SEC); }
	static frameToTime(i: number) { return i * CURVE_HOP_SEC; }

	lane(id: LaneId): Float32Array {
		return id === 'pitch' ? this.pitch : id === 'gain' ? this.gainDb : this.formant;
	}

	clone(): Curves {
		const c = new Curves(this.length);
		c.pitch.set(this.pitch);
		c.gainDb.set(this.gainDb);
		c.formant.set(this.formant);
		c.rampSec = { ...this.rampSec };
		c.pitchSlopeLimit = this.pitchSlopeLimit;
		c.timeMap = this.timeMap.clone();
		return c;
	}

	/** 這一格的音高與 formant 都在中性值嗎？（音量不必經過 Rubber Band，原始音訊乘上增益就好） */
	isPitchNeutralAt(i: number): boolean {
		return this.pitch[i] === 0 && this.formant[i] === 0;
	}

	/** 這一格三條 lane 都在中性值嗎？（算繪器用來判斷能不能直接複製原始音訊） */
	isNeutralAt(i: number): boolean {
		return this.pitch[i] === 0 && this.gainDb[i] === 0 && this.formant[i] === 0;
	}

	/** 三條 lane 之中最長的斜坡。算繪的邊界餘裕要蓋得住它。 */
	maxRampSec(): number {
		return Math.max(this.rampSec.pitch, this.rampSec.gain, this.rampSec.formant);
	}

	/** 取某個時間點的值（給算繪器與畫面查詢用） */
	valueAt(id: LaneId, t: number): number {
		const a = this.lane(id);
		const i = Math.round(t / CURVE_HOP_SEC);
		const v = a[Math.max(0, Math.min(this.length - 1, i))];
		return v === undefined ? LANES[id].neutral : v;
	}

	/** 某個時間點的線性增益（波形繪製與算繪都要用） */
	linearGainAt(t: number): number {
		return Math.pow(10, this.valueAt('gain', t) / 20);
	}
}

/**
 * 產生選取範圍的權重函式：範圍內是 1，兩端各有一段 raised-cosine 斜坡。
 *
 * 所有區域性編輯都透過這個權重套用，這樣邊界一定是平滑的。
 * 斜坡加在選取範圍「外面」，所以你圈的那一段從頭到尾都是完整的編輯量——
 * 跟 pitchmark.py 的 flatten_to_breakpoints 是同一個設計。
 */
export function rangeWeights(length: number, fromFrame: number, toFrame: number, rampSec: number): {
	from: number; to: number; ramp: number; weight: (i: number) => number;
} {
	const ramp = Math.max(1, Math.round(rampSec / CURVE_HOP_SEC));
	const from = Math.max(0, fromFrame - ramp);
	const to = Math.min(length, toFrame + ramp);

	return {
		from, to, ramp,
		weight(i: number) {
			if (i >= fromFrame && i < toFrame) return 1;
			if (i < fromFrame) {
				const d = (i - (fromFrame - ramp)) / ramp;     // 0 → 1
				return d <= 0 ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * d);
			}
			const d = ((toFrame + ramp) - i) / ramp;           // 1 → 0
			return d <= 0 ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * d);
		},
	};
}
