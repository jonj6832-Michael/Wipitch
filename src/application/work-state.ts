export type WorkKind = 'load' | 'project' | 'reference' | 'main-pitch' | 'reference-pitch' | 'rhythm' | 'render' | 'background' | 'ai' | 'export';
export interface WorkProgress {
	readonly label: string;
	readonly fraction: number | null;
	readonly error: boolean;
	readonly active: boolean;
}
export interface WorkSnapshot {
	readonly kinds: readonly WorkKind[];
	readonly isBusy: boolean;
	readonly blocksEditing: boolean;
	readonly progress: WorkProgress;
}
export interface WorkTask {
	update(label: string, fraction?: number | null): void;
	finish(label: string, error?: boolean): void;
}

/** 應用層工作登錄。背景工作允許編輯；匯出會鎖定編輯，但允許背景精算完成。 */
export class WorkState {
	private nextId = 0;
	private tasks = new Map<number, { kind: WorkKind; label: string; fraction: number | null }>();
	private listeners = new Set<(snapshot: WorkSnapshot) => void>();
	private result = { label: '等待載入音檔', fraction: 0 as number | null, error: false };
	get isBusy() { return this.tasks.size > 0; }
	has(kind: WorkKind) { return [...this.tasks.values()].some(task => task.kind === kind); }
	get blocksEditing() { return [...this.tasks.values()].some(task => task.kind !== 'background'); }
	get blocksBackground() { return [...this.tasks.values()].some(task => task.kind !== 'background' && task.kind !== 'export'); }
	canStart(kind: WorkKind) {
		if (this.has(kind)) return false;
		if (kind === 'background') return !this.blocksBackground;
		if (kind === 'render' || kind === 'export') return !this.blocksEditing;
		return !this.isBusy;
	}
	tryBegin(kind: WorkKind, label: string): WorkTask | null {
		return this.canStart(kind) ? this.begin(kind, label) : null;
	}
	/** 已取得外層工作權限時可登錄子工作，例如專案載入中的算繪。 */
	begin(kind: WorkKind, label: string): WorkTask {
		const id = ++this.nextId;
		this.tasks.set(id, { kind, label, fraction: null });
		this.emit();
		return {
			update: (label, fraction = null) => {
				const task = this.tasks.get(id);
				if (!task) return;
				task.label = label;
				task.fraction = fraction === null || !Number.isFinite(fraction) ? null : Math.max(0, Math.min(1, fraction));
				this.emit();
			},
			finish: (label, error = false) => {
				if (!this.tasks.delete(id)) return;
				this.result = { label, fraction: error ? 0 : 1, error };
				this.emit();
			},
		};
	}
	get snapshot(): WorkSnapshot {
		const active = [...this.tasks.values()].reverse();
		const task = active.find(t => t.kind !== 'background') ?? active[0];
		const analyses = active.filter(t => t.kind === 'main-pitch' || t.kind === 'reference-pitch' || t.kind === 'rhythm');
		return Object.freeze({
			kinds: Object.freeze(active.map(t => t.kind)), isBusy: this.isBusy, blocksEditing: this.blocksEditing,
			progress: Object.freeze(task
				? { label: analyses.length ? analyses.map(t => t.label).join(' ｜ ') : task.label,
					fraction: analyses.length ? analyses.reduce((sum, t) => sum + (t.fraction ?? 0), 0) / analyses.length : task.fraction, error: false, active: true }
				: { ...this.result, active: false }),
		});
	}
	subscribe(listener: (snapshot: WorkSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => { this.listeners.delete(listener); };
	}
	private emit() {
		const snapshot = this.snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}
}
