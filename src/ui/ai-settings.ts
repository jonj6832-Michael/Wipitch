import { DEFAULT_AI_SETTINGS, endpoint, listAIModels, type AISettings } from '../analysis/ai-correction';

const STORAGE_KEY = 'wipitch.ai-settings';
export class AISettingsView {
	settings: AISettings = { ...DEFAULT_AI_SETTINGS };
	private testing: AbortController | null = null;
	constructor(private dialog: HTMLDialogElement, private changed: () => void) {
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
			if (saved && ['builtin', 'ollama', 'openai'].includes(saved.provider) && typeof saved.baseUrl === 'string' && typeof saved.model === 'string') {
				this.settings = { provider: saved.provider, baseUrl: saved.baseUrl, model: saved.model, apiKey: '' };
			}
		} catch { /* 使用預設設定 */ }
		const provider = dialog.querySelector<HTMLSelectElement>('#ai-provider')!;
		const url = dialog.querySelector<HTMLInputElement>('#ai-url')!;
		const model = dialog.querySelector<HTMLInputElement>('#ai-model')!;
		const key = dialog.querySelector<HTMLInputElement>('#ai-api-key')!;
		const status = dialog.querySelector<HTMLElement>('#ai-settings-status')!;
		const test = dialog.querySelector<HTMLButtonElement>('#ai-test')!;
		const save = dialog.querySelector<HTMLButtonElement>('#ai-save')!;
		const read = (): AISettings => ({ provider: provider.value as AISettings['provider'], baseUrl: url.value.trim(), model: model.value.trim(), apiKey: key.value.trim() });
		const sync = () => {
			const off = provider.value === 'builtin';
			url.disabled = model.disabled = key.disabled = test.disabled = off;
			url.placeholder = provider.value === 'ollama' ? 'http://localhost:11434' : 'https://服務網址/v1';
		};
		provider.addEventListener('change', () => {
			this.testing?.abort(); this.testing = null;
			key.value = ''; model.value = ''; status.textContent = '';
			dialog.querySelector('#ai-models')!.replaceChildren();
			url.value = provider.value === 'ollama' ? 'http://localhost:11434' : '';
			sync();
		});
		test.addEventListener('click', async () => {
			const request = new AbortController(); this.testing = request;
			test.disabled = save.disabled = true; status.textContent = '讀取模型清單中…';
			try {
				const names = await listAIModels(read(), request.signal);
				if (request.signal.aborted) return;
				const list = dialog.querySelector('#ai-models')!;
				list.replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; return option; }));
				status.textContent = `連線成功，找到 ${names.length} 個模型。請選擇或填入模型名稱。`;
			} catch (error) { if (!request.signal.aborted) status.textContent = error instanceof Error ? error.message : '連線失敗'; }
			finally { if (this.testing === request) this.testing = null; save.disabled = false; sync(); }
		});
		dialog.querySelector('form')!.addEventListener('submit', event => {
			event.preventDefault();
			try {
				const next = read();
				if (next.provider !== 'builtin') {
					endpoint(next);
					if (!next.model) throw new Error('請填入模型名稱');
				}
				this.settings = next;
				// 憑證僅存在分頁記憶體，不寫入 localStorage 或專案檔。
				try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: next.provider, baseUrl: next.baseUrl, model: next.model })); } catch { /* 仍可使用本次設定 */ }
				this.changed(); dialog.close();
			} catch (error) { status.textContent = error instanceof Error ? error.message : '設定不正確'; }
		});
		dialog.querySelector('#ai-close')!.addEventListener('click', () => dialog.close());
		dialog.addEventListener('close', () => { this.testing?.abort(); this.testing = null; });
		dialog.addEventListener('keydown', event => event.stopPropagation());
		this.populate = () => {
			provider.value = this.settings.provider; url.value = this.settings.baseUrl;
			model.value = this.settings.model; key.value = this.settings.apiKey;
			status.textContent = ''; sync();
		};
	}
	private populate: () => void;
	open() { this.populate(); this.dialog.showModal(); }
	get label() { return this.settings.provider === 'builtin' ? '內建調性修正（不連線）' : `${this.settings.provider === 'ollama' ? 'Ollama' : 'API'} · ${this.settings.model || '未設定模型'}`; }
}
