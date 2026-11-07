import type { PitchTrack } from './swiftf0';
import { HOP, SR } from './swiftf0';
import { planBalancedAudioSegments, PARALLEL_CUT_SEARCH_MAX_SEC, PARALLEL_MIN_WORK_SEC,
	PARALLEL_QUIET_WINDOW_SEC } from './audio-segments';

/** SwiftF0 內部一次推論 20 秒；短於這個長度時，新增 Worker 的初始化成本通常高於收益。 */
export const PITCH_MIN_WORK_SEC = PARALLEL_MIN_WORK_SEC;
/** 在理想平均切點左右搜尋最低音壓的範圍，上限避免各段長度失衡。 */
export const PITCH_CUT_SEARCH_MAX_SEC = PARALLEL_CUT_SEARCH_MAX_SEC;
/** 兩側各保留 4096 samples（256ms／16 格）上下文，與 SwiftF0 內部分塊相同。 */
export const PITCH_CONTEXT_SAMPLES = 4096;
/** 切點使用連續一秒平均 RMS 最低區間的正中央。 */
export const PITCH_QUIET_WINDOW_SEC = PARALLEL_QUIET_WINDOW_SEC;

export interface PitchAnalysisSegment {
	coreFrom: number;
	coreTo: number;
	readFrom: number;
	readTo: number;
	cutRms: number | null;
}

/**
 * 依 Worker 數切成等量的核心工作。每個理想切點附近找「完整一秒 RMS 最低」
 * 的視窗並取正中央，最後對齊 SwiftF0 的 256-sample hop。
 */
export function planPitchAnalysisSegments(audio: Float32Array, requestedSegments: number,
	options: { minWorkSeconds?: number; searchMaxSeconds?: number; forceCount?: boolean } = {}): PitchAnalysisSegment[] {
	const minWorkSeconds = options.minWorkSeconds ?? PITCH_MIN_WORK_SEC;
	const searchMax = options.searchMaxSeconds ?? PITCH_CUT_SEARCH_MAX_SEC;
	const planned = planBalancedAudioSegments([audio], SR, {
		segmentCount: requestedSegments, minWorkSeconds, searchMaxSeconds: searchMax,
		windowSeconds: PITCH_QUIET_WINDOW_SEC, hopSeconds: HOP / SR, forceCount: options.forceCount,
	});
	return planned.map((segment, index) => {
		const coreFrom = index === 0 ? 0 : alignSample(segment.start * SR, audio.length);
		const coreTo = index === planned.length - 1 ? audio.length : alignSample(segment.end * SR, audio.length);
		return {
			coreFrom, coreTo,
			readFrom: Math.max(0, coreFrom - PITCH_CONTEXT_SAMPLES),
			readTo: Math.min(audio.length, coreTo + PITCH_CONTEXT_SAMPLES),
			cutRms: segment.cutRms,
		};
	});
}

export function mergePitchSegments(audioLength: number, segments: readonly PitchAnalysisSegment[],
	results: readonly PitchTrack[]): PitchTrack {
	const length = Math.max(1, Math.floor((audioLength - HOP) / HOP) + 1);
	const f0 = new Float32Array(length), confidence = new Float32Array(length), voiced = new Uint8Array(length);
	for (let job = 0; job < segments.length; job++) {
		const segment = segments[job], result = results[job];
		for (let i = 0; i < result.length; i++) {
			const sample = segment.readFrom + i * HOP;
			if (sample < segment.coreFrom || sample >= segment.coreTo) continue;
			const target = sample / HOP;
			if (!Number.isInteger(target) || target < 0 || target >= length) continue;
			f0[target] = result.f0[i]; confidence[target] = result.confidence[i]; voiced[target] = result.voiced[i];
		}
	}
	return { f0, confidence, voiced, length };
}

function alignSample(value: number, length: number) {
	return Math.max(0, Math.min(length, Math.round(value / HOP) * HOP));
}
