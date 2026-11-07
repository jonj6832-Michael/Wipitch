import type { LaneId } from '../model/curves';

export type EditParamKey = 'shift' | 'alpha' | 'gainDb' | 'formant';
export type EditParams = Record<EditParamKey, number>;

const META: Record<EditParamKey, { input: string; output: string; label: string }> = {
	shift: { input: '#shift', output: '#shift-out', label: '音高' },
	alpha: { input: '#flatten', output: '#flatten-out', label: '抖動' },
	gainDb: { input: '#gain', output: '#gain-out', label: '音量' },
	formant: { input: '#formant', output: '#formant-out', label: 'Formant' },
};

export interface EditInspectorEvents {
	preview(key: EditParamKey, params: Readonly<EditParams>): void;
	commit(key: EditParamKey, label: string, params: Readonly<EditParams>): void | Promise<void>;
}

/**
 * 選取參數面板的獨立顯示模組。
 *
 * 它只保存控制項目前顯示的相對參數並發出 preview／commit 意圖；不認識
 * Curves、History、Renderer 或工作鎖，實際修改與提交仍由應用層決定。
 */
export class EditInspectorView {
	readonly params: EditParams = { shift: 0, alpha: 1, gainDb: 0, formant: 0 };
	private inputs = {} as Record<EditParamKey, HTMLInputElement>;
	private outputs = {} as Record<EditParamKey, HTMLOutputElement>;
	private selectionInfo: HTMLElement;

	constructor(readonly root: HTMLElement, private events: EditInspectorEvents) {
		this.selectionInfo = root.querySelector<HTMLElement>('#sel-info')!;
		for (const key of Object.keys(META) as EditParamKey[]) {
			const meta = META[key];
			const input = this.inputs[key] = root.querySelector<HTMLInputElement>(meta.input)!;
			this.outputs[key] = root.querySelector<HTMLOutputElement>(meta.output)!;
			input.addEventListener('input', () => {
				this.params[key] = Number.parseFloat(input.value);
				this.syncLabels();
				this.events.preview(key, this.params);
			});
			input.addEventListener('change', () => { void this.events.commit(key, meta.label, this.params); });
		}
		root.querySelectorAll<HTMLElement>('[data-nudge]').forEach(button => {
			button.addEventListener('click', () => {
				const amount = Number.parseFloat(button.dataset.nudge!);
				this.setParam('shift', this.params.shift + amount, true);
			});
		});
		this.reset();
	}

	setParam(key: EditParamKey, value: number, commit = false) {
		const input = this.inputs[key];
		const min = Number.parseFloat(input.min), max = Number.parseFloat(input.max);
		const next = Math.max(Number.isFinite(min) ? min : -Infinity, Math.min(Number.isFinite(max) ? max : Infinity, value));
		input.value = String(next);
		this.params[key] = next;
		this.syncLabels();
		this.events.preview(key, this.params);
		if (commit) void this.events.commit(key, META[key].label, this.params);
	}

	commit(key: EditParamKey) { void this.events.commit(key, META[key].label, this.params); }

	reset() {
		Object.assign(this.params, { shift: 0, alpha: 1, gainDb: 0, formant: 0 });
		this.inputs.shift.value = '0'; this.inputs.alpha.value = '1';
		this.inputs.gainDb.value = '0'; this.inputs.formant.value = '0';
		this.syncLabels();
	}

	setSelectionLabel(text: string) { this.selectionInfo.textContent = text; }
	setLane(id: LaneId) {
		this.root.querySelectorAll<HTMLElement>('[data-lane]').forEach(group => { group.hidden = group.dataset.lane !== id; });
	}
	setVisible(visible: boolean) { this.root.hidden = !visible; }
	setInert(inert: boolean) { this.root.inert = inert; }

	private syncLabels() {
		const p = this.params;
		this.outputs.shift.textContent = `${p.shift >= 0 ? '+' : ''}${p.shift.toFixed(2)} 半音`;
		this.outputs.alpha.textContent = `${p.alpha.toFixed(2)}×`;
		this.outputs.gainDb.textContent = `${p.gainDb >= 0 ? '+' : ''}${p.gainDb.toFixed(1)} dB`;
		this.outputs.formant.textContent = `${p.formant >= 0 ? '+' : ''}${p.formant.toFixed(2)} 半音`;
	}
}
