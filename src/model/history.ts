// 復原／重做堆疊。
//
// 存的是整條曲線的快照，不是「動作」——因為曲線本身就是完整的編輯狀態，
// 存快照最單純，也不會有「反向動作算錯」的問題。
// 做法與 pitchmark.py 的 Session.snapshot() 相同。
import { Curves } from './curves';

const MAX_STEPS = 50;

export class History {
	/** 過去的狀態，最後一個是「上一步」 */
	private stack: Curves[] = [];
	/** 被復原掉的狀態，最後一個是「下一步」 */
	private redoStack: Curves[] = [];

	reset(_initial: Curves) {
		this.stack = [];
		this.redoStack = [];
	}

	/**
	 * 在改動生效「之後」呼叫，把改動前的完整狀態存起來。
	 *
	 * 一定要傳完整的 Curves，不能只傳 pitch。先前的版本是
	 * 「複製當下的曲線再蓋掉 pitch」，結果 gain 存到的是改動「之後」的值，
	 * 音量的編輯因此完全無法復原。
	 */
	push(before: Curves) {
		this.stack.push(before.clone());
		if (this.stack.length > MAX_STEPS) this.stack.shift();
		// 有新的編輯就不能再往前重做了
		this.redoStack = [];
	}

	/**
	 * 回到上一步。要傳入「目前」的狀態，這樣才能重做回來。
	 * 沒得復原就回 null。
	 */
	undo(current: Curves): Curves | null {
		const prev = this.stack.pop();
		if (!prev) return null;
		this.redoStack.push(current.clone());
		return prev;
	}

	/** 重做。同樣要傳入目前的狀態。 */
	redo(current: Curves): Curves | null {
		const next = this.redoStack.pop();
		if (!next) return null;
		this.stack.push(current.clone());
		return next;
	}

	get depth() { return this.stack.length; }
	get redoDepth() { return this.redoStack.length; }

	/** Drop steps created after a temporary review mode while preserving older edits. */
	truncate(depth: number) {
		this.stack.length = Math.max(0, Math.min(this.stack.length, depth));
		this.redoStack = [];
	}
}
