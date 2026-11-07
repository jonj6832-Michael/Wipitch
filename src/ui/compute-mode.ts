import type { BackendStatus, ComputeMode } from '../analysis/compute-mode';

const STORAGE_KEY = 'wipitch.compute-mode';
export class ComputeModeControl {
	mode: ComputeMode = 'gpu';
	private backend: BackendStatus | null = null;
	setMode(mode: ComputeMode) {
		this.mode = mode;
		this.select.value = mode;
		try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* 私密模式仍可使用。 */ }
		this.ready();
	}
	constructor(private select: HTMLSelectElement, private status: HTMLElement, private isBusy: () => boolean) {
		try { if (localStorage.getItem(STORAGE_KEY) === 'wasm') this.mode = 'wasm'; } catch { /* 私密模式仍可使用。 */ }
		select.value = this.mode;
		select.addEventListener('change', () => {
			if (this.isBusy()) { select.value = this.mode; return; }
			this.setMode(select.value === 'wasm' ? 'wasm' : 'gpu');
		});
		this.ready(); this.sync();
	}
	private ready() {
		this.status.textContent = this.mode === 'gpu' ? '下次分析：GPU 優先' : '下次分析：CPU';
		this.status.title = '僅影響 SwiftF0 音高分析；切換於下一次分析生效，不會重算目前編輯';
	}
	sync() {
		this.select.disabled = this.isBusy();
		this.select.title = this.select.disabled ? '運算中，完成後可切換' : '閒置時可切換；下一次音高分析生效';
	}
	start() {
		this.backend = null;
		this.status.textContent = this.mode === 'gpu' ? '準備 GPU 分析' : '準備 CPU 分析';
		this.status.title = '';
	}
	report(status: BackendStatus) {
		this.backend = status;
		this.status.textContent = status.backend === 'webgpu' ? '本次：WebGPU + WASM' : status.fallback ? '本次：CPU（GPU 回退）' : '本次：CPU / WASM';
		this.status.title = status.reason ?? (status.backend === 'webgpu' ? 'WebGPU 優先，不支援的運算由 WASM 補足' : '使用 CPU 進行音高分析');
	}
	finish(success: boolean) {
		if (!success) this.status.textContent = '音檔載入／分析失敗';
		else if (this.backend) this.status.textContent = this.status.textContent.replace('本次：', '上次：');
	}
}
