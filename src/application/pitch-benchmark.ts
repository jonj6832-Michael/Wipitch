import { decodeFile } from '../audio/decode';
import { detectPitchParallel } from '../analysis/pitch-parallel';
import type { ComputeMode } from '../analysis/compute-mode';
import type { WorkState } from './work-state';
import type { ComputeModeControl } from '../ui/compute-mode';

/** 比較同一份 16 kHz 音訊的完整分析時間；不改動已載入的音軌。 */
export function installPitchBenchmark(root: HTMLElement, workState: WorkState, control: ComputeModeControl) {
	const button = root.querySelector<HTMLButtonElement>('#compute-benchmark')!;
	const input = root.querySelector<HTMLInputElement>('#compute-benchmark-file')!;
	const status = root.querySelector<HTMLElement>('#compute-benchmark-status')!;
	button.addEventListener('click', () => { if (!workState.isBusy) input.click(); });
	workState.subscribe(() => { button.disabled = workState.isBusy; });
	input.addEventListener('change', async () => {
		const file = input.files?.[0]; input.value = '';
		if (!file) return;
		const task = workState.tryBegin('load', 'GPU／CPU 音高測速');
		if (!task) { status.textContent = '請等待目前工作完成後再測速'; return; }
		try {
			status.textContent = '正在解碼測試音訊…';
			const source = await decodeFile(file);
			const audio = source.mono16k;
			if (!audio?.length) throw new Error('音檔沒有可分析的內容');
			const results: Partial<Record<ComputeMode, number>> = {};
			const errors: string[] = [];
			for (const mode of ['gpu', 'wasm'] as const) {
				let fallback = false;
				status.textContent = `正在測試 ${mode === 'gpu' ? 'GPU' : 'CPU'}…`;
				const start = performance.now();
				try {
					await detectPitchParallel(audio.slice(), {
						mode,
						onBackend: state => { if (mode === 'gpu' && state.backend !== 'webgpu') fallback = true; },
						onProgress: fraction => task.update(`測試 ${mode === 'gpu' ? 'GPU' : 'CPU'} 音高分析`, fraction),
					});
					if (fallback) errors.push('GPU 回退 CPU，未列入 GPU 成績');
					else results[mode] = performance.now() - start;
				} catch (error) {
					errors.push(`${mode === 'gpu' ? 'GPU' : 'CPU'} 失敗：${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const selected = results.gpu === undefined ? 'wasm'
				: results.wasm === undefined || results.gpu < results.wasm ? 'gpu' : 'wasm';
			if (results[selected] === undefined) throw new Error(errors.join('；') || '兩種模式均未成功');
			control.setMode(selected);
			const format = (ms: number | undefined) => ms === undefined ? '不可用' : `${(ms / 1000).toFixed(2)} 秒`;
			status.textContent = `GPU ${format(results.gpu)}；CPU ${format(results.wasm)}。下次使用${selected === 'gpu' ? ' GPU' : ' CPU'}。${errors.join('；')}`;
		} catch (error) {
			status.textContent = `測速失敗：${error instanceof Error ? error.message : String(error)}`;
		} finally {
			task.finish('音高測速結束');
		}
	});
}
