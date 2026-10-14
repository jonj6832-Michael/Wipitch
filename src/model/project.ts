// 專案存檔。
//
// 存的是「原始檔絕對路徑 + 原始檔資訊 + 曲線」，不把音訊嵌入專案。
// 這跟 pitchmark.py 的 .pitchsession.json 是同一個想法：
// session 檔才是原始檔，算繪結果隨時可以重新產生。
import { Curves, CURVE_HOP_SEC, CURVE_SUB, upsample, type LaneId } from './curves';
import { TimeMap } from './timemap';

const FORMAT = 'wipitch-project';
const VERSION = 5;

interface ProjectFile {
	format: string;
	version: number;
	audioName: string;
	/** v5：本機原始音訊的絕對路徑；舊專案沒有此欄位。 */
	audioPath?: string;
	sampleRate: number;
	duration: number;
	hopSec: number;
	length: number;
	/** v2 欄位（base64 的 Float32） */
	pitch?: string;
	gainDb?: string;
	formant?: string;
	rampSec?: Record<LaneId, number>;
	/** 音高偏移的變化率上限（半音/秒）。舊檔沒有這個欄位 = 用預設值 */
	pitchSlopeLimit?: number;
	/** 全域的 Voice(0) / Instrument(1) 模式。舊檔沒有這個欄位，當成 0 */
	formantFollow?: number;
	/** v3：time stretch 錨點（秒）。舊檔沒有這個欄位 = 沒有伸縮 */
	anchors?: { src: number; out: number }[];
	/** 背景參考音軌的設定（不含音訊，讀檔後要使用者重新載入同名檔） */
	background?: BackgroundSettings;
	/** v1 欄位：半音偏移與「線性」增益 */
	delta?: string;
	gain?: string;
}

export interface BackgroundSettings {
	name: string;
	gainDb: number;
	muted: boolean;
	offsetSec: number;
}

export function serialize(
	curves: Curves, audioName: string, audioPath: string, sampleRate: number, duration: number, formantFollow = 0,
	background?: BackgroundSettings,
): string {
	const data: ProjectFile = {
		format: FORMAT, version: VERSION,
		audioName, audioPath, sampleRate, duration,
		hopSec: CURVE_HOP_SEC, length: curves.length,
		pitch: toBase64(curves.pitch),
		gainDb: toBase64(curves.gainDb),
		formant: toBase64(curves.formant),
		rampSec: curves.rampSec,
		pitchSlopeLimit: curves.pitchSlopeLimit,
		formantFollow,
		anchors: curves.timeMap.anchors.map(a => ({ src: a.src, out: a.out })),
		background,
	};
	return JSON.stringify(data, null, 2);
}

/**
 * 讀取專案。
 *
 * 取樣率或格數對不上就拒絕載入——比照 pitchmark.py 的做法。
 * 這種錯誤不會當掉，只會讓所有時間點悄悄歪掉，所以一定要擋。
 */
export interface LoadedProject {
	curves: Curves;
	/** 全域的 Voice(0) / Instrument(1) 模式 */
	formantFollow: number;
	background?: BackgroundSettings;
}

export interface ProjectSource {
	version: number;
	audioName: string;
	audioPath?: string;
	sampleRate: number;
	duration: number;
}

function parseProject(text: string): ProjectFile {
	const d = JSON.parse(text) as ProjectFile;
	if (d.format !== FORMAT) throw new Error('這不是 WiPitch 專案檔');
	if (!Number.isInteger(d.version) || d.version < 1) throw new Error('專案檔版本無效');
	if (d.version > VERSION) throw new Error(`專案檔版本 ${d.version} 太新，這個版本讀不了`);
	if (!d.audioName || !Number.isFinite(d.sampleRate) || !Number.isFinite(d.duration)) throw new Error('專案檔缺少原始音訊資訊');
	if (d.version >= 5 && d.audioPath === undefined) throw new Error('專案檔缺少原始音訊的絕對路徑');
	if (d.audioPath !== undefined && (typeof d.audioPath !== 'string' || !d.audioPath.startsWith('/'))) throw new Error('專案檔的音訊絕對路徑無效');
	return d;
}

/** 先取得原音訊位置，讓應用程式能先載入音訊，再還原曲線。 */
export function inspectProject(text: string): ProjectSource {
	const d = parseProject(text);
	return { version: d.version, audioName: d.audioName, audioPath: d.audioPath, sampleRate: d.sampleRate, duration: d.duration };
}

export function deserialize(text: string, sampleRate: number, trackLength: number): LoadedProject {
	const d = parseProject(text);
	if (d.sampleRate !== sampleRate) {
		throw new Error(`專案檔的取樣率是 ${d.sampleRate}Hz，目前的音檔是 ${sampleRate}Hz，時間軸會對不上`);
	}
	// v4 起曲線是 2ms 一格；v3 以前跟音高偵測一樣 16ms 一格，讀進來要內插放大
	const fine = d.version >= 4;
	const fileFrames = fine ? d.length / CURVE_SUB : d.length;
	if (fileFrames !== trackLength) {
		throw new Error(`專案檔有 ${fileFrames} 格，目前的音檔是 ${trackLength} 格，可能不是同一個檔案`);
	}
	const load = (b64: string) => fine ? fromBase64(b64) : upsample(fromBase64(b64));

	const curves = new Curves(trackLength * CURVE_SUB);
	// 0 表示不限制，必須保留；舊檔缺少設定時沿用 Curves 的預設值。
	curves.pitchSlopeLimit = d.pitchSlopeLimit ?? curves.pitchSlopeLimit;
	if (d.version >= 2) {
		if (d.pitch) curves.pitch.set(load(d.pitch));
		if (d.gainDb) curves.gainDb.set(load(d.gainDb));
		if (d.formant) curves.formant.set(load(d.formant));
		if (d.rampSec) curves.rampSec = { ...curves.rampSec, ...d.rampSec };
		if (d.anchors) curves.timeMap = new TimeMap(d.anchors.map((a, i) => ({ id: i + 1, src: a.src, out: a.out })));
	} else {
		// v1：delta 就是 pitch；gain 是線性倍率，要先換算成 dB 再內插。
		// 線性 0（理論上不會出現，保險起見）換成 −120dB 而不是 −Infinity。
		if (d.delta) curves.pitch.set(load(d.delta));
		if (d.gain) {
			const lin = fromBase64(d.gain);
			const db = new Float32Array(Math.min(trackLength, lin.length));
			for (let i = 0; i < db.length; i++) db[i] = lin[i] > 0 ? 20 * Math.log10(lin[i]) : -120;
			curves.gainDb.set(upsample(db));
		}
	}
	return { curves, formantFollow: d.formantFollow ?? 0, background: d.background };
}

function toBase64(a: Float32Array): string {
	const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	let s = '';
	// 一次轉太多會爆呼叫堆疊，所以分段
	for (let i = 0; i < bytes.length; i += 8192) {
		s += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return btoa(s);
}

function fromBase64(s: string): Float32Array {
	const bin = atob(s);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Float32Array(bytes.buffer);
}
