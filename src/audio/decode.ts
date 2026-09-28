// 音檔載入與解碼。
import type { Samples } from '../types';

/** 解碼後的素材。原始音訊在整個程式生命週期中都不會被修改。 */
export interface Source {
	name: string;
	/** 原始取樣率的聲道資料，永遠保持原樣 */
	channels: Samples[];
	sampleRate: number;
	/** 長度（秒） */
	duration: number;
	/** 給音高偵測用的 16kHz 單聲道版本 */
	mono16k: Samples;
}

/** SwiftF0 的工作取樣率。所有音高分析都在這個取樣率上做。 */
export const ANALYSIS_RATE = 16000;

export async function decodeFile(file: File): Promise<Source> {
	const bytes = await file.arrayBuffer();

	// 用一個暫時的 AudioContext 解碼。瀏覽器原生解碼器支援 wav/mp3/flac/m4a 等格式，
	// 比自己寫解析器可靠得多。
	const ctx = new AudioContext();
	const buffer = await ctx.decodeAudioData(bytes);
	await ctx.close();

	const channels: Samples[] = [];
	for (let c = 0; c < buffer.numberOfChannels; c++) {
		channels.push(buffer.getChannelData(c).slice() as Samples);
	}

	return {
		name: file.name,
		channels,
		sampleRate: buffer.sampleRate,
		duration: buffer.duration,
		mono16k: await toMono16k(buffer),
	};
}

/** 只解碼聲道，不做音高分析用的 16kHz 版本。背景參考音軌用這個。 */
export async function decodeAudio(file: File): Promise<{ name: string; channels: Samples[]; sampleRate: number; duration: number }> {
	const ctx = new AudioContext();
	const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
	await ctx.close();
	const channels: Samples[] = [];
	for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice() as Samples);
	return { name: file.name, channels, sampleRate: buffer.sampleRate, duration: buffer.duration };
}

/**
 * 轉成 16kHz 單聲道，給 SwiftF0 用。
 *
 * 用 OfflineAudioContext 來重取樣，因為它內建的是高品質多相濾波器；
 * 自己寫線性內插會有 aliasing，而 aliasing 會直接讓音高偵測出錯。
 */
async function toMono16k(buffer: AudioBuffer): Promise<Samples> {
	const frames = Math.ceil(buffer.duration * ANALYSIS_RATE);
	const ctx = new OfflineAudioContext(1, frames, ANALYSIS_RATE);

	const src = ctx.createBufferSource();
	src.buffer = buffer;

	// 多聲道先混成單聲道（ChannelMergerNode 的預設 down-mix 就是取平均）
	const merger = ctx.createGain();
	src.connect(merger);
	merger.connect(ctx.destination);
	src.start();

	const rendered = await ctx.startRendering();
	return rendered.getChannelData(0).slice() as Samples;
}

/** 把秒數格式化成 m:ss.mmm。行為與 pitchmark.py 的 fmt_time 一致。 */
export function fmtTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) seconds = 0;
	const m = Math.floor(seconds / 60);
	const s = seconds - m * 60;
	return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
