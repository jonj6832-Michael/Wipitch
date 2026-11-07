// 大型音訊的 SwiftF0 平行分析。每個 Worker 只初始化一次模型，再連續處理多個分段。
import type { PitchTrack } from './swiftf0';
import SwiftF0Worker from './swiftf0.worker?worker';
import SwiftF0GpuWorker from './swiftf0-gpu.worker?worker';
import { withWasmFallback, type BackendStatus, type ComputeBackend, type ComputeMode } from './compute-mode';
import { mergePitchSegments, planPitchAnalysisSegments, PITCH_QUIET_WINDOW_SEC,
	PITCH_CUT_SEARCH_MAX_SEC, PITCH_MIN_WORK_SEC } from './pitch-segments';
import { availableParallelWorkers } from './audio-segments';

export interface ParallelPitchInfo {
	segments: number;
	workers: number;
	hardwareConcurrency: number;
	minWorkSeconds: number;
	cutSearchSeconds: number;
	quietWindowSeconds: number;
	backend: ComputeBackend;
}

export interface ParallelPitchOptions {
	mode?: ComputeMode;
	onProgress?: (fraction: number) => void;
	onStage?: (stage: string) => void;
	onBackend?: (status: BackendStatus) => void;
	onPlan?: (info: ParallelPitchInfo) => void;
	/** 測試可指定分段數；產品流程由可用 CPU／GPU Worker 數決定。 */
	segmentCount?: number;
	minWorkSeconds?: number;
	cutSearchSeconds?: number;
	forceSegmentCount?: boolean;
	workerLimit?: number;
}

export async function detectPitchParallel(audio: Float32Array, options: ParallelPitchOptions = {}): Promise<PitchTrack> {
	let fallbackReason: string | undefined;
	return withWasmFallback(options.mode ?? 'wasm', backend => runPool(audio, backend, options, fallbackReason), reason => {
		fallbackReason = reason;
		options.onStage?.('GPU 無法使用，改用多 Worker CPU 重新分析');
		options.onProgress?.(0);
		options.onBackend?.({ backend: 'wasm', fallback: true, reason });
	});
}

async function runPool(audio: Float32Array, backend: ComputeBackend, options: ParallelPitchOptions,
	fallbackReason?: string): Promise<PitchTrack> {
	const hardware = availableParallelWorkers('cpu');
	// WASM Worker 各自使用一個 CPU 工作槽；WebGPU Worker 則共用同一個 GPU 裝置。
	const automaticLimit = availableParallelWorkers(backend === 'webgpu' ? 'gpu' : 'cpu');
	const limit = Math.max(1, Math.min(automaticLimit, options.workerLimit ?? automaticLimit));
	const requestedSegments = Math.max(1, options.segmentCount ?? limit);
	const minWorkSeconds = options.minWorkSeconds ?? PITCH_MIN_WORK_SEC;
	const cutSearchSeconds = options.cutSearchSeconds ?? PITCH_CUT_SEARCH_MAX_SEC;
	const segments = planPitchAnalysisSegments(audio, requestedSegments, {
		minWorkSeconds, searchMaxSeconds: cutSearchSeconds, forceCount: options.forceSegmentCount,
	});
	if (!segments.length) throw new Error('缺少音高分析音訊');
	const workerCount = Math.min(limit, segments.length);
	options.onStage?.(`建立 ${workerCount} 個音高分析 Worker`);
	const links = Array.from({ length: workerCount }, () => new PitchWorkerLink(backend));
	try {
		await Promise.all(links.map(link => link.ready));
		options.onBackend?.({ backend, fallback: fallbackReason !== undefined, reason: fallbackReason });
		options.onPlan?.({ segments: segments.length, workers: workerCount,
			hardwareConcurrency: hardware, minWorkSeconds, cutSearchSeconds,
			quietWindowSeconds: PITCH_QUIET_WINDOW_SEC, backend });
		options.onStage?.(`平行分析音高（${segments.length} 段／${workerCount} Worker）`);

		const results: PitchTrack[] = Array.from({ length: segments.length });
		const fractions = new Float64Array(segments.length);
		const weights = segments.map(segment => segment.coreTo - segment.coreFrom);
		const totalWeight = weights.reduce((sum, value) => sum + value, 0);
		let next = 0;
		const progress = () => options.onProgress?.(fractions.reduce((sum, fraction, i) => sum + fraction * weights[i], 0) / totalWeight);
		await Promise.all(links.map(async link => {
			while (true) {
				const index = next++;
				if (index >= segments.length) return;
				const segment = segments[index];
				const slice = audio.slice(segment.readFrom, segment.readTo);
				results[index] = await link.analyse(index, slice, fraction => { fractions[index] = fraction; progress(); });
				fractions[index] = 1; progress();
			}
		}));
		return mergePitchSegments(audio.length, segments, results);
	} finally {
		links.forEach(link => link.terminate());
	}
}

class PitchWorkerLink {
	private worker: Worker;
	private active: { id: number; resolve: (track: PitchTrack) => void; reject: (error: Error) => void;
		onProgress: (fraction: number) => void } | null = null;
	private readyResolve!: () => void;
	private readyReject!: (error: Error) => void;
	readonly ready: Promise<void>;

	constructor(backend: ComputeBackend) {
		this.worker = backend === 'webgpu' ? new SwiftF0GpuWorker() : new SwiftF0Worker();
		this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
		const fail = (error: Error) => {
			this.readyReject(error); this.active?.reject(error); this.active = null; this.worker.terminate();
		};
		this.worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || '音高 Worker 無法啟動')); };
		this.worker.onmessageerror = () => fail(new Error('音高 Worker 資料傳輸失敗'));
		this.worker.onmessage = event => {
			const data = event.data;
			if (data.type === 'ready') { this.readyResolve(); return; }
			if (data.type === 'error') { fail(new Error(data.error)); return; }
			if (!this.active || data.id !== this.active.id) return;
			if (data.type === 'progress') { this.active.onProgress(data.progress); return; }
			if (data.type === 'result') {
				const active = this.active; this.active = null;
				active.resolve({ f0: data.f0, confidence: data.confidence, voiced: data.voiced, length: data.length });
			}
		};
		this.worker.postMessage({ type: 'init', modelUrl: new URL('models/swift_f0.onnx', document.baseURI).href });
	}

	async analyse(id: number, audio: Float32Array, onProgress: (fraction: number) => void): Promise<PitchTrack> {
		await this.ready;
		return new Promise((resolve, reject) => {
			this.active = { id, resolve, reject, onProgress };
			this.worker.postMessage({ type: 'analyse', id, audio }, [audio.buffer]);
		});
	}

	terminate() {
		this.worker.terminate();
		this.active?.reject(new Error('音高分析已停止'));
		this.active = null;
	}
}

