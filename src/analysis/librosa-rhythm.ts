import type { RhythmRequest, RhythmResult } from './reference-rhythm.worker';

/** Librosa is authoritative for reference-track beat extraction. */
export async function detectLibrosaRhythm(request: RhythmRequest): Promise<RhythmResult> {
	const body = new ArrayBuffer(request.audio.byteLength);
	new Float32Array(body).set(request.audio);
	const params = new URLSearchParams({
		sampleRate: '16000',
		anchorSec: String(request.anchorSec),
		bpm: String(request.bpm),
		meter: request.meter,
		bpmTolerance: String(Math.min(0.10,Math.max(0.01,request.bpmTolerance))),
		onsetProminence: String(request.onsetProminence),
		confirmationThreshold: String(request.confirmationThreshold),
		instrumentProfile: request.instrumentProfile === 'rhythm' ? 'rhythm' : 'melody',
	});
	const url = `/__analysis/librosa-rhythm?${params}`;
	const send = () => fetch(url, {
		method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
	});
	let response: Response;
	try { response = await send(); }
	catch {
		// Vite 更新設定時可能短暫重啟；只對網路層錯誤重試一次。
		await new Promise(resolve => setTimeout(resolve, 300));
		try { response = await send(); }
		catch (error) {
			throw new Error(`無法連線到 Librosa 節拍分析服務（${location.origin}）：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!response.ok) {
		let detail = '';
		try { detail = ((await response.json()) as { error?: string }).error ?? ''; } catch { /* plain error */ }
		if (detail) {
			console.error('Librosa rhythm error:', detail);
			const summary = detail.trim().split('\n').filter(Boolean).at(-1) ?? detail;
			throw new Error(`Librosa 節拍分析失敗：${summary}`);
		}
		throw new Error(`Librosa 節拍分析失敗（HTTP ${response.status}）`);
	}
	const result = await response.json() as Omit<RhythmResult, 'beatHarmony'>;
	return { ...result, beatHarmony: [] };
}
