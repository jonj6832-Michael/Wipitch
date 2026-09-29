/** Bind wheel / trackpad pinch without allowing the browser to zoom the page. */
export function bindZoomGesture(
	element: HTMLElement,
	zoom: (factor: number, clientY: number) => void,
	enabled: () => boolean,
) {
	let gestureScale: number | null = null;
	element.addEventListener('wheel', e => {
		if (!enabled()) return;
		e.preventDefault();
		// Safari can report both gesture events and Ctrl+wheel for the same pinch.
		if (gestureScale !== null && e.ctrlKey) return;
		const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? element.clientHeight : 1;
		zoom(Math.exp(Math.max(-2, Math.min(2, delta * unit * 0.003))), e.clientY);
	}, { passive: false });
	// Safari uses GestureEvent; Chromium trackpad pinch arrives as Ctrl+wheel above.
	type PinchEvent = Event & { scale: number; clientY: number };
	element.addEventListener('gesturestart', event => {
		if (!enabled()) return;
		event.preventDefault();
		gestureScale = (event as PinchEvent).scale || 1;
	}, { passive: false });
	element.addEventListener('gesturechange', event => {
		if (!enabled() || gestureScale === null) return;
		event.preventDefault();
		const e = event as PinchEvent;
		if (Number.isFinite(e.scale) && e.scale > 0) {
			zoom(gestureScale / e.scale, e.clientY);
			gestureScale = e.scale;
		}
	}, { passive: false });
	element.addEventListener('gestureend', event => {
		if (gestureScale !== null) event.preventDefault();
		gestureScale = null;
	}, { passive: false });
}
