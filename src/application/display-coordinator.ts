import type { Curves } from '../model/curves';
import type { AIRegion } from '../model/ai-regions';
import type { ReferenceBeatRecord } from '../model/reference-beat-table';
import type { WaveformView, RefWaveformView } from '../view/waveform';
import type { PianoRollView } from '../view/pianoroll';
import type { AIRegionOverlay } from '../ui/ai-regions';

type TimeRange = { start: number; end: number };

export interface DisplayState {
	loaded: boolean;
	selection: TimeRange | null;
	curves: Curves | null;
	previewCurves: Curves | null;
	renderingRange: TimeRange | null;
	selectedAnchors: ReadonlySet<number>;
	aiRegions: AIRegion[];
	pitchMidi: Float32Array | null;
	beatAnchor: number | null;
	barStarts: readonly number[];
	bpm: number;
	meter: string;
	analyzedBeats: boolean;
	beatRecords: readonly ReferenceBeatRecord[];
	locked: boolean;
}

interface DisplayPorts {
	readState(): DisplayState;
	playback: { readonly position: number; readonly loopRegion: TimeRange | null; tick(): void };
	waveform: Pick<WaveformView, 'draw'>;
	referenceWaveform: Pick<RefWaveformView, 'draw'>;
	pianoroll: Pick<PianoRollView, 'draw' | 'rangeOf'>;
	aiOverlay: Pick<AIRegionOverlay, 'draw' | 'clear'>;
	timeToX(time: number): number;
	pitchHeight(): number;
	setPosition(position: number): void;
	followPosition(position: number): void;
	autoScrollDrag(): void;
	syncControls(): void;
	syncNavigation(): void;
}

/** 協調顯示更新；只讀取狀態並呼叫 View，不執行音高／節拍分析。 */
export class DisplayCoordinator {
	private frameId: number | null = null;
	private running = false;

	constructor(private ports: DisplayPorts) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.frame();
	}

	stop(): void {
		this.running = false;
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		this.frameId = null;
	}

	private frame = (): void => {
		if (!this.running) return;
		this.update();
		if (this.running) this.frameId = requestAnimationFrame(this.frame);
	};

	update(): void {
		const p = this.ports;
		p.syncControls();
		if (!p.readState().loaded) {
			p.aiOverlay.clear();
			return;
		}
		const position = p.playback.position;
		p.setPosition(position);
		p.followPosition(position);
		p.autoScrollDrag();
		p.playback.tick();
		// 跟隨與拖曳可能改變狀態，於更新後取得同一幀的顯示資料。
		const s = p.readState();
		const loop = p.playback.loopRegion;
		p.waveform.draw(position, s.selection, s.curves, loop, s.renderingRange, s.selectedAnchors);
		p.referenceWaveform.draw(position, s.selection, loop, s.beatAnchor, s.barStarts, s.bpm, s.meter, s.analyzedBeats, s.beatRecords);
		const curves = s.previewCurves ?? s.curves;
		p.pianoroll.draw(position, s.selection, curves, loop, s.renderingRange, s.selectedAnchors);
		if (curves && s.pitchMidi) {
			p.aiOverlay.draw(s.aiRegions, curves, s.pitchMidi, p.timeToX,
				p.pianoroll.rangeOf('pitch'), p.pitchHeight(), s.locked);
		} else {
			p.aiOverlay.clear();
		}
		p.syncNavigation();
	}
}
