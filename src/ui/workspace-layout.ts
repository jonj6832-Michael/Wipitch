/**
 * 使用者可切換的工作區版面。
 *
 * 這是純顯示偏好：不讀取音訊、曲線、選取範圍或工作狀態。工作區值由 body 的
 * data-workspace 驅動 CSS，並保存在瀏覽器本機，重新載入時仍維持使用者上次的選擇。
 */
export const WORKSPACE_IDS = ['workstation', 'focus', 'readable', 'guide'] as const;
export type WorkspaceId = typeof WORKSPACE_IDS[number];

const STORAGE_KEY = 'wipitch.workspace-layout.v1';
const DEFAULT_WORKSPACE: WorkspaceId = 'workstation';

export interface WorkspaceLayoutEvents {
	changed?(workspace: WorkspaceId): void;
}

function isWorkspaceId(value: string | null): value is WorkspaceId {
	return value !== null && (WORKSPACE_IDS as readonly string[]).includes(value);
}

export class WorkspaceLayoutView {
	private select: HTMLSelectElement;
	private workspace: WorkspaceId = DEFAULT_WORKSPACE;

	constructor(root: HTMLElement, private events: WorkspaceLayoutEvents = {}) {
		this.select = root.querySelector<HTMLSelectElement>('#workspace-layout')!;
		this.workspace = this.readPreference();
		this.render();
		this.select.addEventListener('change', () => {
			this.setWorkspace(this.select.value);
		});
	}

	get current(): WorkspaceId { return this.workspace; }

	setWorkspace(value: string): void {
		if (!isWorkspaceId(value) || value === this.workspace) {
			this.render();
			return;
		}
		this.workspace = value;
		this.writePreference(value);
		this.render();
		this.events.changed?.(value);
	}

	private render(): void {
		document.body.dataset.workspace = this.workspace;
		this.select.value = this.workspace;
	}

	private readPreference(): WorkspaceId {
		try {
			const value = localStorage.getItem(STORAGE_KEY);
			return isWorkspaceId(value) ? value : DEFAULT_WORKSPACE;
		} catch {
			return DEFAULT_WORKSPACE;
		}
	}

	private writePreference(value: WorkspaceId): void {
		try { localStorage.setItem(STORAGE_KEY, value); } catch { /* 私密模式或受限儲存空間時仍可切換。 */ }
	}
}
