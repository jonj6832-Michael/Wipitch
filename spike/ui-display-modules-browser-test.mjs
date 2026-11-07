import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
	const page = await browser.newPage();
	await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded' });
	const result = await page.evaluate(async () => {
		const helpHtml = await fetch('/help.html').then(response => response.text());
		const appLayout = {
			toolsAfterKey: document.querySelector('#key-filter-control')?.nextElementSibling?.id === 'lane-bar',
			laneButtonsRemoved: document.querySelector('#lane-chips') === null,
			buildTime: document.querySelector('#build-version')?.textContent ?? '',
			buildIsNotLink: document.querySelector('#build-version')?.closest('a') === null,
			helpPath: new URL(document.querySelector('#help-link').href).pathname,
			helpIsLocal: helpHtml.includes('<title>WiPitch 使用說明</title>'),
			workspaceSelector: document.querySelector('#workspace-layout') instanceof HTMLSelectElement,
		};
		const [{ EditInspectorView }, { ToolLaneControlsView }, { TransportView }, { ReferenceTrackControlsView }, { HeaderPanelView }, { AIToolbarView }, { EditorOptionsView }, { GlobalControlsView }, { DetectionControlsView }, { LoadReportView }, { WorkspaceLayoutView }, { AIRegionOverlay }, { bindZoomGesture }, { Curves }] = await Promise.all([
			import('/src/ui/edit-inspector.ts'), import('/src/ui/tool-lane-controls.ts'), import('/src/ui/transport.ts'), import('/src/ui/reference-track-controls.ts'),
			import('/src/ui/header-panel.ts'), import('/src/ui/ai-toolbar.ts'), import('/src/ui/editor-options.ts'), import('/src/ui/global-controls.ts'), import('/src/ui/detection-controls.ts'), import('/src/ui/load-report.ts'),
			import('/src/ui/workspace-layout.ts'),
			import('/src/ui/ai-regions.ts'), import('/src/ui/zoom-gesture.ts'), import('/src/model/curves.ts'),
		]);
		const host = document.createElement('div');
		host.innerHTML = `
			<header><time id="build-version"></time><label id="workspace-selector"><select id="workspace-layout"><option value="workstation">完整工作站</option><option value="focus">專注編輯</option><option value="readable">高可讀性</option></select></label><button id="open-audio"></button><input id="file" type="file"><button id="export"></button><button id="save"></button><input id="open-project" type="file"><button id="mode-voice"></button><button id="mode-instrument"></button><span id="status"></span><span id="hint"></span><span id="bg-status"><span id="bg-text"></span></span></header>
			<div id="ai-toolbar"><button id="ai-settings-open"></button><input id="ai-strength" value="5"><output id="ai-strength-value"></output><button id="ai-correct"></button><button id="ai-undo"></button><button id="ai-clear-marks"></button><button id="ai-cancel"></button><span id="ai-service"></span><span id="ai-status"></span></div>
			<div id="pitch-toolbar"><select id="key-filter"><option value="">全部音</option></select><div id="pen-opts"><input id="vib-depth" value=".5"><input id="vib-rate" value="5.5"><input id="vib-onset" value="200"><input id="vib-on" type="checkbox"><input id="vib-onset-on" type="checkbox" checked><span id="vib-unit"></span></div></div>
			<footer id="global"><input id="ramp"><input id="slope"><button data-reset="pitch"></button><button data-reset="all"></button><button id="clear-sel"></button></footer>
			<div id="detection-tools"><span id="detection-status"></span><button id="detection-all"></button><button id="detection-clear"></button></div><details id="load-timings"><summary></summary><pre></pre></details>
			<div id="fixture-panel"><span id="sel-info"></span>
				<div data-lane="pitch"><input id="shift" min="-12" max="12"><output id="shift-out"></output><input id="flatten" min="0" max="4"><output id="flatten-out"></output><button data-nudge="1"></button></div>
				<div data-lane="gain"><input id="gain" min="-24" max="12"><output id="gain-out"></output></div>
				<div data-lane="formant"><input id="formant" min="-12" max="12"><output id="formant-out"></output></div>
			</div>
			<div id="tools"><button id="tool-select"></button><button id="tool-pen"></button></div><div id="lanes"></div><div id="pitch"></div><div id="wave"></div>
			<div id="transport"><button id="play"></button><button id="stop"></button><button id="loop-btn"></button><button id="follow-btn"></button><span id="clock"></span></div>
			<div id="reference"><label><span id="bg-file-text"></span><input type="file" id="bg-file"></label><span id="bg-name"></span>
				<span id="bg-controls"><button id="bg-mute"></button><input id="bg-vol"><output id="bg-vol-out"></output>
				<button data-bg-nudge="-10"></button><input id="bg-offset"><button data-bg-nudge="10"></button><button id="bg-remove"></button></span></div>`;
		document.body.appendChild(host);
		localStorage.removeItem('wipitch.workspace-layout.v1');
		const workspaceEvents = [];
		const workspace = new WorkspaceLayoutView(host.querySelector('#workspace-selector'), { changed: value => workspaceEvents.push(value) });
		host.querySelector('#workspace-layout').value = 'focus'; host.querySelector('#workspace-layout').dispatchEvent(new Event('change'));
		workspace.setWorkspace('readable');
		const panelEvents = [];
		const header = new HeaderPanelView(host.querySelector('header'), { selectAudio: () => panelEvents.push('file'), openAudio: () => panelEvents.push('open'), exportWav: () => panelEvents.push('export'), saveProject: () => panelEvents.push('save'), openProject: () => panelEvents.push('project'), setFormantFollow: value => panelEvents.push(`mode:${value}`) });
		header.setBuildVersion('建置 fixture'); header.setStatus('ready'); header.setHint('hint'); header.setBackgroundProgress('背景精算 50%'); header.setFormantFollow(1);
		host.querySelector('#open-audio').click(); host.querySelector('#export').click(); host.querySelector('#save').click(); host.querySelector('#mode-instrument').click();
		const aiEvents = [];
		const aiToolbar = new AIToolbarView(host.querySelector('#ai-toolbar'), { openSettings: () => aiEvents.push('settings'), changeStrength: value => aiEvents.push(`strength:${value}`), correct: () => aiEvents.push('correct'), discard: () => aiEvents.push('discard'), complete: () => aiEvents.push('complete'), cancel: () => aiEvents.push('cancel') });
		aiToolbar.setService('本機'); aiToolbar.setStatus('ready'); aiToolbar.setStrengthDisplay({ text: '5 / 10', title: 'test', ariaValueText: 'five' }); aiToolbar.setControls({ disabled: false, correct: false, correctTitle: 'go', discard: false, discardTitle: 'undo', complete: false }); aiToolbar.setBusy(true);
		host.querySelector('#ai-strength').value = '7'; host.querySelector('#ai-strength').dispatchEvent(new Event('input')); host.querySelector('#ai-correct').click(); host.querySelector('#ai-undo').click(); host.querySelector('#ai-clear-marks').click(); host.querySelector('#ai-cancel').click(); host.querySelector('#ai-settings-open').click();
		const optionEvents = [];
		const editorOptions = new EditorOptionsView(host.querySelector('#pitch-toolbar'), { keyChanged: value => optionEvents.push(`key:${value}`) });
		editorOptions.populateKeys([{ id: 'major', label: '大調' }], [{ id: 'c-major', label: 'C 大調', mode: 'major' }]); host.querySelector('#key-filter').value = 'c-major'; host.querySelector('#key-filter').dispatchEvent(new Event('change')); editorOptions.setLaneUnit('pitch', '半音'); editorOptions.toggleVibrato(false);
		const globalEvents = [];
		const global = new GlobalControlsView(host.querySelector('#global'), { changeSlope: value => globalEvents.push(`slope:${value}`), changeRamp: value => globalEvents.push(`ramp:${value}`), reset: lane => globalEvents.push(`reset:${lane}`), clearSelection: () => globalEvents.push('clear') });
		global.setRampMilliseconds(120); global.setSlope(80); global.setSelectionActive(true); host.querySelector('#ramp').dispatchEvent(new Event('change')); host.querySelector('#slope').dispatchEvent(new Event('change')); host.querySelector('[data-reset="pitch"]').click(); host.querySelector('#clear-sel').click();
		const detectionEvents = []; const detection = new DetectionControlsView(host.querySelector('#detection-tools'), { detectAll: () => detectionEvents.push('all'), clear: () => detectionEvents.push('clear') }); detection.setStatus('range'); host.querySelector('#detection-all').click(); host.querySelector('#detection-clear').click();
		const report = new LoadReportView(host.querySelector('#load-timings')); report.show('載入耗時 1 秒', '測試資料');
		const events = [];
		const inspector = new EditInspectorView(host.querySelector('#fixture-panel'), {
			preview: (key, params) => events.push(`preview:${key}:${params[key]}`),
			commit: (key, _label, params) => events.push(`commit:${key}:${params[key]}`),
		});
		inspector.setSelectionLabel('1.00 ~ 2.00'); inspector.setLane('gain'); inspector.setParam('shift', 2, true);
		const laneEvents = [];
		const lanes = new ToolLaneControlsView({ root: host.querySelector('#tools'), pitchTrack: host.querySelector('#pitch'), waveTrack: host.querySelector('#wave'), laneRoot: host.querySelector('#lanes'),
			events: { selectTool: tool => laneEvents.push(`tool:${tool}`), selectLane: lane => laneEvents.push(`lane:${lane}`), toggleLane: lane => laneEvents.push(`toggle:${lane}`) } });
		lanes.setTool('pen'); lanes.syncLanes('gain', new Set(['pitch', 'gain']));
		host.querySelector('[data-pick="formant"]').click(); host.querySelector('[data-eye="pitch"]').click();
		const transportEvents = [];
		const transport = new TransportView(host.querySelector('#transport'), { playPause: () => transportEvents.push('play'), stop: () => transportEvents.push('stop'), toggleLoop: () => transportEvents.push('loop'), toggleFollow: () => transportEvents.push('follow') });
		transport.setPlaying(true); transport.setLoop(true); transport.setFollow(true); transport.setPosition('1:23.456');
		host.querySelector('#play').click(); host.querySelector('#stop').click(); host.querySelector('#loop-btn').click(); host.querySelector('#follow-btn').click();
		const referenceEvents = [];
		const reference = new ReferenceTrackControlsView(host.querySelector('#reference'), {
			load: file => referenceEvents.push(`load:${file.name}`), remove: () => referenceEvents.push('remove'), toggleMute: () => referenceEvents.push('mute'),
			changeGain: gain => referenceEvents.push(`gain:${gain}`), changeOffset: offset => referenceEvents.push(`offset:${offset}`),
		});
		reference.render({ name: 'Guide.wav', gainDb: -3.5, muted: true, offsetSec: 0.025 });
		host.querySelector('#bg-mute').click(); host.querySelector('#bg-remove').click();
		host.querySelector('#bg-vol').value = '-6'; host.querySelector('#bg-vol').dispatchEvent(new Event('input'));
		host.querySelector('[data-bg-nudge="10"]').click();
		const overlayHost = document.createElement('div'); host.appendChild(overlayHost);
		const overlayEvents = [];
		const overlay = new AIRegionOverlay(overlayHost,
			async (_region, enabled, pitch, formant) => { overlayEvents.push(`change:${enabled}:${pitch}:${formant}`); },
			(_region, _enabled, _pitch, formant) => { if (formant !== undefined) overlayEvents.push(`preview:${formant}`); });
		const overlayCurves = new Curves(100);
		const region = { id: 1, from: 10, to: 90, kind: 'center', enabled: true, edited: false, offset: 0, formantOffset: 0,
			original: new Float32Array(80), ai: new Float32Array(80), adjusted: new Float32Array(80), originalFormant: new Float32Array(80), aiFormant: new Float32Array(80), adjustedFormant: new Float32Array(80), recordId: 'test' };
		overlay.draw([region], overlayCurves, new Float32Array(100), t => t * 100, { lo: 48, hi: 72 }, 300, false);
		const yellowBox = overlayHost.querySelector('.ai-region');
		const zoomEvents = [];
		bindZoomGesture(overlay.gestureTarget, factor => zoomEvents.push(factor), () => true);
		yellowBox.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
		const formantSlider = overlayHost.querySelector('.ai-region-formant input'); formantSlider.value = '1.5';
		formantSlider.dispatchEvent(new Event('input', { bubbles: true })); formantSlider.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise(resolve => setTimeout(resolve, 0));
		return {
			appLayout,
			events, label: host.querySelector('#shift-out').textContent, selection: host.querySelector('#sel-info').textContent,
			gainVisible: !host.querySelector('[data-lane="gain"]').hidden, pitchVisible: !host.querySelector('[data-lane="pitch"]').hidden,
			laneEvents, chipCount: host.querySelectorAll('.lane-chip').length, pen: host.querySelector('#pitch').classList.contains('pen'), activeGain: host.querySelector('[data-pick="gain"]').classList.contains('on'),
			transportEvents, playText: host.querySelector('#play').textContent, loopOn: host.querySelector('#loop-btn').classList.contains('on'), followOn: host.querySelector('#follow-btn').classList.contains('on'), clock: host.querySelector('#clock').textContent,
			referenceEvents, referenceName: host.querySelector('#bg-name').textContent, referenceMuted: host.querySelector('#bg-mute').classList.contains('on'), referenceGain: host.querySelector('#bg-vol-out').textContent, referenceOffset: host.querySelector('#bg-offset').value,
			zoomEvents, overlayEvents, formantValue: overlayHost.querySelector('.ai-region-formant output').textContent,
			panelEvents, aiEvents, optionEvents, globalEvents, detectionEvents,
			workspaceEvents, workspace: workspace.current, workspaceData: document.body.dataset.workspace, storedWorkspace: localStorage.getItem('wipitch.workspace-layout.v1'),
			headerStatus: host.querySelector('#status').textContent, headerMode: host.querySelector('#mode-instrument').classList.contains('on'), aiStatus: host.querySelector('#ai-status').textContent, aiBusy: host.querySelector('#ai-correct').getAttribute('aria-busy'), keyLabel: editorOptions.keyLabel, penEnabled: editorOptions.pen.enabled, ramp: host.querySelector('#ramp').value, detectionStatus: host.querySelector('#detection-status').textContent, reportSummary: host.querySelector('#load-timings summary').textContent,
		};
	});
	assert.equal(result.appLayout.toolsAfterKey, true); assert.equal(result.appLayout.laneButtonsRemoved, true);
	assert.match(result.appLayout.buildTime, /^建置 \d{4}\/\d{2}\/\d{2}.+\d{2}:\d{2}:\d{2}$/); assert.equal(result.appLayout.buildIsNotLink, true);
	assert.equal(result.appLayout.helpPath, '/help.html'); assert.equal(result.appLayout.helpIsLocal, true);
	assert.equal(result.appLayout.workspaceSelector, true);
	assert.deepEqual(result.events, ['preview:shift:2', 'commit:shift:2']);
	assert.equal(result.label, '+2.00 半音'); assert.equal(result.selection, '1.00 ~ 2.00');
	assert.equal(result.gainVisible, true); assert.equal(result.pitchVisible, false);
	assert.equal(result.chipCount, 3); assert.equal(result.pen, true); assert.equal(result.activeGain, true);
	assert.deepEqual(result.laneEvents, ['lane:formant', 'toggle:pitch']);
	assert.deepEqual(result.transportEvents, ['play', 'stop', 'loop', 'follow']);
	assert.equal(result.playText, '‖'); assert.equal(result.loopOn, true); assert.equal(result.followOn, true); assert.equal(result.clock, '1:23.456');
	assert.deepEqual(result.referenceEvents, ['mute', 'remove', 'gain:-6', 'offset:0.035']);
	assert.equal(result.referenceName, 'Guide.wav'); assert.equal(result.referenceMuted, true); assert.equal(result.referenceGain, '-3.5 dB'); assert.equal(result.referenceOffset, '25');
	assert.equal(result.zoomEvents.length, 1); assert.ok(result.zoomEvents[0] < 1);
	assert.deepEqual(result.overlayEvents, ['preview:1.5', 'change:true:0:1.5']); assert.equal(result.formantValue, '+1.5');
	assert.deepEqual(result.panelEvents, ['open', 'export', 'save', 'mode:1']); assert.equal(result.headerStatus, 'ready'); assert.equal(result.headerMode, true);
	assert.deepEqual(result.aiEvents, ['strength:7', 'correct', 'discard', 'complete', 'cancel', 'settings']); assert.equal(result.aiStatus, 'ready'); assert.equal(result.aiBusy, 'true');
	assert.deepEqual(result.optionEvents, ['key:c-major']); assert.equal(result.keyLabel, 'C 大調'); assert.equal(result.penEnabled, true);
	assert.deepEqual(result.globalEvents, ['ramp:120', 'slope:80', 'reset:pitch', 'clear']); assert.equal(result.ramp, '120');
	assert.deepEqual(result.detectionEvents, ['all', 'clear']); assert.equal(result.detectionStatus, 'range'); assert.equal(result.reportSummary, '載入耗時 1 秒');
	assert.deepEqual(result.workspaceEvents, ['focus', 'readable']); assert.equal(result.workspace, 'readable'); assert.equal(result.workspaceData, 'readable'); assert.equal(result.storedWorkspace, 'readable');
	console.log('PASS: display modules remain independent, workspaces persist, and AI yellow boxes preserve timeline zoom gestures');
} finally { await browser.close(); }
