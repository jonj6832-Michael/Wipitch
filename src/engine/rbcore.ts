// Rubber Band 算繪核心。
//
// 這個檔案刻意不碰任何「怎麼載入 wasm」的事情——載入方式在 Node 和瀏覽器
// Worker 裡不一樣，但演算法邏輯要完全相同，才能在 Node 裡用數值驗證，
// 然後放心地在瀏覽器裡跑同一套。
import { TimeMap } from '../model/timemap';

/** rubberband-wasm 的 RubberBandInterface（只列出我們用到的部分） */
export interface RubberBandApi {
	malloc(size: number): number;
	free(ptr: number): void;
	memWrite(dest: number, data: Float32Array): void;
	memWritePtr(dest: number, src: number): void;
	memReadF32(src: number, length: number): Float32Array;
	rubberband_new(sampleRate: number, channels: number, options: number, timeRatio: number, pitchScale: number): number;
	rubberband_delete(state: number): void;
	rubberband_set_pitch_scale(state: number, scale: number): void;
	rubberband_set_time_ratio(state: number, ratio: number): void;
	rubberband_set_formant_scale(state: number, scale: number): void;
	rubberband_get_samples_required(state: number): number;
	rubberband_set_max_process_size(state: number, samples: number): void;
	rubberband_get_preferred_start_pad(state: number): number;
	rubberband_get_start_delay(state: number): number;
	rubberband_process(state: number, input: number, samples: number, final: number): void;
	rubberband_available(state: number): number;
	rubberband_retrieve(state: number, output: number, samples: number): number;
}

// Rubber Band 的選項位元。等同命令列的 `-3 -F`。
export const RB_OPTIONS =
	1 |            // ProcessRealTime — 時變音高只能用即時模式，離線模式的 pitch 整段固定
	536870912 |    // EngineFiner     — R3 引擎（`-3`）
	67108864 |     // PitchHighConsistency — 見下方說明，這個一定要開
	16777216;      // FormantPreserved — 保留音色（`-F`）

/**
 * 每處理多少 sample 更新一次音高。
 *
 * Rubber Band 建議的大小是 4096（85ms），但我們的曲線是 16ms 一格，
 * 用建議值等於把曲線降取樣 5.3 倍。實測「跟隨 5.5Hz 音高自動化」的深度：
 *
 *   block 4096 → 1.32     block 1024 → 1.82     block 512 → 1.85
 *   （目標 2.00，speed 3x / 3x / 2x 即時）
 *
 * 1024 是品質與速度的平衡點。
 */
export const RB_BLOCK = 1024;

/**
 * 音高自動化的延遲補償（秒）。
 *
 * 我們是依照「剛讀進去的輸入位置」設定音高，但 Rubber Band 在那一刻吐出來的
 * 輸出其實對應到更早的輸入。實測結果：輸出的音高變化比曲線「早了 85ms」，
 * 而且 1Hz~7Hz 量到的值完全一致（−84.5 / −85.0 / −85.1 / −85.2ms），
 * 是個固定的常數延遲。
 *
 * 不補償的話，對慢速的編輯只是輕微不同步，但對抖音（4~7Hz）就是災難：
 * 5.5Hz 的半週期是 91ms，跟 85ms 幾乎相等——反向抵銷會變成同向疊加，
 * 壓平抖音反而會讓抖音變嚴重（實測變成原本的 159%）。
 */
export const AUTOMATION_LAG_SEC = 0.085;

/**
 * Formant 自動化的延遲補償（秒）。
 *
 * **不等於音高的 85ms。** 直覺上兩者走同一條相位聲碼器管線，延遲應該相同，
 * 實測卻是 39ms（`spike/formant-lag.mjs`，用頻譜包絡重心的 lock-in 量相位）：
 *
 *   頻率      1Hz     2Hz     3Hz    5.5Hz
 *   不補償  −39.2   −39.3   −39.4   −39.9 ms     ← 跟頻率無關，是個常數
 *   補 85ms  +44.3   +44.4   +44.5   +45.0 ms     ← 補過頭 46ms
 *   補 39ms   −0.2    −0.3    −0.4    −0.9 ms     ← 對齊
 *
 * 照抄 85ms 會補過頭 46ms，對慢速的 formant 編輯只是輕微不同步，
 * 但畫筆畫得快一點就會整個對不上。
 */
export const FORMANT_LAG_SEC = 0.039;

/**
 * 伸縮倍率的生效時間補償（秒，原始時間）。**負的**：新倍率會提早生效。
 *
 * 即時模式下 rubberband_set_time_ratio 會在「輸入還沒到」的時候就開始照新倍率走
 * （spike/stretch-probe.mjs，每 0.25s 一個短音包，看輸出裡的位置）：
 *
 *   段落          段落內脈衝誤差（輸出時間）   換算回輸入
 *   1~2s 為 2×    +31ms（多吐了輸出 → 變晚）   提早 31ms
 *   1~3s 為 0.5×  −15ms（少吐了輸出 → 變早）   提早 30ms
 *   固定倍率       0（開頭丟掉的永遠是 startPad，與倍率無關）
 *
 * 再用 spike/stretch-truth.mjs 掃補償值（脈衝誤差 ms，含量法本身約 +2.5ms 的偏差）：
 *
 *                        −30ms        −35ms        −38ms        −40ms
 *   2×                  −0.4~7.8     1.2~3.7     −3.5~2.8     −3.3~2.8
 *   0.5×                −2.4~2.8    −0.5~2.8      0.3~2.8      0.8~3.4
 *   1.5× 接 0.5×        −4.4~5.0    −2.7~3.3     −0.9~2.8     −1.1~3.0
 *
 * 這只能讓時間「整體」對齊。每次倍率切換還會留下 3~10ms 的殘差，而且殘差隨補償值
 * 不規則跳動（同一組掃描裡「局部 vs 整段」的偏移：2× 為 5.8 / 8.6 / 3.3 / 4.7ms），
 * 沒有任何常數消得掉——所以接縫的問題交給 renderer.ts 的背景精算處理。
 *
 * 第一版把正負號弄反（往前看 +30ms），誤差從 37ms 變成 68ms。
 */
export const STRETCH_LAG_SEC = -0.038;

/**
 * 自動化延遲在伸縮下怎麼換算（spike/stretch-lag.mjs，整段固定倍率、2Hz 音高正弦）。
 *
 * 85ms 其實是「一半在輸入端、一半在輸出端」。量到的延遲換算回原始時間：
 *
 *   倍率    量到      a + b/r（a = b = 42.5ms）
 *   1×     84.6ms    85.0ms
 *   2×     63.2ms    63.75ms
 *   0.5×   127.6ms   127.5ms
 *
 * 輸出端那一半在原始時間上會被倍率縮放，所以補償量 = lag · (½ + ½ / r)。
 * formant 的 39ms 用同樣的拆法（見 FORMANT_LAG_SPLIT）。
 */
function lagAt(lagSec: number, inputShare: number, ratio: number): number {
	return lagSec * (inputShare + (1 - inputShare) / ratio);
}
const PITCH_LAG_SPLIT = 0.5;
/**
 * formant 延遲在輸入端的比例：**全部**。跟音高不同，39ms 不隨倍率改變
 * （spike/stretch-lag.mjs 第 4 部分，換算回原始時間：1× 39.3、2× 41.8、0.5× 39.6ms）。
 */
const FORMANT_LAG_SPLIT = 1;

/*
 * ──────────────────────────────────────────────────────────────────────
 *  為什麼是 PitchHighConsistency 而不是 PitchHighQuality
 * ──────────────────────────────────────────────────────────────────────
 *
 * 這是壓平抖音功能的成敗關鍵，而且是踩過的坑。
 *
 * 用 PitchHighQuality 時，Rubber Band 會把音高變化平滑掉。常數移調完全正常
 * （誤差 0.000 半音），但快速變動的曲線會被整個濾掉。實測輸出的調變深度
 * （Δ 曲線是 ±2 半音的正弦，完美跟隨應該量到 2.00）：
 *
 *                          1Hz    2Hz    3Hz   5.5Hz    8Hz
 *   R3 + PitchHighQuality  2.05   1.72   1.46   0.36    0.64   ← 抖音頻段整個掛掉
 *   R3 + PitchHighConsistency 2.05 1.97  1.99   1.85    1.79   ← 正常
 *
 * 人聲抖音是 4~7Hz，正好落在壞掉的頻段，所以壓平功能完全沒效果，
 * 而且殘餘的階梯狀跳動聽起來是斷斷續續的。
 *
 * 附帶一提，Rubber Band 的文件說 R3 引擎會忽略這組 pitch 選項——實測並沒有。
 * 而且換過去之後音色保留不但沒變差，降調時還更好（-5 半音：0.82 → 0.68 半音偏移）。
 */

export interface RenderRequest {
	channels: Float32Array[];
	sampleRate: number;
	/** 每格的半音偏移 */
	delta: Float32Array;
	/** 每格的增益，單位 dB（0 = 不動） */
	gainDb: Float32Array;
	/** 每格的 formant 偏移（半音，0 = 完全保留原本的音色）。省略等同全 0 */
	formant?: Float32Array;
	/**
	 * formant 跟隨音高的比例。
	 * 0 = 完全保留音色（FormantPreserved 的預設行為）、1 = 完全跟著移調（花栗鼠）。
	 */
	formantFollow?: number;
	/** 一格多少秒 */
	hopSec: number;
	/** 只算這個範圍（sample 索引）。省略表示整段 */
	fromSample?: number;
	toSample?: number;
	/**
	 * 前導暖機長度（sample）。
	 * 相位聲碼器有內部狀態，從中途開始算的話要先餵一段前文讓它「暖機」，
	 * 算完再丟掉，否則接縫處會有明顯的雜音。
	 */
	preRollSamples?: number;
	/**
	 * 每處理多少 sample 更新一次音高。省略的話用 Rubber Band 建議的大小。
	 *
	 * 這個值決定了「時變音高曲線的取樣率」。Rubber Band 建議的 4096 個 sample
	 * 是 85ms，但我們的曲線是 16ms 一格——用建議值等於把曲線降取樣 5.3 倍，
	 * 快速變動的編輯（例如壓平抖音）會變成階梯狀跳動，聽起來斷斷續續。
	 */
	blockSamples?: number;
	/** 覆寫 Rubber Band 的選項位元（測試用） */
	options?: number;
	/** 覆寫自動化延遲補償（秒）。測試用，正常情況別動。 */
	automationLagSec?: number;
	/** 覆寫 formant 的自動化延遲補償（秒）。測試用。 */
	formantLagSec?: number;
	/**
	 * Time stretch 的錨點（秒）。省略或空陣列 = 不伸縮。
	 * 有伸縮時 fromSample / toSample 是「輸出」的 sample 索引；preRollSamples 仍是原始音訊的 sample 數。
	 */
	anchors?: { src: number; out: number }[];
	/** 覆寫伸縮倍率的生效延遲補償（秒）。測試用。 */
	stretchLagSec?: number;
	/**
	 * 進度回報（0~1）。長段落的算繪要好幾秒，沒有回饋的話使用者不知道是在跑還是當掉了。
	 * 呼叫頻率刻意壓低（每 32 個 block ≈ 0.7 秒的輸入），免得回報本身變成負擔。
	 */
	onProgress?: (fraction: number) => void;
}

/**
 * 用時變音高曲線算繪一段音訊。
 *
 * 回傳的長度與請求範圍完全一致，而且時間上對齊——延遲已經補償掉了。
 */
export function renderWithCurve(api: RubberBandApi, req: RenderRequest): Float32Array[] {
	const { channels, sampleRate, delta, gainDb, hopSec } = req;
	const formant = req.formant;
	const formantFollow = req.formantFollow ?? 0;
	const nch = channels.length;
	const total = channels[0].length;
	const map = new TimeMap((req.anchors ?? []).map((a, i) => ({ id: i + 1, src: a.src, out: a.out })));
	const stretched = !map.isIdentity;
	const outTotal = stretched ? Math.round(map.srcToOut(total / sampleRate) * sampleRate) : total;

	const wantFrom = Math.max(0, req.fromSample ?? 0);
	const wantTo = Math.min(outTotal, req.toSample ?? outTotal);
	const wantLen = Math.max(0, wantTo - wantFrom);
	if (wantLen === 0) return channels.map(() => new Float32Array(0));

	// 輸出位置 wantFrom 對應到原始音訊的哪裡。沒有伸縮時兩者相同。
	const srcFrom = stretched
		? Math.min(total, Math.floor(map.outToSrc(wantFrom / sampleRate) * sampleRate))
		: wantFrom;
	const preRoll = Math.min(srcFrom, req.preRollSamples ?? 0);
	const readFrom = srcFrom - preRoll;

	const options = req.options ?? RB_OPTIONS;
	const state = api.rubberband_new(sampleRate, nch, options, 1.0, 1.0);
	const suggested = api.rubberband_get_samples_required(state);
	const block = Math.max(32, Math.min(req.blockSamples ?? RB_BLOCK, suggested));
	api.rubberband_set_max_process_size(state, block);
	const startPad = api.rubberband_get_preferred_start_pad(state);

	// wasm 這邊要一個「指標陣列」，每個元素指向一個聲道的緩衝區
	const arrayPtr = api.malloc(nch * 4);
	const dataPtr: number[] = [];
	for (let c = 0; c < nch; c++) {
		const p = api.malloc(block * 4);
		dataPtr.push(p);
		api.memWritePtr(arrayPtr + c * 4, p);
	}

	// 要丟掉的輸出長度 = 我們自己餵進去的靜音前導 + 暖機前導。
	//
	// 注意「不要」再扣 rubberband_get_start_delay()。用脈衝實測過：
	// 不餵 start pad 時輸出延遲是 0，餵了 2048 個靜音之後延遲剛好是 2048——
	// 也就是說 Rubber Band 自己已經補償掉演算法延遲了，再扣一次會讓整段
	// 提早 2048 個 sample（而且不會報錯，只會聽起來對不上）。
	//
	// 伸縮時暖機段吐出來的長度不是 preRoll，而是它在輸出時間軸上的長度；
	// srcFrom 取整的零頭也一起算進來，輸出才會精準對齊 wantFrom。
	const discard = startPad + (stretched
		? Math.round(wantFrom - map.srcToOut(readFrom / sampleRate) * sampleRate)
		: preRoll);
	const out = channels.map(() => new Float32Array(wantLen));
	let written = 0;   // 已經吐出來的輸出 sample 數（含要丟掉的部分）

	const silence = new Float32Array(block);
	const lagSec = req.automationLagSec ?? AUTOMATION_LAG_SEC;
	const formantLagSec = req.formantLagSec ?? FORMANT_LAG_SEC;

	const drain = (final: boolean) => {
		for (;;) {
			const avail = api.rubberband_available(state);
			if (avail < 1) break;
			if (!final && avail < block) break;
			const got = api.rubberband_retrieve(state, arrayPtr, Math.min(block, avail));
			if (got < 1) break;
			for (let c = 0; c < nch; c++) {
				const data = api.memReadF32(dataPtr[c], got);
				for (let i = 0; i < got; i++) {
					const pos = written + i - discard;
					if (pos >= 0 && pos < wantLen) out[c][pos] = data[i];
				}
			}
			written += got;
			if (written - discard >= wantLen) return;
		}
	};

	// 伸縮：每個 block 讓「累計輸出量」追著理想的時間對應走。
	// 不用「每個 block 各自取當下的倍率」——block 邊界的零頭會一路累積成漂移。
	const stretchLag = req.stretchLagSec ?? STRETCH_LAG_SEC;
	const outBase = map.srcToOut(readFrom / sampleRate + stretchLag);
	const targetOut = (x: number) => (map.srcToOut(x / sampleRate + stretchLag) - outBase) * sampleRate;
	let plannedOut = 0;
	let ratioNow = 1;
	if (stretched) {
		ratioNow = Math.max(1e-6, map.ratioAt(readFrom / sampleRate + stretchLag));
		api.rubberband_set_time_ratio(state, ratioNow);
	}

	// 先餵 startPad 個靜音，這是 Rubber Band 對即時模式的建議做法，
	// 可以讓第一個真實 sample 出來的時候管線已經填滿了
	for (let done = 0; done < startPad;) {
		const count = Math.min(block, startPad - done);
		for (let c = 0; c < nch; c++) api.memWrite(dataPtr[c], silence.subarray(0, count));
		api.rubberband_process(state, arrayPtr, count, 0);
		done += count;
		drain(false);
	}

	// 主體。每個 block 依照當下的時間查曲線，更新 pitch scale。
	const tailTo = stretched ? Math.ceil(map.outToSrc(wantTo / sampleRate) * sampleRate) : wantTo;
	const readTo = Math.min(total, tailTo + Math.ceil(sampleRate * 0.1)); // 尾巴多讀一點，讓最後一個 block 有東西可吐
	const span = Math.max(1, readTo - readFrom);
	let blocksDone = 0;
	for (let read = readFrom; read < readTo;) {
		// 拉長時一個 block 在輸出時間上也跟著變長，曲線（抖音）更新就變稀疏，
		// 所以按倍率把讀取量切小，讓每次更新在輸出時間上仍然約一個 block 長
		const step = stretched ? Math.max(32, Math.ceil(block / Math.max(1, ratioNow))) : block;
		const count = Math.min(step, readTo - read);
		if (req.onProgress && (blocksDone++ & 31) === 0) req.onProgress((read - readFrom) / span);

		if (stretched) {
			// 1e-6 只是擋掉 0 與負數（段長已經由 TimeMap 保證 > 0，這是浮點誤差的保險）
			const r = Math.max(1e-6, (targetOut(read + count) - plannedOut) / count);
			plannedOut += r * count;
			if (r !== ratioNow) { api.rubberband_set_time_ratio(state, r); ratioNow = r; }
		}

		// 查曲線的時間要往回推一個「自動化延遲」，見 AUTOMATION_LAG_SEC 的說明
		const t = (read + count / 2) / sampleRate - lagAt(lagSec, PITCH_LAG_SPLIT, ratioNow);
		// 在格子之間線性內插，不要取最近的格子。曲線格子直接取整
		// 等於把延遲補償量化成格子長（當初 16ms 一格時量過），實測會讓壓平效果在幾個補償值之間跳階。
		const semis = sampleCurve(delta, t / hopSec, 0);
		api.rubberband_set_pitch_scale(state, Math.pow(2, semis / 12));

		// Formant。
		//
		// **明確指定 formant scale 會關掉 FormantPreserved 的自動補償**，而且
		// 指定的值是「相對於已經移調後的訊號」——所以要自己把移調量扣掉：
		//
		//     實際的包絡位移（半音） = Δ + 12·log2(scale)
		//
		// 想要淨位移 D 就要傳 scale = 2^((D − Δ)/12)。實測（formant-scale-semantics.mjs）：
		//
		//   傳 1.0         → 保留率 0.014  ← 等於完全沒保留，就是花栗鼠
		//   不呼叫 / 傳 0.0 → 保留率 0.922  ← 自動補償
		//   傳 2^(−Δ/12)   → 與 auto 逐項相同（+7 都是 −0.19、−5 都是 −0.56 半音）
		//
		// 最後一行是重點：D=0 用這個公式算出來就是 auto，所以不必為了「沒有 formant
		// 編輯」另外開一條不呼叫的路徑，一條公式涵蓋全部情況。
		const tf = (read + count / 2) / sampleRate - lagAt(formantLagSec, FORMANT_LAG_SPLIT, ratioNow);
		const wanted = (formant ? sampleCurve(formant, tf / hopSec, 0) : 0)
			+ formantFollow * sampleCurve(delta, tf / hopSec, 0);
		// 扣的是「這個 block 實際套用的移調量」semis，不是 tf 時刻的 Δ——
		// 這一項是在抵銷引擎當下的行為，不是使用者看得到的量。
		api.rubberband_set_formant_scale(state, Math.pow(2, (wanted - semis) / 12));

		// 音量不在這裡乘，見迴圈結束後的 applyGain
		for (let c = 0; c < nch; c++) api.memWrite(dataPtr[c], channels[c].subarray(read, read + count));

		read += count;
		api.rubberband_process(state, arrayPtr, count, read >= readTo ? 1 : 0);
		drain(false);
		if (written - discard >= wantLen) break;
	}
	drain(true);
	applyGain(out, gainDb, hopSec, sampleRate, wantFrom, stretched ? map : null);
	req.onProgress?.(1);

	api.rubberband_delete(state);
	for (const p of dataPtr) api.free(p);
	api.free(arrayPtr);

	return out;
}

/**
 * 音量乘在**輸出**上，照輸出位置換回原始時間查曲線。
 *
 * 以前乘在餵進 Rubber Band 的輸入上，還用了扣掉音高自動化延遲（85ms）的時間去查——
 * 可是乘在輸入上的增益會跟著訊號走完整條管線，管線延遲 Rubber Band 已經自己補償了，
 * 所以音量變化實際上晚了 85ms，而且每個 block（21ms）一個階梯
 * （spike/gain-lag.mjs：修正前 −85ms，修正後 0ms）。
 * 乘在輸出上就沒有延遲可言，也不會讓 Rubber Band 把音量變化誤判成 transient。
 *
 * 每 64 個 sample 查一次曲線、中間線性內插，這樣伸縮時 outToSrc 不會變成每個 sample 都算。
 */
const GAIN_STEP = 64;
function applyGain(out: Float32Array[], gainDb: Float32Array, hopSec: number, sampleRate: number, outFrom: number, map: TimeMap | null) {
	const len = out[0]?.length ?? 0;
	if (len === 0) return;
	const gainAt = (k: number) => {
		const tOut = (outFrom + k) / sampleRate;
		const tSrc = map ? map.outToSrc(tOut) : tOut;
		return Math.pow(10, sampleCurve(gainDb, tSrc / hopSec, 0) / 20);
	};
	for (let k0 = 0; k0 < len; k0 += GAIN_STEP) {
		const k1 = Math.min(len, k0 + GAIN_STEP);
		const g0 = gainAt(k0), g1 = gainAt(k1);
		if (g0 === 1 && g1 === 1) continue;
		for (let c = 0; c < out.length; c++) {
			const o = out[c];
			for (let k = k0; k < k1; k++) o[k] *= g0 + (g1 - g0) * (k - k0) / GAIN_STEP;
		}
	}
}

/** 在曲線上做線性內插取樣。超出範圍時夾在兩端。 */
function sampleCurve(curve: Float32Array, pos: number, fallback: number): number {
	if (curve.length === 0) return fallback;
	if (pos <= 0) return curve[0];
	if (pos >= curve.length - 1) return curve[curve.length - 1];
	const i = Math.floor(pos), f = pos - i;
	return curve[i] * (1 - f) + curve[i + 1] * f;
}
