/**
 * 一段單聲道的取樣資料。
 *
 * 為什麼不直接寫 Float32Array：TypeScript 5.7 之後 TypedArray 帶了 buffer 型別參數，
 * 而 Web Audio 的 copyToChannel 只吃 ArrayBuffer 版本（不接受 SharedArrayBuffer）。
 * 全程統一用這個別名可以省掉一堆轉型。
 */
export type Samples = Float32Array<ArrayBuffer>;

export function samples(length: number): Samples {
	return new Float32Array(length) as Samples;
}
