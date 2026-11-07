import assert from 'node:assert/strict';
import { bindZoomGesture } from '../src/ui/zoom-gesture.ts';
import { ViewState } from '../src/view/viewstate.ts';
import { PianoRollView } from '../src/view/pianoroll.ts';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
class Target extends EventTarget { clientHeight = 300; }
const target = new Target();
let enabled = true;
const calls = [];
bindZoomGesture(target, (...args) => calls.push(args), () => enabled);
function emit(type, props = {}) {
 const e = new Event(type, { cancelable: true });
 Object.assign(e, props); target.dispatchEvent(e); return e;
}
assert.ok(emit('wheel', { deltaY: -100, deltaX: 0, deltaMode: 0, clientX: 70, clientY: 80 }).defaultPrevented);
assert.ok(calls[0][0] < 1); assert.equal(calls[0][1], 70); assert.equal(calls[0][2], 80);
emit('wheel', { deltaY: 100, deltaX: 0, deltaMode: 0, clientY: 80, ctrlKey: true });
assert.ok(calls[1][0] > 1);
emit('gesturestart', { scale: 1 });
emit('gesturechange', { scale: 2, clientX: 75, clientY: 90 }); assert.equal(calls[2][0], 0.5); assert.equal(calls[2][1], 75);
emit('wheel', { deltaY: 1, ctrlKey: true }); assert.equal(calls.length, 3);
emit('gesturechange', { scale: 4, clientX: 75, clientY: 90 }); assert.equal(calls[3][0], 0.5);
emit('gestureend');
enabled = false;
assert.equal(emit('wheel', { deltaY: 100 }).defaultPrevented, false);
assert.equal(calls.length, 4);
const view = new ViewState(); view.duration = 100; view.startSec = 10; view.secPerPx = .05;
const pointerX = view.timeToX(25); view.zoomAt(pointerX, .5, 1000);
near(view.timeToX(25), pointerX); near(view.secPerPx, .025);
const piano = new PianoRollView({ getContext: () => ({}) }, view, {});
const before = piano.yToMidi(90, 300); piano.zoomV(.5, 90, 300);
near(piano.yToMidi(90, 300), before);
near(piano.rangeOf('pitch').hi - piano.rangeOf('pitch').lo, 12);
console.log('PASS: wheel, Ctrl+wheel, pinch, duplicate suppression, disabled handling, horizontal and vertical anchors');
