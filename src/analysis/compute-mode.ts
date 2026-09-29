export type ComputeMode = 'gpu' | 'wasm';
export type ComputeBackend = 'webgpu' | 'wasm';
export interface BackendStatus {
	backend: ComputeBackend;
	fallback: boolean;
	reason?: string;
}

/** GPU 初始化或推論失敗時，用全新的 WASM Worker 從頭重算一次。 */
export async function withWasmFallback<T>(
	mode: ComputeMode,
	run: (backend: ComputeBackend) => Promise<T>,
	onFallback: (reason: string) => void,
): Promise<T> {
	if (mode === 'wasm') return run('wasm');
	try { return await run('webgpu'); }
	catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		onFallback(reason);
		return run('wasm');
	}
}
