import type { Source } from './audio/decode';
import type { PitchTrack } from './analysis/swiftf0';

/** 所有主音檔入口共用；失敗也必須解鎖。 */
export class LoadGuard {
	busy = false;
	async run(task: () => Promise<void>, onBusy: (busy: boolean) => void): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		try { onBusy(true); await task(); }
		finally { this.busy = false; onBusy(false); }
		return true;
	}
}

/** GPU → WASM 回退包含在 analyse 內；只有最終成功才清除來源的分析暫存。 */
export async function analyseSource(source: Source, analyse: (audio: Float32Array) => Promise<PitchTrack>) {
	if (!source.mono16k) throw new Error('缺少音高分析音訊');
	const releasedBytes = source.mono16k.byteLength;
	const track = await analyse(source.mono16k);
	source.mono16k = null;
	return { track, releasedBytes };
}

export class LoadTimings {
	private started: number;
	private stageStart: number;
	private current = '';
	private rows: { stage: string; ms: number }[] = [];
	constructor(private now = () => performance.now()) {
		this.started = this.stageStart = now();
	}
	stage(name: string) {
		if (name === this.current) return;
		const at = this.now();
		if (this.current) this.rows.push({ stage: this.current, ms: at - this.stageStart });
		this.current = name;
		this.stageStart = at;
	}
	finish() {
		this.stage('');
		return { totalMs: this.stageStart - this.started, stages: this.rows.map(row => ({ ...row })) };
	}
}
