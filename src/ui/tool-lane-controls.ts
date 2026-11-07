import { LANES, LANE_IDS, type LaneId } from '../model/curves';

export type EditorTool = 'select' | 'pen';

export interface ToolLaneEvents {
	selectTool(tool: EditorTool): void;
	selectLane(id: LaneId): void;
	toggleLane(id: LaneId): void;
}

/** 工具與 lane 按鈕的獨立顯示模組；編輯狀態由呼叫端傳入。 */
export class ToolLaneControlsView {
	private select: HTMLButtonElement;
	private pen: HTMLButtonElement;

	constructor(private options: {
		root: HTMLElement;
		pitchTrack: HTMLElement;
		waveTrack: HTMLElement;
		laneRoot?: HTMLElement;
		events: ToolLaneEvents;
	}) {
		this.select = options.root.querySelector<HTMLButtonElement>('#tool-select')!;
		this.pen = options.root.querySelector<HTMLButtonElement>('#tool-pen')!;
		this.select.addEventListener('click', () => options.events.selectTool('select'));
		this.pen.addEventListener('click', () => options.events.selectTool('pen'));
		const laneRoot = options.laneRoot;
		for (const id of laneRoot ? LANE_IDS : []) {
			const chip = document.createElement('div');
			chip.className = 'lane-chip';
			chip.innerHTML =
				`<button class="eye" data-eye="${id}" title="顯示 ${LANES[id].label}（Shift+${LANE_IDS.indexOf(id) + 1}）">●</button>` +
				`<button class="pick" data-pick="${id}" title="編輯 ${LANES[id].label}（${LANE_IDS.indexOf(id) + 1}）">${LANES[id].label}</button>`;
			laneRoot!.appendChild(chip);
			const eye = chip.querySelector<HTMLElement>('.eye')!;
			eye.style.color = LANES[id].color;
			eye.addEventListener('click', () => options.events.toggleLane(id));
			chip.querySelector('.pick')!.addEventListener('click', () => options.events.selectLane(id));
		}
	}

	setTool(tool: EditorTool) {
		this.select.classList.toggle('on', tool === 'select');
		this.pen.classList.toggle('on', tool === 'pen');
		this.options.pitchTrack.classList.toggle('pen', tool === 'pen');
		this.options.waveTrack.classList.toggle('pen', tool === 'pen');
	}

	syncLanes(active: LaneId, visible: ReadonlySet<LaneId>) {
		if (!this.options.laneRoot) return;
		for (const id of LANE_IDS) {
			this.options.laneRoot.querySelector(`[data-eye="${id}"]`)!.classList.toggle('on', visible.has(id));
			this.options.laneRoot.querySelector(`[data-pick="${id}"]`)!.classList.toggle('on', active === id);
		}
	}

	setDisabled(disabled: boolean) { this.select.disabled = this.pen.disabled = disabled; }
}
