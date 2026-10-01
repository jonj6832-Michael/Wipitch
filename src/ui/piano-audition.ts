import { NotePreview } from '../audio/note-preview';

export function bindPianoAudition(root: HTMLElement, showPressed: (midi: number | null) => void, onError: (error: unknown) => void) {
	const synth = new NotePreview();
	let stopNote: (() => void) | null = null;
	let pointer: number | null = null;
	let keyboardKey: string | null = null;
	const stop = () => {
		stopNote?.(); stopNote = null;
		keyboardKey = null;
		const id = pointer; pointer = null;
		if (id !== null && root.hasPointerCapture(id)) root.releasePointerCapture(id);
		showPressed(null);
	};
	const keyAt = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('.piano-key[data-midi]') : null;
	const start = (key: HTMLElement) => {
		const midi = Number(key.dataset.midi);
		if (!Number.isInteger(midi) || midi < 0 || midi > 127) return;
		showPressed(midi);
		stopNote = synth.start(midi, error => { stop(); onError(error); });
	};
	root.addEventListener('pointerdown', e => {
		const key = keyAt(e.target);
		if (e.button !== 0 || !key) return;
		e.preventDefault(); stop();
		pointer = e.pointerId;
		root.setPointerCapture(e.pointerId);
		start(key);
	});
	for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
		root.addEventListener(type, e => { if (e.pointerId === pointer) stop(); });
	}
	root.addEventListener('keydown', e => {
		const key = keyAt(e.target);
		if (!key || (e.code !== 'Space' && e.code !== 'Enter')) return;
		e.preventDefault(); e.stopPropagation();
		if (e.repeat) return;
		stop(); keyboardKey = e.code; start(key);
	});
	root.addEventListener('keyup', e => {
		if (e.code !== 'Space' && e.code !== 'Enter') return;
		e.preventDefault(); e.stopPropagation();
		if (e.code === keyboardKey) stop();
	});
	root.addEventListener('focusout', () => { if (keyboardKey) stop(); });
	window.addEventListener('blur', stop);
	window.addEventListener('pagehide', stop);
	document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
}
