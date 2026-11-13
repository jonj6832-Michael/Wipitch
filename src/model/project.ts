// 專案存檔。
//
// 存的是「原始檔絕對路徑 + 原始檔資訊 + 曲線」，不把音訊嵌入專案。
// 這跟 pitchmark.py 的 .pitchsession.json 是同一個想法：
// session 檔才是原始檔，算繪結果隨時可以重新產生。
import { Curves, CURVE_HOP_SEC, CURVE_SUB, upsample, type LaneId } from './curves';
import { TimeMap } from './timemap';
import type { ReferenceBeatRecord } from './reference-beat-table';
import type { AIRegion } from './ai-regions';

const FORMAT = 'wipitch-project';
const VERSION = 6;

interface StoredAIRegion extends Omit<AIRegion, 'original' | 'ai' | 'adjusted' | 'originalFormant' | 'aiFormant' | 'adjustedFormant'> {
	original: number[];
	ai: number[];
	adjusted: number[];
	originalFormant: number[];
	aiFormant: number[];
	adjustedFormant: number[];
}

export interface InspectionSettings {
	detectionRange?: { start:number; end:number } | null;
	aiRegions?: AIRegion[];
}

interface ProjectFile {
	format: string;
	version: number;
	audioName: string;
	/** v5：本機原始音訊的絕對路徑；舊專案沒有此欄位。 */
	audioPath?: string;
	/** v6：回存按鈕實際覆寫的位置；audioPath 可能改指向安全備份。 */
	audioWritebackPath?: string;
	audioSize?: number;
	audioSha256?: string;
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
	/** v6：檢測範圍與尚在畫面上的 AI／人工黃框。 */
	inspection?: { detectionRange?: { start:number; end:number } | null; aiRegions?: StoredAIRegion[] };
	/** v1 欄位：半音偏移與「線性」增益 */
	delta?: string;
	gain?: string;
}

export interface BackgroundSettings {
	name: string;
	/** 參考檔身分；避免不同目錄中的同名音檔誤套拍點與和弦。 */
	fileSize?: number;
	lastModified?: number;
	gainDb: number;
	muted: boolean;
	offsetSec: number;
	beatAnchorSec?: number | null;
	/** 多錨點格式；beatAnchorSec 保留供舊版專案相容。 */
	beatAnchorSecs?: number[];
	tempoBpm?: number;
	tempoMeter?: string;
	tempoTolerancePercent?: number;
	instrumentProfile?: 'rhythm' | 'melody';
	onsetProminenceThreshold?: number;
	beatConfirmationThreshold?: number;
	barStartsSec?: number[];
	virtualBarStartsSec?: number[];
	beatRecords?: ReferenceBeatRecord[];
}

export function serialize(
	curves: Curves, audioName: string, audioPath: string, sampleRate: number, duration: number, formantFollow = 0,
	background?: BackgroundSettings, inspection?: InspectionSettings, audioWritebackPath = audioPath,
	audioSize?: number, audioSha256?: string,
): string {
	const data: ProjectFile = {
		format: FORMAT, version: VERSION,
		audioName, audioPath, audioWritebackPath, audioSize, audioSha256, sampleRate, duration,
		hopSec: CURVE_HOP_SEC, length: curves.length,
		pitch: toBase64(curves.pitch),
		gainDb: toBase64(curves.gainDb),
		formant: toBase64(curves.formant),
		rampSec: curves.rampSec,
		pitchSlopeLimit: curves.pitchSlopeLimit,
		formantFollow,
		anchors: curves.timeMap.anchors.map(a => ({ src: a.src, out: a.out })),
		background,
		inspection: inspection ? {
			detectionRange: inspection.detectionRange ? { ...inspection.detectionRange } : inspection.detectionRange,
			aiRegions: inspection.aiRegions?.map(region => ({ ...region,
				original: Array.from(region.original), ai: Array.from(region.ai), adjusted: Array.from(region.adjusted),
				originalFormant: Array.from(region.originalFormant), aiFormant: Array.from(region.aiFormant),
				adjustedFormant: Array.from(region.adjustedFormant),
				feedbackKey: region.feedbackKey ? { ...region.feedbackKey } : undefined,
			})),
		} : undefined,
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
	inspection?: InspectionSettings;
}

export interface ProjectSource {
	version: number;
	audioName: string;
	audioPath?: string;
	audioWritebackPath?: string;
	audioSize?: number;
	audioSha256?: string;
	sampleRate: number;
	duration: number;
}

function parseProject(text: string): ProjectFile {
	const d = JSON.parse(text) as ProjectFile;
	if (d.format !== FORMAT) throw new Error('這不是 WiPitch 專案檔');
	if (!Number.isInteger(d.version) || d.version < 1) throw new Error('專案檔版本無效');
	if (d.version > VERSION) throw new Error(`專案檔版本 ${d.version} 太新，這個版本讀不了`);
	if (!d.audioName || !Number.isFinite(d.sampleRate) || d.sampleRate <= 0 || !Number.isFinite(d.duration) || d.duration <= 0) throw new Error('專案檔缺少原始音訊資訊');
	if (!Number.isInteger(d.length) || d.length <= 0) throw new Error('專案檔的曲線長度無效');
	if (d.audioSize !== undefined && (!Number.isInteger(d.audioSize) || d.audioSize <= 0)) throw new Error('專案檔的音訊大小無效');
	if (d.audioSha256 !== undefined && (typeof d.audioSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(d.audioSha256))) throw new Error('專案檔的音訊指紋無效');
	if (d.version >= 5 && d.audioPath === undefined) throw new Error('專案檔缺少原始音訊的絕對路徑');
	const absolute = (value: unknown): value is string => typeof value === 'string'
		&& (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));
	if (d.audioPath !== undefined && !absolute(d.audioPath)) throw new Error('專案檔的音訊絕對路徑無效');
	if (d.audioWritebackPath !== undefined && !absolute(d.audioWritebackPath)) throw new Error('專案檔的回存音訊路徑無效');
	if (d.audioPath && d.audioWritebackPath && !relatedAudioPaths(d.audioPath, d.audioWritebackPath)) {
		throw new Error('專案檔的回存音訊路徑與來源檔案不相符');
	}
	if (d.version >= 6) {
		const expectedBytes = d.length * Float32Array.BYTES_PER_ELEMENT;
		for (const [label, value] of [['pitch', d.pitch], ['gainDb', d.gainDb], ['formant', d.formant]] as const) {
			if (typeof value !== 'string') throw new Error(`專案檔缺少 ${label} 曲線`);
			let bytes = -1;
			try { bytes = atob(value).length; } catch { throw new Error(`專案檔的 ${label} 曲線編碼損壞`); }
			if (bytes !== expectedBytes) throw new Error(`專案檔的 ${label} 曲線長度不完整`);
		}
	}
	return d;
}

function relatedAudioPaths(source: string, writeback: string): boolean {
	const split = (value: string) => {
		const normalized = value.replaceAll('\\', '/');
		const slash = normalized.lastIndexOf('/');
		const directory = normalized.slice(0, slash).toLowerCase();
		const name = normalized.slice(slash + 1);
		const dot = name.lastIndexOf('.');
		return { directory, base: (dot < 0 ? name : name.slice(0, dot)).toLowerCase(), extension: (dot < 0 ? '' : name.slice(dot)).toLowerCase() };
	};
	const a = split(source), b = split(writeback);
	return a.directory === b.directory && a.extension === b.extension
		&& (a.base === b.base || a.base === `${b.base}.wipitch-original`);
}

/** 先取得原音訊位置，讓應用程式能先載入音訊，再還原曲線。 */
export function inspectProject(text: string): ProjectSource {
	const d = parseProject(text);
	return { version: d.version, audioName: d.audioName, audioPath: d.audioPath, audioWritebackPath: d.audioWritebackPath,
		...(d.audioSize===undefined?{}:{audioSize:d.audioSize}),...(d.audioSha256===undefined?{}:{audioSha256:d.audioSha256}),
		sampleRate: d.sampleRate, duration: d.duration };
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
	return { curves, formantFollow: d.formantFollow ?? 0, background: d.background,
		inspection: restoreInspection(d.inspection, curves.length) };
}

function restoreInspection(value: ProjectFile['inspection'], curveLength:number):InspectionSettings|undefined {
	if(!value||typeof value!=='object')return undefined;
	const range=value.detectionRange;
	const detectionRange=range&&Number.isFinite(range.start)&&Number.isFinite(range.end)&&range.end>range.start
		?{start:range.start,end:range.end}:null;
	const arrays=(region:StoredAIRegion)=>[region.original,region.ai,region.adjusted,region.originalFormant,region.aiFormant,region.adjustedFormant];
	const aiRegions=(Array.isArray(value.aiRegions)?value.aiRegions:[]).filter((region):region is StoredAIRegion=>{
		if(!region||!Number.isInteger(region.id)||!Number.isInteger(region.from)||!Number.isInteger(region.to)
			||region.from<0||region.to<=region.from||region.to>curveLength)return false;
		const length=region.to-region.from;
		return arrays(region).every(array=>Array.isArray(array)&&array.length===length&&array.every(Number.isFinite));
	}).map(region=>({...region,
		original:Float32Array.from(region.original),ai:Float32Array.from(region.ai),adjusted:Float32Array.from(region.adjusted),
		originalFormant:Float32Array.from(region.originalFormant),aiFormant:Float32Array.from(region.aiFormant),
		adjustedFormant:Float32Array.from(region.adjustedFormant),feedbackKey:region.feedbackKey?{...region.feedbackKey}:undefined,
	}));
	return {detectionRange,aiRegions};
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
