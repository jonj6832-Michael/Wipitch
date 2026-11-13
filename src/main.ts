import { ruleMinimumDurationMs } from './model/rule-selection';
import { installPitchBenchmark } from './application/pitch-benchmark';
import { DisplayCoordinator } from './application/display-coordinator';
import { createAIRegions, createManualAIRegion, manualSelectionBoundsAt, regionCurves, resetAIRegionToAI, reviewedAIRegions, syncAIRegion, type AIRegion } from './model/ai-regions';
import { AIRegionOverlay } from './ui/ai-regions';
import { installTrainingLibrary } from './ui/training-library';
import { prepareTrainingPair, stageTrainingPair, storeRejectedTrainingPair, resetTrainingStaging, commitTrainingStaging } from './training/recorder';
import type { Diagnostics } from './dev/diagnostics';
import { decodeFile, decodeAudio, fmtTime, type Source } from './audio/decode';
import { detectLibrosaBeatHarmony } from './analysis/librosa-chords';
import { detectLibrosaRhythm } from './analysis/librosa-rhythm';
import { ViewState } from './view/viewstate';
import { WaveformView, RefWaveformView, drawOverview } from './view/waveform';
import { RangeBar } from './view/rangebar';
import { PianoRollView } from './view/pianoroll';
import { KEY_MODES, KEY_OPTIONS } from './model/keys';
import { Player } from './engine/player';
import { Renderer } from './engine/renderer';
import { detectPitchParallel } from './analysis/pitch-parallel';
import { createReferenceCache, createSpectralFluxOnsets, findOnset, type ReferenceCache, type ReferenceRhythm } from './analysis/reference-cache';
import { referenceBeatPreview } from './model/reference-beat-preview';
import { clearReferenceBeatsInRange, hasReferenceBeatsInRange, mergeReferenceBeats, referenceBeatInRange, referenceRhythmForRange, restoreReferenceBeats, shiftReferenceBeats, type ReferenceBeatRecord } from './model/reference-beat-table';
import { referenceBeatGrid } from './model/reference-beat-grid';
import { averageBarBpm } from './analysis/bar-tempo';
import { hzToMidi, midiToName, type PitchTrack } from './analysis/swiftf0';
import { Curves, LANES, LANE_IDS, PEN_RAMP_SEC, DEFAULT_PITCH_SLOPE_LIMIT, CURVE_HOP_SEC, CURVE_SUB, upsample, upsampleVoiced, type LaneId } from './model/curves';
import { offsetLane, resetLane, resetAll, drawLane, flattenRange, fillGaps, limitSlope, slopeMarginFrames } from './model/edits';
import { History } from './model/history';
import { TimeMap } from './model/timemap';
import { encodeWav24, downloadBlob } from './audio/wav';
import { serialize, deserialize, inspectProject, type BackgroundSettings } from './model/project';
import { findLocalDetectionFile, hasLocalFileAccess, overwriteLocalAudio, pickLocalAudio, readLocalAudio, writeLocalDetectionFile } from './local-audio';
import { ProgressView } from './ui/progress';
import { WorkState, type WorkTask } from './application/work-state';
import { bindZoomGesture } from './ui/zoom-gesture';
import { DetectionBar } from './ui/detection-bar';
import { ComputeModeControl } from './ui/compute-mode';
import { bindPianoAudition } from './ui/piano-audition';
import { LoadTimings, analyseSource } from './loading';
import { AICorrectionFlow, type CorrectionInput } from './application/ai-correction-flow';
import { AISettingsView } from './ui/ai-settings';
import { updateBuiltinAIModel } from './analysis/builtin-ai';
import { availableParallelWorkers, planBalancedAudioSegments } from './analysis/audio-segments';
import { collectCorrectionNotesParallel } from './analysis/ai-candidate-pool';
import { chordPitchClasses } from './model/reference-harmony';
import { EditInspectorView, type EditParamKey } from './ui/edit-inspector';
import { ToolLaneControlsView, type EditorTool } from './ui/tool-lane-controls';
import { TransportView } from './ui/transport';
import { ReferenceTrackControlsView } from './ui/reference-track-controls';
import { HeaderPanelView } from './ui/header-panel';
import { AIToolbarView } from './ui/ai-toolbar';
import { EditorOptionsView } from './ui/editor-options';
import { GlobalControlsView } from './ui/global-controls';
import { DetectionControlsView } from './ui/detection-controls';
import { LoadReportView } from './ui/load-report';
import { WorkspaceLayoutView } from './ui/workspace-layout';
import { GuideModeView } from './ui/guide-mode';

const el = {
	stage: document.getElementById('stage')!,
	pitchTrack: document.getElementById('pitch-track')!,
	waveform: document.getElementById('waveform') as HTMLCanvasElement,
	pianoroll: document.getElementById('pianoroll') as HTMLCanvasElement,
	pianoKeys: document.getElementById('piano-keys')!,
	hbar: document.getElementById('hbar')!,
	vbar: document.getElementById('vbar')!,
	globalBar: document.getElementById('global-bar')!,
	waveTrack: document.getElementById('wave-track')!,
	waveSplitter: document.getElementById('wave-splitter')!,
	ampZoom: document.getElementById('amp-zoom') as HTMLInputElement,
	refwave: document.getElementById('refwave') as HTMLCanvasElement,
	refSplitter: document.getElementById('ref-splitter')!,
	refAmpZoom: document.getElementById('ref-amp-zoom') as HTMLInputElement,
};

const headerPanel = new HeaderPanelView(document.querySelector('header')!, {
	selectAudio: file => { void load(file); },
	openAudio: () => { void openLocalAudio(); },
	exportWav: () => { void exportWav(); },
	overwriteOriginal: () => { void overwriteOriginalAudio(); },
	saveProject: () => { void saveProject(); },
	openProject: file => { void openProject(file); },
	setFormantFollow: follow => { void setMode(follow); },
});
headerPanel.setBuildVersion(`建置 ${__BUILD_TIME__}`);

const guideMode = new GuideModeView(document.getElementById('guide-dialog')!, {
	hasMainAudio: () => !!source,
	hasReferenceAudio: () => !!ref.name,
	openMainAudio: () => document.getElementById('open-audio')?.click(),
	openReferenceAudio: () => document.getElementById('bg-file')?.click(),
	startReferenceAnalysis: analyzeReferenceTrack,
	startAI: startAICorrection,
	completeAI: completeAIReview,
	getRange: () => detectionBar.range,
	hasKey: () => !!editorOptions.keyValue,
	hasAnchor: () => ref.beatAnchorSecs.length > 0,
	hasBeats: () => {
		const range = detectionBar.range;
		return !!range && hasReferenceBeatsInRange(referenceBeatRecords, range);
	},
	hasAIRegions: () => aiRegions.length > 0,
	hasAIReview: () => !!aiReview,
	hasCompletedAI: () => !aiReview && aiRegions.length === 0,
	resetRange: () => { detectionBar.set(null); clearSelection(); },
});
// 引導模式與完整工作站等版面同屬正式工作區；選擇會保存在本機。
const workspaceLayout = new WorkspaceLayoutView(document.getElementById('workspace-selector')!, {
	changed: workspace => {
		if (workspace === 'guide') guideMode.open();
		else guideMode.close();
	},
});
// 從本機偏好還原引導工作區時，等模組內所有音訊／AI 狀態完成初始化後再讀取步驟條件。
if (workspaceLayout.current === 'guide') queueMicrotask(() => guideMode.open());
installTrainingLibrary(document.getElementById('training-library-open')!);

const aiToolbar = new AIToolbarView(document.getElementById('ai-toolbar')!, {
	openSettings: () => aiSettings.open(),
	changeStrength: updateAIStrengthText,
	correct: () => { void startAICorrection(); },
	discard: () => { void discardAICorrection(); },
	complete: () => { void completeAIReview(); },
	cancel: cancelAICorrection,
});

const view = new ViewState();
const waveform = new WaveformView(el.waveform, view);
const refWave = new RefWaveformView(el.refwave, view);
const pianoroll = new PianoRollView(el.pianoroll, view, el.pianoKeys);
const editorOptions = new EditorOptionsView(document.getElementById('pitch-toolbar')!, {
	keyChanged: value => {
		pianoroll.setKeyFilter(KEY_OPTIONS.find(key => key.id === value) ?? null);
		updateDetectionStatus();
	},
});
editorOptions.populateKeys(KEY_MODES, KEY_OPTIONS);
const globalControls = new GlobalControlsView(el.globalBar, {
	changeSlope: setPitchSlopeLimit,
	changeRamp: setRampMilliseconds,
	reset: lane => { void resetSelectionLane(lane); },
	clearSelection: () => { clearSelection(); hint(''); },
});
const player = new Player();
let renderer = new Renderer();
const history = new History();
const workState = new WorkState();
const progressView = new ProgressView(document.getElementById('progress')!);
let renderProgress: WorkTask | null = null;
let backgroundTask: WorkTask | null = null;

let source: Source | null = null;
let sourceAbsolutePath: string | null = null;
let sourceWritebackPath: string | null = null;
let manualBaseline: Curves | null = null;
let aiRegions: AIRegion[] = [];
let aiPreviewCurves: Curves | null = null;
type TimeRange = { start:number; end:number };
type AIReviewSource = { input:CorrectionInput; proposal:Curves; keyLabel:string };
let aiReview: {
	baseline: Curves;
	audio: Map<number, { start:number; end:number; channels: import('./types').Samples[] }>;
	historyDepth:number;
	sources: Map<number, AIReviewSource>;
	runs: AIReviewSource[];
} | null = null;

let stagedTrainingCount = 0;
let trainingAsset: { id: string; name: string; size: number; lastModified: number } | null = null;
const trainingStatus = document.createElement('div');
trainingStatus.id = 'training-status';
trainingStatus.setAttribute('role', 'status');
trainingStatus.textContent = '手動修音記錄：匯出 WAV 時儲存';
document.body.appendChild(trainingStatus);
let track: PitchTrack | null = null;
let curves: Curves | null = null;
let selection: { start: number; end: number } | null = null;
let baseInfo = '';
let aiReady = false;
const computeControl = new ComputeModeControl(
	document.getElementById('compute-mode') as HTMLSelectElement,
	document.getElementById('compute-status')!,
	() => workState.isBusy,
);
installPitchBenchmark(document.getElementById('compute-control')!, workState, computeControl);

let tool: EditorTool = 'select';
/** 正在算繪的時間範圍（秒）。畫在兩個 canvas 上，讓使用者看得到「是這一段在跑」 */
let renderingRange: { start: number; end: number } | null = null;
/** 偵測到的音高，換算成 MIDI 半音刻度。壓平與畫筆都要用。 */
/** 偵測音高（MIDI）內插到曲線格（2ms）上，索引跟 curves 一致 */
let pitchMidi: Float32Array | null = null;
/** 發聲旗標放到曲線格上，索引跟 curves 一致 */
let curveVoiced: Uint8Array | null = null;
/**
 * pitchMidi 的未發聲空隙用兩側的值線性內插補滿。畫筆換算 Δ 用這一份。
 *
 * 畫筆以前遇到未發聲的格子就跳過不改，交界一側是畫的值、另一側是舊值（常常是 0），
 * Δ 在那裡是一個階梯。SwiftF0 常把音符起音的前一兩格判成未發聲，所以階梯正好落在
 * 「起音之後」——算繪出來起音的前 ~20ms 就是沒被移調的聲音
 * （spike/onset-truth.mjs：+12 半音的階梯晚 20ms，起音前 20ms 平均差 504 cents）。
 */
let pitchMidiFilled: Float32Array | null = null;

/**
 * 目前選取範圍在「還沒被面板參數改動」時的曲線狀態。
 *
 * 選取存在期間這份快照**不會更新**，所有面板參數都是從它重新套用一次。
 * 這就是「參數是活的」的關鍵：滑桿可以自由來回拉、互相疊加，
 * 拉回中性值就逐位元等於選取當下的狀態，不會像舊版那樣每動一次就疊加一層。
 */
let selBase: Curves | null = null;
/** 這一輪選取編輯有沒有已經把 selBase 推進 undo 堆疊了 */
let sessionPushed = false;

const inspector = new EditInspectorView(document.getElementById('panel')!, {
	preview: () => applyParams(),
	commit: (key, label) => commitInspectorParam(key, label),
});
/** 面板上的活參數。狀態由顯示模組保存，應用層只讀取快照進行曲線運算。 */
const params = inspector.params;

const status = (msg: string) => { headerPanel.setStatus(msg); };

// ── 兩個時間軸 ──────────────────────────────────────────────────────────
//
// 曲線與音高偵測存在「原始時間」，畫面、播放頭、選取在「輸出時間」（time stretch 之後）。
// 所有要動曲線的地方都先經過 toSrc；所有要交給畫面或算繪器的時間都是輸出時間。

const toSrc = (t: number) => curves ? curves.timeMap.outToSrc(t) : t;
const toOut = (t: number) => curves ? curves.timeMap.srcToOut(t) : t;

/** 選取範圍換成原始時間 */
function srcSel(): { start: number; end: number } | null {
	return selection && { start: toSrc(selection.start), end: toSrc(selection.end) };
}

/** 伸縮之後的總長（秒） */
function outDuration(): number {
	if (!source) return 0;
	return curves ? curves.timeMap.srcToOut(source.duration) : source.duration;
}

const detectionControls = new DetectionControlsView(document.getElementById('detection-tools')!, {
	detectAll: () => { if (source) detectionBar.set({ start: 0, end: outDuration() }); },
	clear: () => detectionBar.set(null),
});
const detectionBar = new DetectionBar(document.getElementById('detection-bar')!, view, outDuration, range => {
	pianoroll.detectionRange = range;
	updateDetectionStatus(range);
	rebuildReferenceBars();
	syncAIControls();
});
function updateDetectionStatus(range = detectionBar.range) {
	const key = KEY_OPTIONS.find(key => key.id === editorOptions.keyValue);
	detectionControls.setStatus(range
		? `${fmtTime(range.start)} ~ ${fmtTime(range.end)} · ${key ? `${key.label} 檢測中` : '選擇 Key 啟用檢測'}`
		: '拖曳下方檢測 bar 設定範圍');
}

/** 目前被選取的錨點（id）。Shift+點擊可以多選；拖曳時一起移動，按 Delete 一起刪掉 */
const selectedAnchors = new Set<number>();

/**
 * 算繪進度。
 *
 * 一段長的畫筆或讀檔的整段重算要好幾秒，只有一行「算繪中…」的話，
 * 使用者分不出是在跑還是當掉了。除了進度條，還要在軌道上標出「哪一段在重算」。
 */
let diagnostics: Diagnostics | undefined;
function bindRendererCallbacks(target:Renderer){
	target.onProgress=f=>{diagnostics?.recordProgress();renderProgress?.update('音訊算繪中',f);};
	target.onBackground=syncBackgroundStatus;
}
bindRendererCallbacks(renderer);
function showProgress(range: { start: number; end: number } | null) {
	renderingRange = range;
	if (range) {
		renderProgress?.finish('上一項算繪已結束');
		renderProgress = workState.begin('render', '音訊算繪中');
		renderProgress.update('音訊算繪中', 0);
	}
}
function finishRenderProgress(label: string, error = false) {
	renderProgress?.finish(label, error);
	renderProgress = null;
}
const hint = (msg: string) => { headerPanel.setHint(msg); };
bindPianoAudition(el.pianoKeys, midi => pianoroll.setPressedMidi(midi), error => {
	hint(`琴鍵試聽失敗：${error instanceof Error ? error.message : String(error)}`);
}, loading => {
	hint(loading ? '鋼琴音色載入中…' : '鋼琴音色載入結束，可按琴鍵試聽。');
});

// ── 載入 ────────────────────────────────────────────────────────────────

const loadReport = new LoadReportView(document.getElementById('load-timings') as HTMLDetailsElement);
async function load(file: File, absolutePath: string | null = null, writebackPath: string | null = absolutePath,
	expected?:{audioSize?:number;audioSha256?:string;sampleRate:number;duration:number}): Promise<boolean> {
 if (!workState.canStart('load')) { hint('目前工作尚未完成，請等完成後再開啟音檔。'); return false; }

	const task = workState.tryBegin('load', '讀取音檔');
	if (!task) { hint('目前工作尚未完成，請等完成後再開啟音檔。'); return false; }
	let success = false;
	try {
	  const assetId = crypto.randomUUID();
	  success = await loadOnce(file, task, assetId, expected);
  if (success) {
   sourceAbsolutePath = absolutePath;
   sourceWritebackPath = writebackPath;
   trainingAsset = { id: assetId, name: file.name, size: file.size, lastModified: file.lastModified };
  }
 } catch (error) {
  const message = `開啟音檔失敗：${error instanceof Error ? error.message : String(error)}`;
  hint(message); task.finish(message, true);
 }
	finally {
		task.finish('讀取工作已結束');
	}
	return success;
}

async function loadOnce(file: File, progress: WorkTask, assetId: string,
	expected?:{audioSize?:number;audioSha256?:string;sampleRate:number;duration:number}): Promise<boolean> {
	const previousAIReady=aiReady;
	const previousBaseInfo=baseInfo;
	aiReady = false;
	const timings = new LoadTimings();
	let success = false, releasedBytes = 0;
	let candidateRenderer:Renderer|null=null;
	let failureLabel = '讀取失敗';
	let pitchPlanLabel = '';
	const computeMode = computeControl.mode;
	computeControl.start();
	loadReport.reset();
	status(`解碼 ${file.name}…`);
	try {
		const candidateSource = await decodeFile(file, (stage, fraction) => {
			timings.stage(stage);
			progress.update(stage, fraction);
		});
		if(expected){
			if(expected.audioSize!==undefined&&file.size!==expected.audioSize)throw new Error('音訊大小與檢測檔記錄不符');
			if(expected.audioSha256!==undefined&&candidateSource.contentSha256!==expected.audioSha256)throw new Error('音訊內容指紋與檢測檔記錄不符');
			if(candidateSource.sampleRate!==expected.sampleRate||Math.abs(candidateSource.duration-expected.duration)>.01)throw new Error('音訊規格與檢測檔記錄不符');
		}

		failureLabel = '初始化失敗';
		baseInfo = `${candidateSource.name} · ${candidateSource.sampleRate}Hz · ${fmtTime(candidateSource.duration)}`;
		status(`${baseInfo} · 偵測音高中…`);
		failureLabel = '音高分析失敗';
		progress.update('載入音高模型');
		timings.stage('啟動音高分析 Worker 與傳輸音訊');
		let backendLabel = computeMode === 'gpu' ? 'GPU 優先' : 'CPU';
		const result = await analyseSource(candidateSource, audio => detectPitchParallel(audio, {
			onProgress: f => {
			status(`${baseInfo} · 偵測音高中… ${(f * 100).toFixed(0)}%`);
			progress.update('分析音高', f);
		}, onStage: stage => {
			timings.stage(stage === '分析音高' ? `分析音高（${backendLabel}）` : stage);
			progress.update(stage);
		}, mode: computeMode, onBackend: state => {
			backendLabel = state.backend === 'webgpu' ? 'WebGPU + WASM' : 'CPU / WASM';
			computeControl.report(state);
		}, onPlan: plan => {
			pitchPlanLabel = `音高分段：${plan.segments} 段／${plan.workers} Worker（瀏覽器回報 ${plan.hardwareConcurrency} CPU 工作槽）／最低音壓窗 ${plan.quietWindowSeconds} 秒`;
			console.info('[WiPitch] parallel pitch plan', plan);
		} }));
		releasedBytes = result.releasedBytes;
		timings.stage('準備編輯曲線');
		failureLabel = '音高顯示初始化失敗';
		const candidateTrack=result.track;
		const candidateCurves=new Curves(candidateTrack.length*CURVE_SUB);
		const candidatePitchMidi=upsample(candidateTrack.f0.map(hzToMidi));
		const candidateVoiced=upsampleVoiced(candidateTrack.voiced);
		const candidateFilled=fillGaps(candidatePitchMidi,candidateVoiced,0,candidatePitchMidi.length);
		progress.update('初始化音訊引擎');
		timings.stage('初始化編輯引擎');
		candidateRenderer=new Renderer();
		candidateRenderer.formantFollow=renderer.formantFollow;
		await candidateRenderer.init(candidateSource.channels,candidateSource.sampleRate);
		// 直到候選音檔、音高與 Renderer 全部成功，才清除上一個工作階段的暫存。
		await resetTrainingStaging(assetId);

		const oldRenderer=renderer;
		renderer=candidateRenderer;candidateRenderer=null;bindRendererCallbacks(renderer);oldRenderer.dispose();
		source=candidateSource;track=candidateTrack;curves=candidateCurves;manualBaseline=curves.clone();
		pitchMidi=candidatePitchMidi;curveVoiced=candidateVoiced;pitchMidiFilled=candidateFilled;
		aiRegions=[];aiReview=null;aiOverlay.clear();aiPreviewCurves=null;
		stagedTrainingCount=0;trainingAsset=null;
		trainingStatus.textContent='AI 訓練暫存已清空，等待手動修音';
		clearSelection();selectedAnchors.clear();detectionBar.set(null);removeReference(false);
		history.reset(curves);syncRampInputs();pianoroll.setTrack(track);
		view.duration=source.duration;view.fit(el.waveform.clientWidth||1200);waveform.setSource(source);
		player.setAudio(renderer.rendered,renderer.sampleRate);
		el.stage.hidden=false;el.globalBar.hidden=false;transport.setEnabled(true);
		headerPanel.setActions({ canOpenAudio: true, canOpenProject: true, canExport: true,
			canOverwrite: false, canSave: true });
		diagnostics?.applyViewParams();
		status(baseInfo);
		progress.finish('讀取與音高分析完成');
		success = true;
		aiReady = true;
		hint('拖曳選取一段，用面板調整；1/2/3 切換音高・音量・Formant，B 切畫筆');
	} catch (e) {
		const message = `${failureLabel}：${e instanceof Error ? e.message : String(e)}`;
		baseInfo=previousBaseInfo;
		status(message);
		progress.finish(message, true);
	} finally {
		candidateRenderer?.dispose();
		if(!success)aiReady=previousAIReady;
		computeControl.finish(success);
		const report = { file: file.name, fileBytes: file.size, mode: computeMode, success, releasedAnalysisBytes: releasedBytes, ...timings.finish() };
		loadReport.show(`載入耗時 ${(report.totalMs / 1000).toFixed(2)} 秒${success ? '' : '（失敗）'}`, [
			file.name,
			...(pitchPlanLabel ? [pitchPlanLabel] : []),
			...report.stages.map(row => `${row.stage}：${(row.ms / 1000).toFixed(3)} 秒`),
			`已解除分析暫存引用：${(releasedBytes / 1048576).toFixed(1)} MiB`,
			'階段耗時含等待；暫存實際回收時間由瀏覽器決定。',
			].join('\n'));
		console.info('[WiPitch] load timing', report);
	}
	return success;
}

async function openLocalAudio() {
	if (!workState.canStart('load')) { hint('目前工作尚未完成，請等完成後再開啟音檔。'); return; }
	// 非本機或不具本機檔案 API 的靜態部署使用瀏覽器選檔。
	if (!['localhost', '127.0.0.1'].includes(location.hostname)||!await hasLocalFileAccess()) {
		document.querySelector<HTMLInputElement>('#file')!.click();
		return;
	}
	try {
		const picked = await pickLocalAudio();
		if (!picked) { hint('已取消開啟音檔'); return; }
		const file = await readLocalAudio(picked.path, picked);
		if(await load(file,picked.path)){
			try{
				const detectionFile=await findLocalDetectionFile(picked.path);
				if(detectionFile){hint(`找到同目錄檢測檔案 ${detectionFile.name}，正在一併載入…`);await openProject(detectionFile,true);}
				else hint('音檔已開啟；同目錄沒有相同檔名的 .wipitch.json');
			}catch(error){hint(`音檔已開啟，但自動讀取檢測檔案失敗：${error instanceof Error?error.message:String(error)}`);}
		}
	} catch (error) {
		hint(`開啟音檔失敗：${error instanceof Error ? error.message : String(error)}`);
	}
}

document.addEventListener('dragover', e => {
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = !workState.canStart('load') ? 'none' : 'copy';
	document.body.classList.toggle('dragging', workState.canStart('load'));
});
document.addEventListener('dragleave', e => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
document.addEventListener('drop', e => {
	e.preventDefault();
	document.body.classList.remove('dragging');
	const f = e.dataTransfer?.files?.[0];
	if (f) load(f);
});

// ── 播放 ────────────────────────────────────────────────────────────────

const syncPlayButton = () => {
	transport.setPlaying(player.isPlaying);
};
const togglePlay = () => { player.isPlaying ? player.pause() : player.play(); syncPlayButton(); };
player.onEnded = syncPlayButton;

/**
 * 跟隨播放頭。
 *
 * 做成「翻頁」而不是「一直把播放頭釘在中央」：連續捲動時曲線一直在動，
 * 很難看清楚形狀，而且使用者播放中手動捲去看別的地方會立刻被搶回來。
 * 播放頭跑到右側 85% 才翻一頁，讓它落在 15% 的位置。
 */
let followPlayhead = false;
function toggleFollow() {
	followPlayhead = !followPlayhead;
	transport.setFollow(followPlayhead);
	hint(followPlayhead ? '跟隨播放頭' : '跟隨播放頭已關閉');
}

function applyFollow(pos: number) {
	if (!followPlayhead || !source) return;
	const w = el.pianoroll.clientWidth;
	const span = w * view.secPerPx;
	const rel = (pos - view.startSec) / span;
	if (rel >= 0.85 || rel < 0) {
		view.scrollBy((pos - view.startSec - span * 0.15) / view.secPerPx, w);
	}
}

function toggleLoop() {
	if (player.loopRegion) {
		player.setLoop(null);
	} else {
		if (!selection) { hint('要先選一段才能循環'); return; }
		player.setLoop({ ...selection });
	}
	transport.setLoop(!!player.loopRegion);
	hint(player.loopRegion ? '循環播放選取範圍' : '循環已關閉');
}
const transport = new TransportView(document.querySelector<HTMLElement>('header .transport')!, {
	playPause: togglePlay,
	stop: () => { player.pause(); player.seek(0); syncPlayButton(); },
	toggleLoop,
	toggleFollow,
});
syncPlayButton();

// ── 工具與 lane 切換 ────────────────────────────────────────────────────

let toolLaneControls: ToolLaneControlsView;
function setTool(t: EditorTool) {
	tool = t;
	toolLaneControls.setTool(t);
	// 選取保留：切去畫筆畫幾筆再切回來，還是同一段可以繼續調
	syncToolbar();
}

/**
 * 工具列左半邊只放「現在能用的東西」：
 *   選取工具、沒選取 → 空
 *   選取工具、有選取 → 參數面板
 *   畫筆工具         → 畫筆選項
 * 工具列那一列一直都在（右邊有工具與 lane 切換），所以左邊換內容不會讓版面跳動。
 */
function syncToolbar() {
	editorOptions.setPenVisible(!aiRegions.length && tool === 'pen');
	inspector.setVisible(tool === 'select' && !!selection);
}
/**
 * 畫筆的抖音開關。
 *
 * 有了開關之後，幅度就不必再用 0 當「關閉」的代名詞了——關掉時數值留著，
 * 下次打開就是上次的設定，不用重打一次。
 */
function toggleVib(onset: boolean) {
	const enabled = editorOptions.toggleVibrato(onset);
	hint(`畫筆的${onset ? '抖音漸入' : '抖音'}：${enabled ? '開' : '關'}`);
}

toolLaneControls = new ToolLaneControlsView({
	root: document.getElementById('lane-bar')!, pitchTrack: el.pitchTrack, waveTrack: el.waveTrack,
	events: { selectTool: setTool, selectLane: setActiveLane, toggleLane: toggleLaneVisible },
});

function setActiveLane(id: LaneId) {
	pianoroll.active = id;
	editorOptions.setLaneUnit(id, LANES[id].unit);
	// 要編輯的 lane 一定要看得見，不然會對著看不到的線亂調
	pianoroll.visible.add(id);
	inspector.setLane(id);
	syncLaneChips();
	hint(`編輯對象：${LANES[id].label}`);
}

function toggleLaneVisible(id: LaneId) {
	if (pianoroll.visible.has(id)) {
		if (id === pianoroll.active) { hint('正在編輯的那條不能隱藏'); return; }
		pianoroll.visible.delete(id);
	} else {
		pianoroll.visible.add(id);
	}
	syncLaneChips();
}

function syncLaneChips() {
	toolLaneControls.syncLanes(pianoroll.active, pianoroll.visible);
}
setActiveLane('pitch');
setTool('select');
selectionChanged();

// ── 鍵盤 ────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
	if (workState.has('ai') || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof Element && e.target.closest('dialog, #ai-toolbar'))) return;
	if (aiRegions.length && !(e.code === 'Space' || ['l', 'f', 'm'].includes(e.key.toLowerCase()))) {
		if ((e.ctrlKey || e.metaKey) && ['a', 'z'].includes(e.key.toLowerCase())) e.preventDefault();
		hint('AI 修音審核中：只能上下拖曳黃色框調整音高，或按「放棄」整體還原');
		return;
	}
	// Alt 是畫筆的吸附鍵；不擋的話 Firefox 放開 Alt 會跳出選單列
	if (e.key === 'Alt') e.preventDefault();
	const digit = ['1', '2', '3'].indexOf(e.key);
	if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
	else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
		e.preventDefault();
		e.shiftKey ? redo() : undo();
	}
	else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
		e.preventDefault();
		if (!source || !curves) return;
		selection = { start: 0, end: outDuration() };
		selectionChanged();
		hint(`全選 ${fmtTime(selection.start)} ~ ${fmtTime(selection.end)}`);
	}
	else if (e.key === 'Escape') { clearSelection(); selectedAnchors.clear(); hint('選取已取消'); }
	else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnchors.size) {
		e.preventDefault();
		deleteAnchors([...selectedAnchors]);
	}
	else if (digit >= 0) { e.shiftKey ? toggleLaneVisible(LANE_IDS[digit]) : setActiveLane(LANE_IDS[digit]); }
	else if (e.key.toLowerCase() === 's') setTool('select');
	else if (e.key.toLowerCase() === 'b') setTool('pen');
	else if (e.key.toLowerCase() === 'l') toggleLoop();
	else if (e.key.toLowerCase() === 'f') toggleFollow();
	else if (e.key.toLowerCase() === 'm') toggleRefMute();
	// 漸入是抖音的子選項，所以掛在同一個鍵的 Shift 上
	else if (e.key.toLowerCase() === 'v') toggleVib(e.shiftKey);
});

async function undo() {
	if (!curves || workState.blocksEditing) return;
	const prev = history.undo(curves);
	if (!prev) { hint('沒有東西可以復原了'); return; }
	await swapCurves(prev, '復原');
}

async function redo() {
	if (!curves || workState.blocksEditing) return;
	const next = history.redo(curves);
	if (!next) { hint('沒有東西可以重做了'); return; }
	await swapCurves(next, '重做');
}

/** 換上另一份曲線（含錨點），只重算跟現在不同的那一段 */
async function swapCurves(next: Curves, label: string) {
	const prev = curves!;
	const changed = diffRange(prev, next);   // 原始時間
	curves = next;
	const mapChanged = !prev.timeMap.equals(next.timeMap);
	let dirty: { from: number; to: number } | null = null;
	if (mapChanged) {
		remapSelection(prev.timeMap, next.timeMap);
		for (const id of selectedAnchors) if (!next.timeMap.get(id)) selectedAnchors.delete(id);
		dirty = applyTimeMap();
	}
	syncRampInputs();
	// 曲線被整個換掉了，選取的基準也要跟著換，不然下一次調滑桿會套在舊狀態上
	selBase = selection ? curves.clone() : null;
	sessionPushed = false;
	resetParams();

	const ranges = [dirty, changed && { from: toOut(changed.from), to: toOut(changed.to) }]
		.filter((r): r is { from: number; to: number } => !!r);
	if (ranges.length) {
		await rerender(Math.min(...ranges.map(r => r.from)), Math.max(...ranges.map(r => r.to)), label);
	} else {
		hint(`已${label}`);
	}
}

// ── Time stretch 錨點 ───────────────────────────────────────────────────

/**
 * 把 curves.timeMap 套到算繪器上。回傳伸縮倍率有變、必須重算的輸出範圍。
 * 伸縮沒變的段落算繪器會自己從舊 buffer 搬過去，所以不必整段重算。
 */
function applyTimeMap(): { from: number; to: number } | null {
	if (!curves) return null;
	const dirty = renderer.setTimeMap(curves.timeMap);
	view.duration = outDuration();
	player.setAudio(renderer.rendered, renderer.sampleRate);
		manualBaseline = curves?.clone() ?? null;
	return dirty;
}

/** 錨點變動之後，選取與循環範圍要跟著內容走（黏在原始時間上），不是停在原本的秒數 */
function remapSelection(from: TimeMap, to: TimeMap) {
	const move = (t: number) => to.srcToOut(from.outToSrc(t));
	if (selection) selection = { start: move(selection.start), end: move(selection.end) };
	const loop = player.loopRegion;
	if (loop) player.setLoop({ start: move(loop.start), end: move(loop.end) });
}

const ANCHOR_HIT_PX = 6;

/** 波形條上 x 附近的錨點 */
function anchorAtX(x: number): number | null {
	if (!curves) return null;
	let best: number | null = null, bestD = ANCHOR_HIT_PX;
	for (const a of curves.timeMap.anchors) {
		const d = Math.abs(view.timeToX(a.out) - x);
		if (d <= bestD) { best = a.id; bestD = d; }
	}
	return best;
}

function describeAnchors(delta = 0): string {
	if (!curves || !selectedAnchors.size) return '';
	if (selectedAnchors.size > 1) {
		return `選取 ${selectedAnchors.size} 個錨點${delta ? `，一起移動 ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s` : ''}　Shift+點擊選範圍、Ctrl+點擊加減、Delete 刪除`;
	}
	const a = curves.timeMap.get([...selectedAnchors][0]);
	if (!a) return '';
	// 顯示錨點左邊那一段的倍率——拖曳時變的就是它
	const ratio = curves.timeMap.ratioAt(a.src - 1e-9);
	return `錨點：原 ${fmtTime(a.src)} → ${fmtTime(a.out)}（左段 ${ratio.toFixed(2)}×）　Shift+點擊選範圍、Ctrl+點擊加減、Delete 刪除`;
}

async function deleteAnchors(ids: number[]) {
 if(aiRegions.length){hint('請先按「完成工作」，再刪除時間錨點');return;}
	if (!curves || workState.blocksEditing) return;
	const before = curves.clone();
	let removed = 0;
	for (const id of ids) if (curves.timeMap.remove(id)) removed++;
	if (!removed) return;
	history.push(before);
	selectedAnchors.clear();
	remapSelection(before.timeMap, curves.timeMap);
	const dirty = applyTimeMap();
	const label = removed > 1 ? `刪除 ${removed} 個錨點` : '刪除錨點';
	if (dirty) await rerender(dirty.from, dirty.to, label);
	else hint(`已${label}`);
}

/** Shift+點擊範圍選取的起點：上一次不按 Shift 點到的錨點 */
let anchorPivot: number | null = null;

/** 拖曳中的錨點群組。base 是按下時的狀態，所有位移都從它算，來回拖不會累積誤差 */
let anchorDrag: { base: Curves; startT: number; x: number; moved: boolean } | null = null;

el.waveform.addEventListener('pointerdown', e => {
	if (!source) return;
	const x = e.clientX - el.waveform.getBoundingClientRect().left;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(x)));
	if (aiRegions.length) {
		player.seek(t);
		hint('AI 修音審核中：只能上下拖曳黃色框調整音高');
		return;
	}

	// 錨點在任何工具下都能選取與拖曳
	const hit = curves && !workState.blocksEditing ? anchorAtX(x) : null;
	if (hit !== null) {
        if(aiRegions.length){hint('請先按「完成工作」，再修改時間錨點');return;}
		const list = curves!.timeMap.anchors;
		if (e.shiftKey && anchorPivot !== null && curves!.timeMap.get(anchorPivot)) {
			// Shift+點擊：從上次點的錨點到這個之間全部選起來（跟檔案總管一樣，取代原本的選取）
			const i = list.findIndex(a => a.id === anchorPivot), j = list.findIndex(a => a.id === hit);
			selectedAnchors.clear();
			for (let k = Math.min(i, j); k <= Math.max(i, j); k++) selectedAnchors.add(list[k].id);
		} else if (e.ctrlKey || e.metaKey) {
			// Ctrl/Cmd+點擊：加入或移出單一個。移出的話就不拖了
			anchorPivot = hit;
			if (selectedAnchors.has(hit)) { selectedAnchors.delete(hit); hint(describeAnchors()); return; }
			selectedAnchors.add(hit);
		} else {
			anchorPivot = hit;
			// 點在沒選到的錨點上 = 只選它；點在已選的錨點上 = 保留整群，準備一起拖
			if (!selectedAnchors.has(hit)) {
				selectedAnchors.clear();
				selectedAnchors.add(hit);
			}
		}
		anchorDrag = { base: curves!.clone(), startT: view.xToTime(x), x, moved: false };
		el.waveform.setPointerCapture(e.pointerId);
		hint(describeAnchors());
		return;
	}
	// 畫筆工具點波形 = 加錨點。加錨點本身不改變對應，所以不必重算
	if (tool === 'pen' && curves && !workState.blocksEditing) {
        if(aiRegions.length){hint('請先按「完成工作」，再修改時間錨點');return;}
		const before = curves.clone();
		const a = curves.timeMap.add(t);
		if (!a) { hint('這裡跟既有的錨點重疊了'); return; }
		history.push(before);
		if (!e.shiftKey) selectedAnchors.clear();
		selectedAnchors.add(a.id);
		applyTimeMap();
		hint(`加入錨點 ${fmtTime(t)}（拖曳來伸縮，Shift+點擊多選，Delete 刪除）`);
		return;
	}
	if (!e.shiftKey) selectedAnchors.clear();
	// 其餘 = 拉選取範圍；沒拖動就放開只是定位播放頭
	waveSelect = { anchor: t, moved: false };
	el.waveform.setPointerCapture(e.pointerId);
});

/**
 * 波形軌（主波形與參考音軌）上的選取拖曳。波形軌沒有縱向改曲線的語意，
 * 所以在既有選取範圍內按下也是重新拉選取。
 */
let waveSelect: { anchor: number; moved: boolean } | null = null;

function waveSelectMove(canvas: HTMLCanvasElement, clientX: number) {
	if (!waveSelect || !source) return;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(clientX - canvas.getBoundingClientRect().left)));
	if (Math.abs(t - waveSelect.anchor) >= 0.01) waveSelect.moved = true;
	if (!waveSelect.moved) return;
	selection = { start: Math.min(waveSelect.anchor, t), end: Math.max(waveSelect.anchor, t) };
	hint(`選取 ${fmtTime(selection.start)} ~ ${fmtTime(selection.end)}（${(selection.end - selection.start).toFixed(2)}s）`);
}

function waveSelectEnd(canvas: HTMLCanvasElement, pointerId: number) {
	if (!waveSelect) return;
	const s = waveSelect;
	waveSelect = null;
	canvas.releasePointerCapture(pointerId);
	if (!s.moved) player.seek(s.anchor);
	else selectionChanged();
}

/** 依游標位置更新拖曳中的錨點群組 */
function dragAnchorsTo(x: number) {
	if (!anchorDrag || !curves) return;
	anchorDrag.x = x;
	// 只夾在沒選到的相鄰錨點之間（TimeMap.moveGroup 處理），不設倍率上下限，也可以拖過檔尾
	const d = curves.timeMap.moveGroup(anchorDrag.base.timeMap, selectedAnchors, view.xToTime(x) - anchorDrag.startT);
	if (d !== 0) anchorDrag.moved = true;
	view.duration = outDuration();
	hint(describeAnchors(d));
}

el.waveform.addEventListener('pointermove', e => {
	if (waveSelect) { waveSelectMove(el.waveform, e.clientX); return; }
	if (!anchorDrag) {
		// 滑到錨點把手上 = 顯示可以左右拖；其他地方交還給 CSS（畫筆模式有自己的游標）
		const x = e.clientX - el.waveform.getBoundingClientRect().left;
		el.waveform.style.cursor = curves && anchorAtX(x) !== null ? 'ew-resize' : '';
		return;
	}
	dragAnchorsTo(e.clientX - el.waveform.getBoundingClientRect().left);
});

/**
 * 拖曳錨點時游標超出畫面左右邊緣就自動捲動（每一幀呼叫）。
 * 滑鼠停著不動也要繼續捲，所以不能只靠 pointermove。
 */
function autoScrollAnchorDrag() {
	if (!anchorDrag) return;
	const w = el.waveform.clientWidth, edge = 24;
	const over = anchorDrag.x > w - edge ? anchorDrag.x - (w - edge) : anchorDrag.x < edge ? anchorDrag.x - edge : 0;
	if (!over) return;
	view.scrollBy(Math.max(-40, Math.min(40, over * 0.5)), w);
	dragAnchorsTo(anchorDrag.x);
}

el.waveform.addEventListener('pointerup', async e => {
	if (waveSelect) { waveSelectEnd(el.waveform, e.pointerId); return; }
	if (!anchorDrag || !curves) return;
	const { base } = anchorDrag;
	anchorDrag = null;
	el.waveform.releasePointerCapture(e.pointerId);
	if (base.timeMap.equals(curves.timeMap)) return;
	history.push(base);
	remapSelection(base.timeMap, curves.timeMap);
	const dirty = applyTimeMap();
	if (dirty) await rerender(dirty.from, dirty.to, '伸縮');
});

// ── 選取、拖曳與畫筆 ────────────────────────────────────────────────────

type DragMode =
	| { kind: 'select'; anchor: number; moved: boolean; bounds: { start: number; end: number } }
	| { kind: 'value'; startY: number; base: Curves; t: number; moved: boolean }
	| { kind: 'vibrato'; startY: number; startAlpha: number; t: number; moved: boolean }
	| { kind: 'pen'; base: Curves; startT: number; startY: number; lastT: number; lastY: number; minT: number; maxT: number };
let drag: DragMode | null = null;

el.pianoroll.addEventListener('pointerdown', e => {
	if (!source || !curves || workState.blocksEditing) return;
	const rect = el.pianoroll.getBoundingClientRect();
	const x = e.clientX - rect.left, y = e.clientY - rect.top;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(x)));

	if (tool === 'pen') {
		drag = { kind: 'pen', base: curves.clone(), startT: t, startY: y, lastT: t, lastY: y, minT: t, maxT: t };
		penTo(t, t, y, y, e.altKey, t);
	} else if (selection && t >= selection.start && t <= selection.end && e.shiftKey) {
		// Shift+上下拖 = 調抖動（跟面板的抖動滑桿同一個參數）
		drag = { kind: 'vibrato', startY: y, startAlpha: params.alpha, t, moved: false };
	} else if (selection && t >= selection.start && t <= selection.end) {
		// 在既有選取區內按下 = 對作用中的 lane 做垂直拖曳
		// 沒有上下拖動就放開 = 定位播放頭
		drag = { kind: 'value', startY: y, base: curves.clone(), t, moved: false };
	} else {
		const bounds = aiRegions.length ? manualSelectionBoundsAt(t, aiRegions.map(region => ({
			start: toOut(Curves.frameToTime(region.from)), end: toOut(Curves.frameToTime(region.to)),
		})), outDuration()) : { start: 0, end: outDuration() };
		if (!bounds) { player.seek(t); hint('這裡是既有 AI 黃框；請在黃框內直接調整，或從框外拖曳建立人工黃框'); return; }
		drag = { kind: 'select', anchor: t, moved: false, bounds };
	}
	el.pianoroll.setPointerCapture(e.pointerId);
});

el.pianoroll.addEventListener('pointermove', e => {
	if (!drag || !source || !curves) return;
	const rect = el.pianoroll.getBoundingClientRect();
	const x = e.clientX - rect.left, y = e.clientY - rect.top;
	const h = el.pianoroll.clientHeight;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(x)));

	if (drag.kind === 'select') {
		const boundedT = Math.max(drag.bounds.start, Math.min(drag.bounds.end, t));
		// 動了才算是在拉選取範圍。沒動的話放開時只是移動播放頭，選取要留著。
		if (Math.abs(boundedT - drag.anchor) >= 0.01) drag.moved = true;
		if (!drag.moved) return;
		selection = { start: Math.min(drag.anchor, boundedT), end: Math.max(drag.anchor, boundedT) };
		hint(`選取 ${fmtTime(selection.start)} ~ ${fmtTime(selection.end)}（${(selection.end - selection.start).toFixed(2)}s）`);
	} else if (drag.kind === 'pen') {
		if (e.shiftKey) {
			// Shift = 直線：每次都從落筆前的曲線重畫「落筆點 → 游標」這一條，
			// 所以拖曳途中游標怎麼繞都只留下最後那條直線
			curves.lane(pianoroll.active).set(drag.base.lane(pianoroll.active));
			penTo(drag.startT, t, drag.startY, y, e.altKey, drag.startT);
		} else {
			penTo(drag.lastT, t, drag.lastY, y, e.altKey, drag.startT);
		}
		drag.minT = Math.min(drag.minT, t); drag.maxT = Math.max(drag.maxT, t);
		drag.lastT = t; drag.lastY = y;
		const v = pianoroll.yToLaneValue(pianoroll.active, y, h);
		hint(`畫 ${LANES[pianoroll.active].label}：${v.toFixed(2)}${pianoroll.active === 'pitch' ? ` (${midiToName(v)})` : ' ' + LANES[pianoroll.active].unit}`);
	} else if (drag.kind === 'vibrato') {
		if (Math.abs(y - drag.startY) >= 3) drag.moved = true;
		if (!drag.moved) return;
		// 往上 = 起伏放大，往下 = 壓平；100px 一倍
		const alpha = Math.max(0, Math.min(4, Math.round((drag.startAlpha + (drag.startY - y) / 100) * 100) / 100));
		inspector.setParam('alpha', alpha);
		hint(`抖動 ${alpha.toFixed(2)}×（0 = 壓平，1 = 原樣）`);
	} else if (selection) {
		if (Math.abs(y - drag.startY) >= 3) drag.moved = true;
		if (!drag.moved) return;
		// 拖多少像素換算成多少單位，並吸附到 0.01 避免數字抖動
		const id = pianoroll.active;
		const raw = (drag.startY - y) / pianoroll.unitPx(id, h);
		const amount = Math.round(raw * 100) / 100;
		curves.lane(id).set(drag.base.lane(id));
		const s = srcSel()!;
		offsetLane(curves, id, s.start, s.end, amount);
		if (id === 'pitch') limitPitchSlope(s.start - curves.rampSec.pitch, s.end + curves.rampSec.pitch);
		hint(id === 'pitch'
			? `${amount >= 0 ? '+' : ''}${amount.toFixed(2)} 半音${describeTarget(amount)}`
			: `${LANES[id].label} ${amount >= 0 ? '+' : ''}${amount.toFixed(2)} ${LANES[id].unit}`);
	}
});

el.pianoroll.addEventListener('pointerup', async e => {
	if (!drag) return;
	const mode = drag;
	drag = null;
	el.pianoroll.releasePointerCapture(e.pointerId);
	if (!curves || !source) return;

	if (mode.kind === 'select') {
		if (!mode.moved) {
			// 幾乎沒移動 = 單純定位播放頭。**選取要保留**，這樣才能一直調同一段。
			player.seek(mode.anchor);
			return;
		}
		selectionChanged();
		return;
	}

	if (mode.kind === 'pen') {
		// 斜坡長度是原始時間的量，繞回原始時間加上去再換回輸出時間
		const ramp = PEN_RAMP_SEC;
		// 變化率上限在放開時才套用：畫的途中每一小段都套的話，已經畫好的部分會被反覆抹平
		if (pianoroll.active === 'pitch') limitPitchSlope(toSrc(mode.minT) - ramp, toSrc(mode.maxT) + ramp);
		if (sameCurves(mode.base, curves)) return;
		history.push(mode.base);
		const r = editRange(mode.base, toOut(toSrc(mode.minT) - ramp), toOut(toSrc(mode.maxT) + ramp));
		await rerender(r.from, r.to, '畫筆', pianoroll.active === 'pitch' ? { start: mode.minT, end: mode.maxT } : undefined);
		// 畫筆改的是曲線本身，選取的基準要跟著更新
		if (selection) { selBase = curves.clone(); sessionPushed = false; resetParams(); }
		return;
	}

	if (!mode.moved) { player.seek(mode.t); return; }
	if (mode.kind === 'vibrato') { inspector.commit('alpha'); return; }
	// 垂直拖曳結束 → 記錄一步可復原的動作，然後重算那一段
	if (!selection || sameCurves(mode.base, curves)) return;
	history.push(mode.base);
	const r = editRange(mode.base, selection.start, selection.end);
	await rerender(r.from, r.to, LANES[pianoroll.active].label, pianoroll.active === 'pitch' ? { ...selection } : undefined);
	// 拖曳的結果併入基準，滑桿的參考點跟著往前走
	selBase = curves.clone();
	sessionPushed = false;
	resetParams();
});

/**
 * 畫筆：把 (t0,y0) 到 (t1,y1) 之間的格子改寫成線性內插的值。
 *
 * pitch lane 畫的是「絕對音高」，所以要換算成相對於偵測值的偏移；
 * 未發聲的格子沒有偵測音高可以當基準，直接跳過。
 *
 * 抖音幅度不是 0 的話，畫出來的線會再加上 A(t)·sin(2πft)。
 *
 * **相位一律用絕對時間算**，不是從筆畫起點算——一次拖曳會產生幾十段 penTo，
 * 用筆畫相對時間的話每一段都從相位 0 重來，交界處就是一個突兀的跳動。
 *
 * 幅度 A(t) 則相反，要用「離筆畫起點多遠」算：真人的抖音是起音時幾乎沒有、
 * 然後才長出來的，一開始就滿幅度聽起來很機械。用 raised-cosine 漸入，
 * 而且取絕對值距離，所以由右往左畫也一樣是從落筆處長出來。
 */
function penTo(t0: number, t1: number, y0: number, y1: number, snap: boolean, startT: number) {
	if (!curves) return;
	const id = pianoroll.active;
	const h = el.pianoroll.clientHeight;
	const [ta, tb] = t0 <= t1 ? [t0, t1] : [t1, t0];
	const [ya, yb] = t0 <= t1 ? [y0, y1] : [y1, y0];
	const span = Math.max(1e-6, tb - ta);
	const pen = editorOptions.pen;
	const vibDepth = pen.enabled ? pen.depth : 0;
	const vibRate = pen.rate;
	const onsetSec = pen.onsetSec;
	// t0/t1/startT 都是輸出時間。抖音的速率與漸入照「畫的當下看到的時間」算，
	// 所以用輸出時間；之後再拉動錨點，抖音會跟著原唱一起變快變慢。
	const vib = (t: number) => {
		if (vibDepth === 0) return 0;
		let env = 1;
		if (onsetSec > 0) {
			const x = Math.min(1, Math.abs(t - startT) / onsetSec);
			env = 0.5 - 0.5 * Math.cos(Math.PI * x);
		}
		return vibDepth * env * Math.sin(2 * Math.PI * vibRate * t);
	};

	// 曲線格子在原始時間上：先把筆畫範圍換過去，每一格再換回輸出時間做內插
	const map = curves.timeMap;
	drawLane(curves, id, map.outToSrc(ta), map.outToSrc(tb) + CURVE_HOP_SEC, (tSrc, i) => {
		const t = map.srcToOut(tSrc);
		const f = Math.max(0, Math.min(1, (t - ta) / span));
		let v = pianoroll.yToLaneValue(id, ya + (yb - ya) * f, h);
		if (snap && id === 'pitch') v = Math.round(v);   // 按住 Alt/Option 吸附到整數半音
		// 吸附之後才加抖音，不然抖音會被吸附抹掉
		v += vib(t);
		if (id !== 'pitch') return Math.max(LANES[id].min, Math.min(LANES[id].max, v));
		// 未發聲的格子也要寫：跳過的話 Δ 在發聲交界會是階梯（見 pitchMidiFilled 的說明）
		if (!pitchMidiFilled) return null;
		return v - pitchMidiFilled[i];
	});
}

/** 選取狀態改變時呼叫：更新面板、把參數歸到中性、記下新的編輯基準 */
function selectionChanged() {
	// 底部列的歸零與取消選取只有在有選取時才能按
	const none = !selection || !curves;
	globalControls.setSelectionActive(!none);
	syncToolbar();
	if (!selection || !curves) {
		inspector.setSelectionLabel('尚未選取');
		selBase = null;
		sessionPushed = false;
		return;
	}
	selBase = curves.clone();
	sessionPushed = false;
	resetParams();
	inspector.setSelectionLabel(
		`${fmtTime(selection.start)} ~ ${fmtTime(selection.end)}（${(selection.end - selection.start).toFixed(2)}s）`,
	);
}

function clearSelection() {
	selection = null;
	player.setLoop(null);
	transport.setLoop(false);
	selectionChanged();
}

// ── 面板參數（活的，隨時可以來回調） ────────────────────────────────────

function resetParams() {
	inspector.reset();
}

/**
 * 依照目前的參數，從 selBase 重新套用一次。
 *
 * 一定要從 selBase 重算而不是在 curves 上疊加，否則滑桿拉回中性值時
 * 回不到原樣（舊版的問題）。全部參數都中性時，結果逐位元等於 selBase。
 */
function applyParams() {
	if (!curves || !selBase || !selection || workState.blocksEditing) return;
	curves.pitch.set(selBase.pitch);
	curves.gainDb.set(selBase.gainDb);
	curves.formant.set(selBase.formant);

	const s = srcSel()!;
	if (params.shift !== 0) offsetLane(curves, 'pitch', s.start, s.end, params.shift);
	if (params.alpha !== 1 && pitchMidi && curveVoiced) {
		flattenRange(curves, pitchMidi, curveVoiced, s.start, s.end, params.alpha);
	}
	if (params.gainDb !== 0) offsetLane(curves, 'gain', s.start, s.end, params.gainDb);
	if (params.formant !== 0) offsetLane(curves, 'formant', s.start, s.end, params.formant);
	if (params.shift !== 0 || params.alpha !== 1) limitPitchSlope(s.start - curves.rampSec.pitch, s.end + curves.rampSec.pitch);
}

/**
 * 對原始時間 [fromSec, toSec) 附近的音高偏移套用變化率上限（curves.pitchSlopeLimit）。
 * 範圍會自動往外擴到「最大的 |Δ| 拉得回來」的距離，被拉緩的部分不會截在範圍外。
 */
function limitPitchSlope(fromSec: number, toSec: number) {
	if (!curves || !(curves.pitchSlopeLimit > 0)) return;
	const L = curves.pitchSlopeLimit;
	const i0 = Curves.timeToFrame(fromSec), i1 = Curves.timeToFrame(toSec);
	const m = slopeMarginFrames(curves.pitch, i0, i1, L);
	limitSlope(curves.pitch, i0 - m, i1 + m, L);
}

/**
 * 這次編輯要重算的輸出範圍：選取（或筆畫）範圍，再加上曲線實際被改到的地方。
 * 變化率上限會把編輯往外推（+12 半音 / 60 = 往外 200ms），只算選取範圍的話接縫會落在 Δ≠0 處。
 */
function editRange(base: Curves, fromOut: number, toOut_: number): { from: number; to: number } {
	const d = curves ? diffRange(base, curves) : null;
	if (!d) return { from: fromOut, to: toOut_ };
	return { from: Math.min(fromOut, toOut(d.from)), to: Math.max(toOut_, toOut(d.to)) };
}

// 顯示模組只發出意圖；提交、復原紀錄與算繪仍由應用層統一處理。
async function commitInspectorParam(key: EditParamKey, label: string) {
	if (!curves || !selBase || !selection || workState.blocksEditing) return;
	applyParams();
	if (!sessionPushed) {
		if (sameCurves(selBase, curves)) return;
		history.push(selBase);
		sessionPushed = true;
	}
	const r = editRange(selBase, selection.start, selection.end);
	await rerender(r.from, r.to, label, ['shift', 'alpha'].includes(key) ? { ...selection } : undefined);
}

/**
 * 人聲／樂器模式：移調時音色要不要跟著跑。
 *
 * 這是**全域**設定，不是曲線——改了整個檔案所有移調過的地方聽感都會變，
 * 所以放在 header 而不是選取面板，也做成兩顆按鈕而不是滑桿，免得被滑鼠掃到。
 * 中間的程度用 Formant 那條 lane 分段調就好，不必再開一個連續旋鈕。
 */
async function setMode(follow: 0 | 1) {
	if (workState.blocksEditing) return;
	const changed = renderer.formantFollow !== follow;
	renderer.formantFollow = follow;
	headerPanel.setFormantFollow(follow);
	if (!changed || !curves) return;
	// 只有已經移調過的地方會受影響，沒移調的地方 r·Δ = 0
	const r = editedPitchRange();
	if (!r) { hint(follow ? '樂器模式（目前還沒有移調的段落）' : '人聲模式'); return; }
	await rerender(r.from, r.to, follow ? '樂器模式' : '人聲模式');
}
// 把選取範圍的編輯清掉，回到原始聲音
async function resetSelectionLane(which: LaneId | 'all') {
		if (!curves || !selection || workState.blocksEditing) return;
		const before = curves.clone();
		// 只歸零曲線數值；錨點與伸縮不動。範圍換到原始時間，因為曲線存在那裡
		const s = srcSel()!;
		if (which === 'all') resetAll(curves, s.start, s.end);
		else resetLane(curves, which as LaneId, s.start, s.end);
		if (which === 'all' || which === 'pitch') limitPitchSlope(s.start - 2 * curves.rampSec.pitch, s.end + 2 * curves.rampSec.pitch);
		if (sameCurves(before, curves)) { hint('這段本來就沒有這類編輯'); return; }
		history.push(before);
		const r = editRange(before, selection.start, selection.end);
		await rerender(r.from, r.to, '歸零', ['all', 'pitch'].includes(which) ? { ...selection } : undefined);
		selBase = curves.clone();
		sessionPushed = false;
		resetParams();
	}

// ── Ramp 長度 ───────────────────────────────────────────────────────────

// 邊界過渡只有一個數字，三條 lane 共用。只影響選取工具的編輯（上下拖、滑桿、歸零），
// 畫筆固定用 PEN_RAMP_SEC。曲線裡仍然每條 lane 各存一份，舊專案檔讀得進來。
function syncRampInputs() {
	if (!curves) return;
	globalControls.setRampMilliseconds(Math.round(curves.rampSec.pitch * 1000));
	globalControls.setSlope(curves.pitchSlopeLimit);
}

// 音高變化上限：只影響之後的編輯（跟邊界過渡一樣），不回頭改已經做好的曲線
function setPitchSlopeLimit(value: number) {
	if (!curves) return;
	const v = Math.max(0, Math.min(1000, value));
	const limit = isFinite(v) ? v : DEFAULT_PITCH_SLOPE_LIMIT;
	globalControls.setSlope(limit);
	curves.pitchSlopeLimit = limit;
	if (selBase) selBase.pitchSlopeLimit = limit;
	hint(limit > 0 ? `音高變化上限：每秒 ${limit} 半音` : '音高變化上限：不限制');
}

function setRampMilliseconds(value: number) {
	if (!curves) return;
	const ms = Math.max(5, Math.min(500, value || 100));
	globalControls.setRampMilliseconds(ms);
	for (const id of LANE_IDS) {
		curves.rampSec[id] = ms / 1000;
		if (selBase) selBase.rampSec[id] = ms / 1000;
	}
	hint(`邊界過渡：${ms}ms`);
}

// ── 匯出與存檔 ──────────────────────────────────────────────────────────

async function exportWav() {
	if (!source) return;
	const task = workState.tryBegin('export', '準備匯出 WAV');
	if (!task) return;
	try {
		// 匯出期間禁止編輯，但背景精算仍可執行，避免彼此等待。
		if (workState.has('background')) {
			hint('背景精算中，算完會自動匯出…');
			task.update('等待背景精算後匯出');
			await waitBackground();
		}
		const name = source.name.replace(/\.[^.]+$/, '') + '_wipitch.wav';
		task.update('編碼 WAV');
		const wav = encodeWav24(renderer.rendered, renderer.sampleRate);
  downloadBlob(wav, name);
  try {
   task.update('將暫存資料搬入 AI 訓練資料庫');
   trainingStatus.textContent = '正在搬移 AI 訓練暫存資料…';
   const committed = trainingAsset ? await commitTrainingStaging(trainingAsset.id) : { count:0, categories:{ manual:0, adjusted:0, rejected:0 } };
   const saved = committed.count;
   stagedTrainingCount = 0;
   trainingStatus.textContent = saved
    ? `AI 訓練資料：已搬移 ${saved} 筆（手動 ${committed.categories.manual}、人工調整 AI ${committed.categories.adjusted}）`
    : 'AI 訓練資料：暫存目錄沒有目前音檔的待存記錄';
   window.dispatchEvent(new CustomEvent('wipitch-training-committed'));
   hint(`已啟動 ${name} 下載；${trainingStatus.textContent}`);
   task.finish('WAV 下載已啟動，訓練資料儲存完成');
  } catch (error) {
   const message = `WAV 下載已啟動，但訓練資料未全部保存：${error instanceof Error ? error.message : String(error)}。請再次匯出以重試`;
   trainingStatus.textContent = message;
   hint(message); task.finish(message, true);
  }
	} catch (error) {
		const message = `匯出失敗：${error instanceof Error ? error.message : String(error)}`;
		hint(message); task.finish(message, true);
	} finally { task.finish('匯出工作已結束'); }
	}

async function overwriteOriginalAudio() {
	if(!source||!sourceWritebackPath)return;
	if(!window.confirm(`確定要用目前修改後的聲音覆寫「${sourceWritebackPath.split('/').pop() ?? source.name}」？\n系統會保留一份原始音檔安全備份。`))return;
	const task=workState.tryBegin('export','準備回存原檔');if(!task)return;
	try{
		if(workState.has('background')){hint('背景精算中，完成後會自動回存原檔…');task.update('等待背景精算');await waitBackground();}
		task.update('編碼與回存原音檔');
		const result=await overwriteLocalAudio(sourceWritebackPath,encodeWav24(renderer.rendered,renderer.sampleRate));
		// 檢測檔改指向覆寫前的安全備份，避免日後讀取時把同一組修正重複套用到已修正音訊。
		sourceAbsolutePath=result.backupPath;
		try{
			await writeLocalDetectionFile(sourceWritebackPath,createProjectText());
		}catch(error){
			throw new Error(`音訊已回存且原始聲音已備份，但檢測檔同步失敗：${error instanceof Error?error.message:String(error)}；請立即按「儲存檢測檔案」重試`);
		}
		hint(`已回存原檔 ${result.path.split('/').pop()}，並同步檢測檔；原始聲音備份於 ${result.backupPath.split('/').pop()}`);
		task.finish('修改後音訊已回存原檔');
	}catch(error){const message=`回存原檔失敗：${error instanceof Error?error.message:String(error)}`;hint(message);task.finish(message,true);}
	finally{task.finish('回存原檔工作已結束');}
}

async function saveProject() {
	if (!source || !curves || workState.blocksEditing) return;
	if (!sourceAbsolutePath) {
		hint('無法存檔：目前音訊沒有絕對路徑，請用「開啟音檔」重新選擇原始音訊');
		return;
	}
	const name = source.name.replace(/\.[^.]+$/, '') + '.wipitch.json';
	const text=createProjectText();
	try{
		const saved=await writeLocalDetectionFile(sourceWritebackPath??sourceAbsolutePath,text);
		hint(`已儲存檢測檔案 ${saved.name}（${aiRegions.length} 個黃框、${referenceBeatRecords.length} 筆拍點／和弦紀錄）`);
	}catch(error){
		downloadBlob(new Blob([text], { type: 'application/json' }), name);
		hint(`無法直接寫入原音檔目錄，已改為下載 ${name}：${error instanceof Error?error.message:String(error)}`);
	}
}

function createProjectText():string{
	if(!source||!curves||!sourceAbsolutePath)throw new Error('目前沒有可儲存的完整工作階段');
	const background:BackgroundSettings|undefined=ref.name ? { name: ref.name,
		fileSize:ref.fileSize??undefined,lastModified:ref.lastModified??undefined,
		gainDb: ref.gainDb, muted: ref.muted, offsetSec: ref.offsetSec,
		beatAnchorSec: ref.beatAnchorSec ?? ref.beatAnchorSecs.at(-1) ?? null, beatAnchorSecs: ref.beatAnchorSecs,
		tempoBpm: Number(tempoBpm.value),tempoMeter: tempoMeter.value, tempoTolerancePercent: Number(tempoTolerance.value),
		instrumentProfile:referenceInstrumentProfile.value==='rhythm'?'rhythm':'melody',
		onsetProminenceThreshold: Number(onsetProminence.value),beatConfirmationThreshold: Number(beatConfirmation.value),
		barStartsSec: referenceBarStarts, virtualBarStartsSec: referenceVirtualBarStarts,
		beatRecords: referenceBeatRecords } : pendingRefSettings ?? undefined;
	return serialize(curves, source.name, sourceAbsolutePath, source.sampleRate, source.duration, renderer.formantFollow,
		background,{detectionRange:detectionBar.range?{...detectionBar.range}:null,aiRegions},sourceWritebackPath??sourceAbsolutePath,
		trainingAsset?.size,source.contentSha256);
}

async function openProject(f: File,reuseLoadedAudio=false) {
 if(aiRegions.length){hint('請先按「完成工作」，再讀取專案');return;}
	let progress: WorkTask | null = null;
	let candidateRenderer:Renderer|null=null;
	try {
		const text = await f.text();
		const projectSource = inspectProject(text);
		const canReuseLoadedAudio=reuseLoadedAudio&&projectSource.audioPath===sourceAbsolutePath;
		if (projectSource.audioPath&&!canReuseLoadedAudio) {
			hint(`正在依專案路徑開啟 ${projectSource.audioName}…`);
			const audioFile = await readLocalAudio(projectSource.audioPath);
			if (!await load(audioFile, projectSource.audioPath, projectSource.audioWritebackPath ?? projectSource.audioPath,projectSource)) throw new Error('檢測檔案記錄的原始音訊載入失敗');
		} else if (!source || !track) {
			throw new Error('這是舊版專案，沒有保存音訊路徑；請先開啟對應的原始音檔，再重新讀檔');
		}
		if (!source || !track || !curves) throw new Error('原始音訊尚未完成載入');
		progress = workState.tryBegin('project', '讀取專案');
		if (!progress) throw new Error('目前工作尚未完成，請稍後再讀檔');
		const loaded = deserialize(text, source.sampleRate, track.length);
		progress.update('專案讀取完成，準備算繪');
		// 先用候選 Renderer 完成整段算繪；失敗時不替換目前曲線與播放音訊。
		candidateRenderer=new Renderer();candidateRenderer.formantFollow=loaded.formantFollow;
		bindRendererCallbacks(candidateRenderer);await candidateRenderer.init(source.channels,source.sampleRate);
		hint('讀檔：整段重新算繪中…（可能要十幾秒）');
		const candidateDuration=loaded.curves.timeMap.srcToOut(source.duration);
		showProgress({ start: 0, end: candidateDuration });
		const t0 = performance.now();
		await candidateRenderer.renderAll(loaded.curves);
		history.push(curves!);
		const oldRenderer=renderer;renderer=candidateRenderer;candidateRenderer=null;bindRendererCallbacks(renderer);oldRenderer.dispose();
		curves = loaded.curves;
		headerPanel.setFormantFollow(loaded.formantFollow === 1 ? 1 : 0);
		syncRampInputs();clearSelection();selectedAnchors.clear();
		view.duration = outDuration();
		player.setAudio(renderer.rendered, renderer.sampleRate);
		manualBaseline = curves?.clone() ?? null;
		aiRegions=loaded.inspection?.aiRegions??[];aiReview=null;aiOverlay.clear();
		detectionBar.set(loaded.inspection?.detectionRange??null);
		if(aiRegions.length){setActiveLane('pitch');setTool('select');}
		let refNote = '';
		const bgSaved = loaded.background;
		const sameLoadedReference = !!bgSaved && bgSaved.name === ref.name
			&& (bgSaved.fileSize === undefined || bgSaved.fileSize === ref.fileSize)
			&& (bgSaved.lastModified === undefined || bgSaved.lastModified === ref.lastModified);
		if (bgSaved && sameLoadedReference) {
			// 同一個背景已經載入了，直接套用設定
			ref.gainDb = bgSaved.gainDb; ref.muted = bgSaved.muted; ref.offsetSec = bgSaved.offsetSec;
			restoreReferenceAnchors(bgSaved);
			referenceBarStarts = bgSaved.barStartsSec?.filter(Number.isFinite) ?? [];
			referenceVirtualBarStarts = bgSaved.virtualBarStartsSec?.filter(Number.isFinite) ?? [];
			referenceBeatRecords = restoreReferenceBeats(bgSaved.beatRecords);
			referenceBeatsCommitted = referenceBeatRecords.length > 0;
			if (bgSaved.tempoBpm) tempoBpm.value = String(bgSaved.tempoBpm);
			if (bgSaved.tempoMeter) tempoMeter.value = bgSaved.tempoMeter;
			if (bgSaved.tempoTolerancePercent) tempoTolerance.value = String(bgSaved.tempoTolerancePercent);
			if (bgSaved.instrumentProfile==='rhythm'||bgSaved.instrumentProfile==='melody') referenceInstrumentProfile.value=bgSaved.instrumentProfile;
			if (bgSaved.onsetProminenceThreshold) onsetProminence.value = String(bgSaved.onsetProminenceThreshold);
			if (bgSaved.beatConfirmationThreshold) beatConfirmation.value = String(bgSaved.beatConfirmationThreshold);
			if (ref.beatAnchorSec !== null && referenceBarStarts.length) syncedReferenceRhythm = {
				bpm: Number(tempoBpm.value), meter: tempoMeter.value, anchorSec: ref.beatAnchorSec,
				barStartsSec: [...referenceBarStarts], virtualBarStartsSec: [...referenceVirtualBarStarts],
			};
			applyRefToPlayer();
		} else if (bgSaved) {
			removeReference(false);
			pendingRefSettings = bgSaved;
			refNote = `；專案有參考音軌 ${bgSaved.name}，請在下方參考音軌按「載入參考音軌」（設定會自動套用）`;
		} else removeReference(false);
		hint(`讀檔完成（算繪 ${((performance.now() - t0) / 1000).toFixed(1)}s）${refNote}`);
		finishRenderProgress('專案讀取與算繪完成');
		progress.finish('專案讀取與算繪完成');
	} catch (e) {
		hint(`讀檔失敗：${(e as Error).message}`);
		progress?.finish(`讀檔失敗：${(e as Error).message}`, true);
		finishRenderProgress(`讀檔失敗：${(e as Error).message}`, true);
	} finally {
		candidateRenderer?.dispose();
		showProgress(null);
		progress?.finish('專案讀取工作已結束');
	}
}

/** 拖曳時顯示「現在大概落在哪個音」，方便對照 */
function describeTarget(amount: number): string {
	if (!track || !selection) return '';
	let sum = 0, n = 0;
	const s = srcSel()!;
	const i0 = Math.round(s.start / 0.016), i1 = Math.round(s.end / 0.016);
	for (let i = i0; i < i1 && i < track.length; i++) {
		if (track.voiced[i]) { sum += hzToMidi(track.f0[i]); n++; }
	}
	if (!n) return '';
	const midi = sum / n + amount;
	const cents = Math.round((midi - Math.round(midi)) * 100);
	return `　→ 平均落在 ${midiToName(midi)} ${cents >= 0 ? '+' : ''}${cents} cents`;
}

async function rerender(fromSec: number, toSec: number, label: string, manualRange?: { start: number; end: number }) {
	if (!curves || !workState.canStart('render')) return;
	hint(`${label}：算繪中…`);
	showProgress({ start: Math.max(0, fromSec), end: toSec });
	const t0 = performance.now();
 const before = manualBaseline?.clone();
 const sr = renderer.sampleRate;
 const clipStart = manualRange ? Math.max(0, manualRange.start - 3) : 0;
 const clipEnd = Math.min(manualRange ? manualRange.end + 3 : 0, renderer.rendered[0].length / sr);
 const changedPitch = before && !sameArray(before.pitch, curves.pitch);
 const exceedsTrainingLimit = !!manualRange && manualRange.end - manualRange.start > 5;
 const touchesAI = !!manualRange && !!curves && aiRegions.some(r => toOut(Curves.frameToTime(r.from)) < manualRange.end && toOut(Curves.frameToTime(r.to)) > manualRange.start);
 const createsManualAIRegion = !!(aiReview && manualRange && !touchesAI && changedPitch);
 const capture = !!(manualRange && !touchesAI && !exceedsTrainingLimit && trainingAsset && changedPitch && clipEnd > clipStart && source && pitchMidi && curveVoiced);
 const cut = () => renderer.rendered.map(channel => channel.slice(Math.round(clipStart * sr), Math.round(clipEnd * sr)));
 const beforeAudio = capture ? cut() : [];
 const afterCurves = curves.clone();
 // Snapshot the visible selection before rendering; export must not reread the UI.
 const keySelection = {
	 value: editorOptions.keyValue,
	 label: editorOptions.keyLabel,
  capturedAt: new Date().toISOString(),
 };
 const optionKey = KEY_OPTIONS.find(key => key.id === keySelection.value);
 const selectedKey = optionKey ? { ...optionKey, pitchClasses: [...optionKey.pitchClasses] } : null;
 const metadata = { asset: trainingAsset, operation: label, selection: selection ? { ...selection } : null,
  keySelection,
  editRange: manualRange, detectionRange: detectionBar.range ? { ...detectionBar.range } : null,
  renderRange: { start: fromSec, end: toSec }, parameters: { ...params },
	 pen: editorOptions.pen,
  pitchSlopeLimit: curves.pitchSlopeLimit, ramp: { ...curves.rampSec },
  anchors: curves.timeMap.anchors.map(anchor => ({ ...anchor })), formantFollow: renderer.formantFollow,
  audioStage: 'interactive-render-before-background-refinement' };
	try {
		await renderer.patch(curves, Math.max(0, fromSec), toSec);
		player.setAudio(renderer.rendered, renderer.sampleRate);
  manualBaseline = curves.clone();
  for(const region of aiRegions) { syncAIRegion(region, curves); if(manualRange && region.edited && toOut(Curves.frameToTime(region.from)) < manualRange.end && toOut(Curves.frameToTime(region.to)) > manualRange.start) region.feedbackKey=keySelection; }
  if(createsManualAIRegion&&before&&manualRange&&aiReview){
   const from=Curves.timeToFrame(toSrc(manualRange.start)),to=Curves.timeToFrame(toSrc(manualRange.end));
   const nextId=aiRegions.reduce((id,region)=>Math.max(id,region.id+1),0);
   const region=createManualAIRegion(before,afterCurves,from,to,nextId);region.feedbackKey=keySelection;
   aiRegions.push(region);
   const run=aiReview.runs.find(candidate=>rangesOverlap(candidate.input.range,manualRange))??aiReview.runs.at(-1);
   if(run)aiReview.sources.set(region.id,{input:run.input,proposal:before.clone(),keyLabel:run.keyLabel});
   if(capture)aiReview.audio.set(region.id,{start:clipStart,end:clipEnd,channels:beforeAudio});
   trainingStatus.textContent=exceedsTrainingLimit
    ? '人工黃框已建立；範圍超過 5 秒，完成工作時會依既有黃框規則略過訓練資料'
    : '人工黃框已建立；完成工作時會與其他人工調整黃框一起保存為 AI 訓練資料';
  }
  if (manualRange && changedPitch && exceedsTrainingLimit && !createsManualAIRegion) {
   trainingStatus.textContent = '本次修改範圍超過 5 秒，不記錄訓練資料；修音已完成';
  }
  if (capture&&!createsManualAIRegion) {
   trainingStatus.textContent = '手動修音記錄：正在暫存本次修改…';
   try {
    const pair = await prepareTrainingPair({ before: before!, after: afterCurves, beforeAudio, afterAudio: cut(),
     midi: pitchMidi!, voiced: curveVoiced!, start: clipStart, end: clipEnd, sampleRate: sr, key: selectedKey, metadata });
    await stageTrainingPair(pair);
    stagedTrainingCount++;
    trainingStatus.textContent = `手動修音記錄：已暫存 ${stagedTrainingCount} 筆，資料位於 AI訓練暫存，匯出 WAV 時搬移`;
   } catch (error) { trainingStatus.textContent = `手動修音記錄暫存失敗：${error instanceof Error ? error.message : error}；修音結果仍保留`; }
  }
		hint(`${label}：完成（${(performance.now() - t0).toFixed(0)}ms）`);
		finishRenderProgress(`${label}算繪完成`);
		scheduleBackground({ from: Math.max(0, fromSec), to: toSec });
	} catch (e) {
		hint(`${label}：算繪失敗 ${(e as Error).message}`);
		finishRenderProgress(`${label}算繪失敗：${(e as Error).message}`, true);
	} finally {
		finishRenderProgress('算繪工作已結束');
		showProgress(null);
	}
}

// ── 背景精算 ────────────────────────────────────────────────────────────
//
// 有伸縮的段落，快速的局部重算在接縫處可能有幾毫秒的偏差（見 renderer.ts）。
// 每次重算完就排一個背景工作，把改動前後兩個無聲處之間一口氣算完，算完自動換上。

let bgTimer = 0;
/** 還沒處理的改動範圍（輸出秒）。連續編輯時合併起來，一次算完 */
let bgPendingRange: { from: number; to: number } | null = null;


function scheduleBackground(changed: { from: number; to: number }) {
	bgPendingRange = bgPendingRange
		? { from: Math.min(bgPendingRange.from, changed.from), to: Math.max(bgPendingRange.to, changed.to) }
		: changed;
	clearTimeout(bgTimer);
	// 連續編輯時不要每一步都開一個工作：停手 400ms 才開始
	bgTimer = window.setTimeout(runBackground, 400);
	// 要在計時器設好之後才同步指示燈，不然它會以為沒有在等
	syncBackgroundStatus();
}

async function runBackground() {
	bgTimer = 0;
	if (!curves || !bgPendingRange) return;
	if (workState.blocksBackground) { bgTimer = window.setTimeout(runBackground, 200); return; }
	const range = bgPendingRange;
	bgPendingRange = null;
	// 沒換上的話，要嘛是不需要精算，要嘛是被新的編輯取消了——那個編輯自己會再排一次
	try {
		if (await renderer.renderBackground(curves, range)) {
			player.setAudio(renderer.rendered, renderer.sampleRate);
			diagnostics?.recordBackgroundApplied();
		}
	} catch (error) {
		hint(`背景精算失敗：${error instanceof Error ? error.message : String(error)}`);
	} finally { syncBackgroundStatus(); }
}

function syncBackgroundStatus() {
	const p = renderer.backgroundProgress;
	const waiting = !!bgTimer && !!bgPendingRange;
	headerPanel.setBackgroundProgress(p === null && !waiting ? null : p === null ? '背景精算（等待中）' : `背景精算 ${Math.round(p * 100)}%`);
	if (p !== null || waiting) {
		backgroundTask ??= workState.begin('background', '背景精算');
		backgroundTask.update(p === null ? '背景精算（等待中）' : '背景精算', p);
	} else {
		backgroundTask?.finish('背景精算已結束');
		backgroundTask = null;
	}
}

/** 等背景精算全部結束（匯出前、測試用） */
async function waitBackground() {
	while (workState.has('background') || workState.blocksBackground) {
		await new Promise(r => setTimeout(r, 100));
	}
}

// ── 時間軸操作 ──────────────────────────────────────────────────────────

// 曲線區以游標所在時間縮放；琴鍵與右側捲軸以游標高度縮放縱軸。
const zoomTimelineAtPointer = (factor: number, clientX: number) => {
	const rect = el.pianoroll.getBoundingClientRect();
	const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
	view.zoomAt(x, factor, el.pianoroll.clientWidth);
};
bindZoomGesture(el.pianoroll, zoomTimelineAtPointer, () => source !== null);
for (const target of [el.pianoKeys, el.vbar]) {
	bindZoomGesture(target, (factor, _clientX, clientY) => {
		const rect = el.pianoroll.getBoundingClientRect();
		pianoroll.zoomV(factor, Math.max(0, Math.min(rect.height, clientY - rect.top)), rect.height);
	}, () => source !== null);
}

// 波形軌保留原有操作：滾輪橫向捲動、Ctrl/Cmd 縮放、Alt 放大波形。
for (const canvas of [el.waveform, el.refwave]) {
	canvas.addEventListener('wheel', e => {
		if (!source) return;
		e.preventDefault();
		const rect = canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const w = canvas.clientWidth;
		// 有些滑鼠與觸控板把 Shift+滾輪直接送成 deltaX，兩個都要看
		const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
		const ctrl = e.ctrlKey || e.metaKey;
		// 波形軌上 Alt+滾輪 = 放大波形（只影響顯示）
		if (canvas === el.waveform && e.altKey) {
			setAmpZoom(waveform.ampZoom * Math.exp(-d * 0.002));
			return;
		}
		if (canvas === el.refwave && e.altKey) {
			setRefAmpZoom(refWave.ampZoom * Math.exp(-d * 0.002));
			return;
		}
		if (ctrl) view.zoomAt(x, Math.exp(d * 0.003), w);
		else view.scrollBy(d, w);
	}, { passive: false });
}

/*
 * 範圍捲軸：滾輪組合鍵不好記，也不是每個人都有滾輪。
 * 橫向那條管所有軌道共用的時間軸，底下畫整個檔案的總覽；縱向那條管目前編輯的 lane。
 */
const hbar = new RangeBar(el.hbar, 'h', {
	extent: () => ({ lo: 0, hi: view.extent }),
	visible: () => ({ lo: view.startSec, hi: view.startSec + el.pianoroll.clientWidth * view.secPerPx }),
	setVisible: (lo, hi, keep) => { if (source) view.setRange(lo, hi, el.pianoroll.clientWidth, keep); },
	fit: () => { if (source) view.fit(el.pianoroll.clientWidth); },
}, (ctx, w, h, ext) => drawOverview(waveform, ctx, w, h, ext.lo, ext.hi, curves, player.position, selection));

const vbar = new RangeBar(el.vbar, 'v', {
	extent: () => pianoroll.vExtent(),
	visible: () => pianoroll.rangeOf(pianoroll.active),
	setVisible: (lo, hi, keep) => pianoroll.setRangeV(lo, hi, keep),
	fit: () => pianoroll.fitV(),
});

// ── 波形放大與波形軌高度 ────────────────────────────────────────────────

/** 放大倍率與滑桿位置的換算：對數刻度 0.25× ~ 100×（100× ≈ +40dB） */
const AMP_MIN = 0.25, AMP_MAX = 100;
const ampToFraction = (z: number) => Math.log(z / AMP_MIN) / Math.log(AMP_MAX / AMP_MIN);
const fractionToAmp = (f: number) => AMP_MIN * Math.pow(AMP_MAX / AMP_MIN, f);

function setAmpZoom(z: number) {
	waveform.ampZoom = Math.max(AMP_MIN, Math.min(AMP_MAX, z));
	el.ampZoom.value = String(ampToFraction(waveform.ampZoom));
	hint(`波形放大 ${waveform.ampZoom.toFixed(2)}×（只影響顯示）`);
}
el.ampZoom.value = String(ampToFraction(1));
el.ampZoom.addEventListener('input', () => setAmpZoom(fractionToAmp(parseFloat(el.ampZoom.value))));
el.ampZoom.addEventListener('dblclick', () => setAmpZoom(1));

const TRACK_MIN_PX = 40;

/**
 * 分隔線拖曳改軌道高度（主波形、參考音軌各一條）。
 * 唯一的限制是每個軌道都還看得到一點。高度記在 localStorage。
 */
function makeSplitter(splitter: HTMLElement, canvas: HTMLCanvasElement, other: HTMLCanvasElement,
	cssVar: string, key: string, def: number) {
	const set = (px: number) => {
		const main = el.stage;
		const max = Math.max(TRACK_MIN_PX, main.clientHeight - el.waveSplitter.clientHeight - el.refSplitter.clientHeight - el.hbar.parentElement!.clientHeight
			- other.clientHeight - TRACK_MIN_PX);
		const h = Math.round(Math.max(TRACK_MIN_PX, Math.min(max, px)));
		main.style.setProperty(cssVar, `${h}px`);
		try { localStorage.setItem(key, String(h)); } catch { /* 私密模式等 */ }
	};
	try {
		const saved = parseFloat(localStorage.getItem(key) || '');
		if (saved > 0) el.stage.style.setProperty(cssVar, `${saved}px`);
	} catch { /* 讀不到就用預設 */ }

	let drag: { startY: number; startH: number } | null = null;
	splitter.addEventListener('pointerdown', e => {
		drag = { startY: e.clientY, startH: canvas.clientHeight };
		splitter.setPointerCapture(e.pointerId);
	});
	splitter.addEventListener('pointermove', e => {
		if (!drag) return;
		// 往上拖 = 下面的軌道變高
		set(drag.startH - (e.clientY - drag.startY));
	});
	splitter.addEventListener('pointerup', e => {
		drag = null;
		splitter.releasePointerCapture(e.pointerId);
	});
	splitter.addEventListener('dblclick', () => set(def));
}
makeSplitter(el.waveSplitter, el.waveform, el.refwave, '--wave-h', 'wipitch.waveHeight', 150);
makeSplitter(el.refSplitter, el.refwave, el.waveform, '--ref-h', 'wipitch.refHeight', 60);

function setRefAmpZoom(z: number) {
	refWave.ampZoom = Math.max(AMP_MIN, Math.min(AMP_MAX, z));
	el.refAmpZoom.value = String(ampToFraction(refWave.ampZoom));
	hint(`參考音軌波形放大 ${refWave.ampZoom.toFixed(2)}×（只影響顯示）`);
}
el.refAmpZoom.value = String(ampToFraction(1));
el.refAmpZoom.addEventListener('input', () => setRefAmpZoom(fractionToAmp(parseFloat(el.refAmpZoom.value))));
el.refAmpZoom.addEventListener('dblclick', () => setRefAmpZoom(1));

let refBeatDrag: { pointerId: number; firstBeatSec: number; original: ReferenceBeatRecord[]; bars: number[]; virtualBars: number[]; anchors: number[]; startTime: number; moved:boolean } | null = null;
function editReferenceChord(row:ReferenceBeatRecord){
	const entered=window.prompt('輸入此拍的和弦；留空可清除和弦',row.chord??'');
	if(entered===null)return;
	const chord=entered.trim();
	const pitchClasses=chordPitchClasses(chord||undefined);
	if(chord&&!pitchClasses.length){
		hint('和弦格式無法辨識；可使用 F#m、B♭、Cadd9、maj7、m7、7、dim、aug、sus2 或 sus4');
		return;
	}
	if(!row.chordEdited)row.originalChord=row.chord;
	row.chord=chord||undefined;row.chordEdited=true;
	row.pitchClasses=pitchClasses;
	row.pitchNames=row.pitchClasses.map(value=>['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'][value]);
	if(syncedReferenceRhythm?.beatHarmony){const beat=syncedReferenceRhythm.beatHarmony.reduce<typeof syncedReferenceRhythm.beatHarmony[number]|undefined>((nearest,candidate)=>
		Math.abs(candidate.timeSec-row.timeSec)<Math.abs((nearest?.timeSec??Infinity)-row.timeSec)?candidate:nearest,undefined);
		if(beat&&Math.abs(beat.timeSec-row.timeSec)<.05){beat.chord=row.chord;beat.pitchClasses=[...row.pitchClasses];beat.pitchNames=[...row.pitchNames];}}
	document.getElementById('ref-beat-status')!.textContent=`已人工修改 ${fmtTime(row.timeSec)} 的和弦${chord?`為 ${chord}`:'（已清除）'}`;
	hint('和弦已人工修改；底色保留原標記顏色、文字改為白色，並會寫入檢測檔案');
}
function referenceBeatAtPointer(e:PointerEvent):ReferenceBeatRecord|null{
	const rect=el.refwave.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
	if(y<el.refwave.clientHeight-24)return null;
	let selected:ReferenceBeatRecord|null=null,distance=Infinity;
	for(const row of referenceBeatRecords){
		const dx=Math.abs(view.timeToX(row.timeSec)-x),hitWidth=Math.max(10,(row.chord?.length??0)*4+7);
		if(dx<=hitWidth&&dx<distance){selected=row;distance=dx;}
	}
	return selected;
}
// 參考音軌底部的紅色第一拍可拖動；其他位置維持既有選取／定位操作。
el.refwave.addEventListener('pointerdown', e => {
	if (!source) return;
	const t = Math.max(0, Math.min(outDuration(), view.xToTime(e.clientX - el.refwave.getBoundingClientRect().left)));
	if (!workState.isBusy && ref.name && referenceBeatRecords.length) {
		const marker=referenceBeatAtPointer(e);
		if(marker&&marker.beatInBar!==1){editReferenceChord(marker);return;}
		if(marker) {
			refBeatDrag = { pointerId: e.pointerId, firstBeatSec:marker.timeSec, original: referenceBeatRecords,
				bars: [...referenceBarStarts], virtualBars: [...referenceVirtualBarStarts], anchors: [...ref.beatAnchorSecs], startTime: t,moved:false };
			el.refwave.setPointerCapture(e.pointerId);
			return;
		}
	}
	if (aiRegions.length) {
		player.seek(t);
		hint('AI 修音審核中：只能上下拖曳黃色框調整音高');
		return;
	}
	if (!e.shiftKey) selectedAnchors.clear();
	// 畫筆模式不建立選取，點一下只定位播放頭
	if (tool === 'pen') { player.seek(t); return; }
	waveSelect = { anchor: t, moved: false };
	el.refwave.setPointerCapture(e.pointerId);
});
el.refwave.addEventListener('pointermove', e => {
	if (refBeatDrag?.pointerId === e.pointerId) {
		const drag = refBeatDrag;
		const t = view.xToTime(e.clientX - el.refwave.getBoundingClientRect().left);
		const previous = [...drag.original].reverse().find(row => row.timeSec < drag.firstBeatSec - 0.001);
		const last = drag.original[drag.original.length - 1];
		const minimum = previous ? previous.timeSec + 0.05 - drag.firstBeatSec : -drag.firstBeatSec;
		const maximum = ref.offsetSec + (referenceCache?.duration ?? 0) - last.timeSec;
		const shift = Math.max(minimum, Math.min(maximum, t - drag.startTime));
		drag.moved=drag.moved||Math.abs(shift)>.005;
		referenceBeatRecords = shiftReferenceBeats(drag.original, shift, drag.firstBeatSec - 0.001);
		referenceBarStarts = drag.bars.map(bar => bar >= drag.firstBeatSec - 0.001 ? bar + shift : bar);
		referenceVirtualBarStarts = drag.virtualBars.map(bar => bar >= drag.firstBeatSec - 0.001 ? bar + shift : bar);
		ref.beatAnchorSecs = drag.anchors.map(anchor => anchor >= drag.firstBeatSec - 0.001 ? anchor + shift : anchor);
		ref.beatAnchorSec = referenceAnchorInRange(currentDetectionRange()) ?? ref.beatAnchorSecs.at(-1) ?? null;
		hint(`第一拍偏移 ${shift >= 0 ? '+' : ''}${Math.round(shift * 1000)} ms；後續拍點同步調整`);
		return;
	}
	waveSelectMove(el.refwave, e.clientX);
});
el.refwave.addEventListener('pointerup', e => {
	if (refBeatDrag?.pointerId === e.pointerId) {
		const drag=refBeatDrag;
		refBeatDrag = null;
		el.refwave.releasePointerCapture(e.pointerId);
		if (syncedReferenceRhythm) syncedReferenceRhythm = { ...syncedReferenceRhythm,
			anchorSec: ref.beatAnchorSec ?? syncedReferenceRhythm.anchorSec, barStartsSec: [...referenceBarStarts],
			virtualBarStartsSec: [...referenceVirtualBarStarts] };
		const average = averageBarBpm(referenceBarStarts, Number(tempoBpm.value), tempoMeter.value);
		if (average !== null && !averageBpmOutput.hidden) averageBpmOutput.textContent = `範圍平均 BPM ${average.toFixed(1)}`;
		if(!drag.moved){const row=referenceBeatRecords.reduce<ReferenceBeatRecord|null>((nearest,candidate)=>
			Math.abs(candidate.timeSec-drag.firstBeatSec)<Math.abs((nearest?.timeSec??Infinity)-drag.firstBeatSec)?candidate:nearest,null);if(row)editReferenceChord(row);}
		return;
	}
	waveSelectEnd(el.refwave, e.pointerId);
});
el.refwave.addEventListener('pointercancel', e => {
	if (refBeatDrag?.pointerId !== e.pointerId) return;
	referenceBarStarts = refBeatDrag.bars;
	referenceVirtualBarStarts = refBeatDrag.virtualBars;
	referenceBeatRecords = refBeatDrag.original;
	ref.beatAnchorSecs = refBeatDrag.anchors;
	ref.beatAnchorSec = referenceAnchorInRange(currentDetectionRange()) ?? ref.beatAnchorSecs.at(-1) ?? null;
	refBeatDrag = null;
});

// ── 背景參考音軌 ────────────────────────────────────────────────────────
//
// 修主唱時一邊聽伴奏才知道對不對得準。只用來監聽：不跟著錨點伸縮、不會匯出。
// 存檔只記設定，讀檔後請使用者重新載入同名檔。

const ref = { name: null as string | null, fileSize: null as number | null, lastModified: null as number | null,
	gainDb: 0, muted: false, offsetSec: 0,
	beatAnchorSec: null as number | null, beatAnchorSecs: [] as number[] };
let referenceCache: ReferenceCache | null = null;
let rhythmGeneration = 0;
let referenceBarStarts: number[] = [];
let referenceVirtualBarStarts: number[] = [];
let referenceBeatRecords: ReferenceBeatRecord[] = [];
let referenceBeatsCommitted = false;
let lastReferenceAnalysisRange: { start: number; end: number } | null = null;
let refAudio: { channels: Float32Array[]; sampleRate: number } | null = null;
let syncedReferenceRhythm: ReferenceRhythm | null = null;
const averageBpmOutput = document.getElementById('ref-average-bpm') as HTMLOutputElement;
const anchorButton = document.getElementById('ref-anchor-set') as HTMLButtonElement;
const clearBeatButton = document.getElementById('ref-beat-clear') as HTMLButtonElement;

function currentDetectionRange(): { start: number; end: number } | null {
	const range = detectionBar.range;
	return range && range.end > range.start ? range : null;
}

function referenceAnchorInRange(range: { start: number; end: number } | null): number | null {
	if (!range) return null;
	return ref.beatAnchorSecs.find(anchor => referenceBeatInRange(anchor, range)) ?? null;
}

function setReferenceAnchor(range: { start: number; end: number }, anchor: number): void {
	ref.beatAnchorSecs = ref.beatAnchorSecs.filter(previous => !referenceBeatInRange(previous, range));
	ref.beatAnchorSecs.push(anchor);
	ref.beatAnchorSecs.sort((a, b) => a - b);
	ref.beatAnchorSec = anchor;
}

function clearReferenceAnchors(range: { start: number; end: number }): void {
	ref.beatAnchorSecs = ref.beatAnchorSecs.filter(anchor => !referenceBeatInRange(anchor, range));
	ref.beatAnchorSec = referenceAnchorInRange(currentDetectionRange()) ?? ref.beatAnchorSecs.at(-1) ?? null;
}

function restoreReferenceAnchors(settings: BackgroundSettings): void {
	const multiple = Array.isArray(settings.beatAnchorSecs) ? settings.beatAnchorSecs.filter(Number.isFinite) : [];
	const saved = multiple.length ? multiple
		: (Number.isFinite(settings.beatAnchorSec) ? [settings.beatAnchorSec as number] : []);
	ref.beatAnchorSecs = [...new Set(saved)].sort((a, b) => a - b);
	ref.beatAnchorSec = referenceAnchorInRange(currentDetectionRange()) ?? ref.beatAnchorSecs.at(-1) ?? null;
}

function hasReferenceBeatMarkers(range: { start: number; end: number }): boolean {
	if (hasReferenceBeatsInRange(referenceBeatRecords, range)) return true;
	if (referenceBeatsCommitted) return false;
	return referenceBeatGrid(referenceBarStarts, Number(tempoBpm.value), tempoMeter.value)
		.some(marker => referenceBeatInRange(marker.time, range));
}

/** 清除持久拍點與目前預覽／分析結果；持久資料只刪除 [start,end) 內的列。 */
function clearReferenceBeatRange(range: { start: number; end: number }): number {
	const before = referenceBeatRecords.length;
	referenceBeatRecords = clearReferenceBeatsInRange(referenceBeatRecords, range);
	clearReferenceAnchors(range);
	++rhythmGeneration;
	referenceBarStarts = [];
	referenceVirtualBarStarts = [];
	referenceBeatsCommitted = false;
	syncedReferenceRhythm = null;
	lastReferenceAnalysisRange = null;
	averageBpmOutput.hidden = true;
	averageBpmOutput.textContent = '';
	document.getElementById('ref-beat-status')!.textContent = referenceBeatRecords.length
		? `已記錄 ${referenceBeatRecords.length} 拍 · 目前範圍已清除`
		: '目前檢測範圍的節拍已清除';
	syncRefUi();
	return before - referenceBeatRecords.length;
}

anchorButton.addEventListener('click', () => {
	if (!referenceCache || workState.blocksEditing) { hint('請先載入參考音軌並等待前景工作完成'); return; }
	const range = currentDetectionRange();
	if (!range) { hint('請先在檢測列標示要錨定的範圍'); return; }
	const redline = player.position;
	if (!referenceBeatInRange(redline, range)) { hint('請先把播放紅線移到檢測範圍內再錨定'); return; }
	let replaced = false;
	if (hasReferenceBeatMarkers(range)) {
		clearReferenceBeatRange(range);
		replaced = true;
	}
	const referenceTime = redline - ref.offsetSec;
	const localStart = Math.max(0, referenceTime - 0.7), localEnd = Math.min(referenceCache.duration, referenceTime + 0.7);
	const localAudio = referenceCache.mono16k.slice(Math.floor(localStart * 16000), Math.ceil(localEnd * 16000));
	const localCache: ReferenceCache = { mono16k: localAudio, onsets: createSpectralFluxOnsets(localAudio), duration: localAudio.length / 16000 };
	const localOnset = findOnset(localCache, referenceTime - localStart, 0.5, 0, localCache.duration,
		Number(onsetProminence.value), Number(beatConfirmation.value));
	const onset = localOnset === null ? null : localOnset + localStart;
	const snapped = onset === null ? redline : onset + ref.offsetSec;
	setReferenceAnchor(range, referenceBeatInRange(snapped, range) ? snapped : redline);
	rebuildReferenceBars();
	syncRefUi();
	hint(`${replaced ? '已清除檢測範圍原有拍點並重新錨定；' : ''}${onset === null
		? '紅線左右 0.5 秒內未找到明確起音，暫以紅線錨定'
		: `已吸附附近起音 ${fmtTime(ref.beatAnchorSec!)}`}（目前共 ${ref.beatAnchorSecs.length} 個錨點）`);
});
clearBeatButton.addEventListener('click', () => {
	const range = currentDetectionRange();
	if (!range) { hint('請先在檢測列標示要清除的範圍'); return; }
	if (!hasReferenceBeatMarkers(range)) { hint('目前檢測範圍沒有節拍標記'); return; }
	const removed = clearReferenceBeatRange(range);
	hint(`已清除檢測範圍內所有節拍標記與錨點（三角形與綠色 X）${removed ? `（${removed} 筆資料）` : '（預覽）'}`);
});
const syncButton = document.getElementById('sync-reference') as HTMLButtonElement;
const tempoBpm = document.getElementById('tempo-bpm') as HTMLInputElement;
const tempoMeter = document.getElementById('tempo-meter') as HTMLSelectElement;
const tempoTolerance = document.getElementById('tempo-tolerance') as HTMLInputElement;
const onsetProminence = document.getElementById('onset-prominence') as HTMLInputElement;
const beatConfirmation = document.getElementById('beat-confirmation') as HTMLInputElement;
const referenceInstrumentProfile=document.getElementById('reference-instrument-profile') as HTMLSelectElement;
referenceInstrumentProfile.addEventListener('change',()=>hint(referenceInstrumentProfile.value==='rhythm'
	?'參考拍點模式：節奏樂器，優先快速且明顯的瞬間起音'
	:'參考拍點模式：旋律樂器，同時評估較慢、較小的音量上升'));
tempoBpm.addEventListener('change', rebuildReferenceBars);
tempoMeter.addEventListener('change', rebuildReferenceBars);
tempoTolerance.addEventListener('change', () => {
	const value = Math.max(1, Math.min(10, Number(tempoTolerance.value) || 5));
	tempoTolerance.value = String(value);
});
onsetProminence.addEventListener('change', () => {
	const value = Math.max(0.5, Math.min(3, Number(onsetProminence.value) || 0.65));
	onsetProminence.value = value.toFixed(2);
});
beatConfirmation.addEventListener('change', () => {
	const value = Math.max(0.3, Math.min(0.9, Number(beatConfirmation.value) || 0.58));
	beatConfirmation.value = value.toFixed(2);
});
function rebuildReferenceBars() {
	++rhythmGeneration;
	referenceBarStarts = [];
	referenceVirtualBarStarts = [];
	referenceBeatsCommitted = false;
	syncedReferenceRhythm = null;
	averageBpmOutput.hidden = true;
	averageBpmOutput.textContent = '';
	const range = currentDetectionRange();
	const rangeAnchor = referenceAnchorInRange(range);
	ref.beatAnchorSec = rangeAnchor;
	document.getElementById('ref-beat-status')!.textContent = !ref.name ? '尚未載入參考音軌'
		: `${referenceBeatRecords.length ? `已記錄 ${referenceBeatRecords.length} 拍 · ` : ''}${ref.beatAnchorSecs.length ? `${ref.beatAnchorSecs.length} 個錨點` : '尚未錨定'}${rangeAnchor === null ? '' : ' · BPM 預覽'}`;
	if (!referenceCache || rangeAnchor === null || !range
		|| hasReferenceBeatsInRange(referenceBeatRecords, range)) { syncReferenceButton(); return; }
	const bpm = Number(tempoBpm.value);
	if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) { syncReferenceButton(); return; }
	referenceBarStarts = referenceBeatPreview(rangeAnchor, bpm, tempoMeter.value,
		Math.max(range.start, 0, ref.offsetSec), Math.min(range.end, referenceCache.duration + ref.offsetSec));
	syncReferenceButton();
}
syncButton.addEventListener('click', () => { if(!syncButton.disabled)void analyzeReferenceTrack(); });
async function analyzeReferenceTrack(): Promise<boolean> {
	if (workState.isBusy) return false;
	const selectedRange = detectionBar.range;
	if (!selectedRange || selectedRange.end <= selectedRange.start) { hint('請先在檢測列標示反白範圍'); return false; }
	const range = { ...selectedRange };
	const rangeAnchor = referenceAnchorInRange(range);
	if (!refAudio || rangeAnchor === null) { hint('請先在目前檢測範圍內設定節拍錨點'); return false; }
	if (hasReferenceBeatsInRange(referenceBeatRecords, range)) {
		hint('檢測範圍已有節拍標記；請先按「清除」或改選沒有節拍資料的範圍');
		return false;
	}
	if (!referenceCache) return false;
	const a = Math.max(0, Math.ceil((range.start - ref.offsetSec) * 100) / 100);
	const b = Math.min(referenceCache.duration, range.end - ref.offsetSec);
	if (b <= a) { hint('檢測範圍與參考音軌沒有重疊'); return false; }
	const rough = Number(tempoBpm.value);
	if (!Number.isFinite(rough) || rough < 30 || rough > 300) { hint('BPM 請輸入 30～300'); return false; }
	const tolerancePercent = Math.max(1, Math.min(10, Number(tempoTolerance.value) || 5));
	tempoTolerance.value = String(tolerancePercent);
	const prominenceThreshold = Math.max(0.5, Math.min(3, Number(onsetProminence.value) || 0.65));
	const confirmationThreshold = Math.max(0.3, Math.min(0.9, Number(beatConfirmation.value) || 0.58));
	onsetProminence.value = prominenceThreshold.toFixed(2);
	beatConfirmation.value = confirmationThreshold.toFixed(2);
	const audio = referenceCache.mono16k.slice(Math.ceil(a * 16000), Math.floor(b * 16000));
	const task = workState.tryBegin('reference', '分析參考音軌節拍與和弦');
	if (!task || !referenceCache) return false;
	referenceBeatsCommitted = false;
	const generation = ++rhythmGeneration;
	const offset = ref.offsetSec, anchorSec = rangeAnchor, meter = tempoMeter.value;
	syncButton.disabled = true;
	try {
		task.update('分析參考音軌節拍');
		const rhythm=await detectLibrosaRhythm({audio,anchorSec:anchorSec-offset-a,bpm:rough,meter,
			bpmTolerance:tolerancePercent/100,onsetProminence:prominenceThreshold,confirmationThreshold,
			instrumentProfile:referenceInstrumentProfile.value==='rhythm'?'rhythm':'melody'});
		task.update('分析每拍和弦');
		const beatTimes=(rhythm.beatTimesSec?.length ? rhythm.beatTimesSec
			: referenceBeatGrid(rhythm.barStartsSec,rhythm.bpm,meter).map(marker=>marker.time))
			.filter(time=>time>=0&&time<audio.length/16000);
		const harmony=await detectLibrosaBeatHarmony(audio,16000,beatTimes,60/rhythm.bpm);
		if(harmony)rhythm.beatHarmony=harmony;
		if (generation !== rhythmGeneration) return false;
		tempoBpm.value = String(rhythm.bpm);
		const analyzedAnchor = rhythm.anchorSec + offset + a;
		setReferenceAnchor(range, analyzedAnchor);
		referenceBarStarts = rhythm.barStartsSec.map(t => t + offset + a);
		referenceVirtualBarStarts = rhythm.virtualBarStartsSec.map(t => t + offset + a);
		syncedReferenceRhythm = { bpm: rhythm.bpm, meter, anchorSec: analyzedAnchor, barStartsSec: [...referenceBarStarts],
			virtualBarStartsSec: [...referenceVirtualBarStarts],
			beatTimesSec: rhythm.beatTimesSec?.map(time => time + offset + a),
			virtualBeatTimesSec: rhythm.virtualBeatTimesSec?.map(time => time + offset + a),
			beatHarmony: rhythm.beatHarmony.map(beat => ({ ...beat, timeSec: beat.timeSec + offset + a,
				pitchClasses: [...beat.pitchClasses], pitchNames: [...beat.pitchNames] })) };
		lastReferenceAnalysisRange = range;
		commitReferenceBeatRecords();referenceBeatsCommitted=referenceBeatRecords.length>0;
		const average = averageBarBpm(referenceBarStarts, rhythm.bpm, meter);
		averageBpmOutput.textContent = average === null
			? `初始 BPM ${rhythm.bpm.toFixed(1)}`
			: `範圍平均 BPM ${average.toFixed(1)}`;
		averageBpmOutput.hidden = false;
		document.getElementById('ref-beat-status')!.textContent = `已分析 · BPM ±${tolerancePercent}% · 突出 ${prominenceThreshold.toFixed(2)} · 確認 ${confirmationThreshold.toFixed(2)} · ${referenceBarStarts.length} 個小節起點 · ${referenceVirtualBarStarts.length} 個虛擬拍點`;
		hint(`參考音軌分析完成：${rhythm.bpm} BPM・${referenceBarStarts.length} 個小節起點・${referenceBeatRecords.filter(row=>row.chord).length} 筆和弦`);
		return true;
	} catch (error) {
		const message = `參考音軌分析失敗：${error instanceof Error ? error.message : String(error)}`;
		hint(message); task.finish(message, true);
		return false;
	}
	finally { task.finish('參考音軌分析結束'); syncReferenceButton(); }
}
/** 讀檔時帶進來、但背景音檔還沒載入的設定。之後載入同名檔時套用 */
let pendingRefSettings: BackgroundSettings | null = null;

const referenceControls = new ReferenceTrackControlsView(document.getElementById('bg-bar')!, {
	load: file => { void loadReference(file); },
	remove: removeReference,
	toggleMute: toggleRefMute,
	changeGain: gainDb => {
		ref.gainDb = gainDb;
		applyRefToPlayer();
	},
	changeOffset: offsetSec => {
		const shift = offsetSec - ref.offsetSec;
		ref.offsetSec = offsetSec;
		ref.beatAnchorSecs = ref.beatAnchorSecs.map(anchor => anchor + shift);
		ref.beatAnchorSec = referenceAnchorInRange(currentDetectionRange()) ?? ref.beatAnchorSecs.at(-1) ?? null;
		referenceBeatRecords = shiftReferenceBeats(referenceBeatRecords, shift);
		if (syncedReferenceRhythm) syncedReferenceRhythm = { ...syncedReferenceRhythm,
			anchorSec: syncedReferenceRhythm.anchorSec + shift,
			barStartsSec: syncedReferenceRhythm.barStartsSec.map(t => t + shift),
			virtualBarStartsSec: syncedReferenceRhythm.virtualBarStartsSec?.map(t => t + shift),
			beatTimesSec: syncedReferenceRhythm.beatTimesSec?.map(t => t + shift),
			virtualBeatTimesSec: syncedReferenceRhythm.virtualBeatTimesSec?.map(t => t + shift),
			beatHarmony: syncedReferenceRhythm.beatHarmony?.map(beat => ({ ...beat, timeSec: beat.timeSec + shift })),
			pitch: syncedReferenceRhythm.pitch?.map(point => ({ ...point, timeSec: point.timeSec + shift })),
		};
		referenceVirtualBarStarts = referenceVirtualBarStarts.map(t => t + shift);
		rebuildReferenceBars();
		applyRefToPlayer();
		hint(`參考音軌 offset ${Math.round(ref.offsetSec * 1000)}ms`);
	},
});

function applyRefToPlayer() {
	player.setBackgroundGain(ref.muted ? 0 : Math.pow(10, ref.gainDb / 20));
	player.setBackgroundOffset(ref.offsetSec);
	refWave.offset = ref.offsetSec;
	refWave.muted = ref.muted;
	syncRefUi();
}

function syncRefUi() {
	referenceControls.render(ref);
	syncReferenceButton();
	anchorButton.classList.toggle('set', ref.beatAnchorSecs.length > 0);
}
function syncReferenceButton() {
	const range = currentDetectionRange();
	const rangeAnchor=referenceAnchorInRange(range);
	syncButton.disabled = !ref.name || !referenceCache || workState.isBusy || !range || rangeAnchor===null || hasReferenceBeatsInRange(referenceBeatRecords,range);
	anchorButton.disabled = !ref.name || !referenceCache || workState.blocksEditing || !range;
	clearBeatButton.disabled = !ref.name || !referenceCache || workState.blocksEditing || !range || !hasReferenceBeatMarkers(range);
	anchorButton.title = !ref.name || !referenceCache ? '請先載入參考音軌' : workState.blocksEditing ? '請等待目前前景工作完成'
		: !range ? '請先在檢測列標示範圍' : '在播放紅線附近新增錨點；若範圍已有拍點，先清除整個範圍再重新錨定';
	clearBeatButton.title = !ref.name || !referenceCache ? '請先載入參考音軌' : workState.blocksEditing ? '請等待目前前景工作完成'
		: !range ? '請先在檢測列標示範圍' : hasReferenceBeatMarkers(range) ? '清除目前檢測範圍內所有節拍標記與錨點' : '目前檢測範圍沒有節拍標記';
	tempoBpm.disabled = workState.isBusy;
	tempoMeter.disabled = workState.isBusy;
	tempoTolerance.disabled = workState.isBusy;
	referenceInstrumentProfile.disabled=workState.isBusy;
	onsetProminence.disabled = workState.isBusy;
	beatConfirmation.disabled = workState.isBusy;
	syncButton.title = !ref.name || !referenceCache ? '請先載入參考音軌' : workState.isBusy ? '請等待目前工作完成' : !range ? '請先設定檢測範圍' : rangeAnchor===null ? '請先在目前範圍設定錨點' : hasReferenceBeatsInRange(referenceBeatRecords,range) ? '目前範圍已有節拍；請先清除後再分析' : '分析目前檢測範圍的參考音軌節拍與和弦';
}

async function loadReference(file: File) {
	const progress = workState.tryBegin('reference', '讀取參考音軌');
	if (!progress) { hint('目前工作尚未完成，請稍後載入參考音軌。'); return; }
	hint(`載入參考音軌 ${file.name}…`);
	try {
		let restoredBeatState = false;
		const audio = await decodeAudio(file, (stage, fraction) => progress.update(`參考音軌：${stage}`, fraction));

		player.setBackground(audio.channels, audio.sampleRate);
		refWave.setAudio(audio.channels, audio.sampleRate);
		refAudio = { channels: audio.channels, sampleRate: audio.sampleRate };
		referenceCache = createReferenceCache(audio.channels, audio.sampleRate);
		++rhythmGeneration;
		referenceBarStarts = [];
		referenceVirtualBarStarts = [];
		referenceBeatRecords = [];
		referenceBeatsCommitted = false;
		lastReferenceAnalysisRange = null;
			ref.name = audio.name;
			ref.fileSize = file.size;
			ref.lastModified = file.lastModified;
		ref.beatAnchorSec = null;
		ref.beatAnchorSecs = [];
		syncedReferenceRhythm = null;
			if (pendingRefSettings && pendingRefSettings.name === audio.name
				&& (pendingRefSettings.fileSize === undefined || pendingRefSettings.fileSize === file.size)
				&& (pendingRefSettings.lastModified === undefined || pendingRefSettings.lastModified === file.lastModified)) {
			ref.gainDb = pendingRefSettings.gainDb;
			ref.muted = pendingRefSettings.muted;
			ref.offsetSec = pendingRefSettings.offsetSec;
			restoreReferenceAnchors(pendingRefSettings);
			referenceBarStarts = pendingRefSettings.barStartsSec?.filter(Number.isFinite) ?? [];
			referenceVirtualBarStarts = pendingRefSettings.virtualBarStartsSec?.filter(Number.isFinite) ?? [];
			referenceBeatRecords = restoreReferenceBeats(pendingRefSettings.beatRecords);
			referenceBeatsCommitted = referenceBeatRecords.length > 0;
			restoredBeatState = referenceBarStarts.length > 0 || referenceBeatRecords.length > 0;
			if (pendingRefSettings.tempoBpm) tempoBpm.value = String(pendingRefSettings.tempoBpm);
			if (pendingRefSettings.tempoMeter) tempoMeter.value = pendingRefSettings.tempoMeter;
			if (pendingRefSettings.tempoTolerancePercent) tempoTolerance.value = String(pendingRefSettings.tempoTolerancePercent);
			if (pendingRefSettings.instrumentProfile==='rhythm'||pendingRefSettings.instrumentProfile==='melody') referenceInstrumentProfile.value=pendingRefSettings.instrumentProfile;
			if (pendingRefSettings.onsetProminenceThreshold) onsetProminence.value = String(pendingRefSettings.onsetProminenceThreshold);
			if (pendingRefSettings.beatConfirmationThreshold) beatConfirmation.value = String(pendingRefSettings.beatConfirmationThreshold);
			if (ref.beatAnchorSec !== null && referenceBarStarts.length) syncedReferenceRhythm = {
				bpm: Number(tempoBpm.value), meter: tempoMeter.value, anchorSec: ref.beatAnchorSec,
				barStartsSec: [...referenceBarStarts], virtualBarStartsSec: [...referenceVirtualBarStarts],
			};
			pendingRefSettings = null;
		}
		applyRefToPlayer();
		progress.finish('參考音軌讀取完成');
		if (restoredBeatState) {
			document.getElementById('ref-beat-status')!.textContent = `已還原 ${referenceBeatRecords.length} 拍 · ${referenceVirtualBarStarts.length} 個虛擬拍點`;
			syncRefUi();
		} else rebuildReferenceBars();
		const mainDur = outDuration();
		hint(source && Math.abs(audio.duration - mainDur) > 0.5
			? `參考音軌 ${fmtTime(audio.duration)} / 主唱 ${fmtTime(mainDur)}，長度不同，可能要調 offset`
			: `已載入參考音軌 ${audio.name}`);
	} catch (e) {
		hint(`解不開參考音檔：${(e as Error).message}`);
		progress.finish(`參考音軌讀取失敗：${(e as Error).message}`, true);
	} finally { progress.finish('參考音軌讀取工作已結束'); }
}

function removeReference(showHint = true) {
	++rhythmGeneration;
	player.setBackground(null);
	refWave.setAudio(null);
	refAudio = null;
	referenceCache = null; referenceBarStarts = []; referenceVirtualBarStarts = [];
	referenceBeatRecords = [];
	referenceBeatsCommitted = false;
	lastReferenceAnalysisRange = null;
	ref.name = null;
	ref.fileSize = null;
	ref.lastModified = null;
	ref.gainDb = 0;
	ref.muted = false;
	ref.offsetSec = 0;
	ref.beatAnchorSec = null;
	ref.beatAnchorSecs = [];
	syncedReferenceRhythm = null;
	pendingRefSettings = null;
	rebuildReferenceBars();
	syncRefUi();
	if(showHint)hint('已移除參考音軌');
}

function toggleRefMute() {
	if (!ref.name) return;
	ref.muted = !ref.muted;
	applyRefToPlayer();
	hint(ref.muted ? '參考音軌靜音' : '參考音軌取消靜音');
}

syncRefUi();

// ── 工具 ────────────────────────────────────────────────────────────────

function sameArray(a: Float32Array, b: Float32Array) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function sameCurves(a: Curves, b: Curves) {
	return sameArray(a.pitch, b.pitch) && sameArray(a.gainDb, b.gainDb) && sameArray(a.formant, b.formant)
		&& a.timeMap.equals(b.timeMap);
}

/** 找出兩份曲線不同的範圍（秒），用來決定復原之後要重算哪裡 */
function diffRange(a: Curves, b: Curves): { from: number; to: number } | null {
	let lo = -1, hi = -1;
	for (let i = 0; i < a.length; i++) {
		if (a.pitch[i] !== b.pitch[i] || a.gainDb[i] !== b.gainDb[i] || a.formant[i] !== b.formant[i]) {
			if (lo < 0) lo = i;
			hi = i;
		}
	}
	return lo < 0 ? null : { from: Curves.frameToTime(lo), to: Curves.frameToTime(hi + 1) };
}

/** 有 pitch 編輯的整個範圍（秒）。改 formant 跟隨比例時要重算這一段。 */
function editedPitchRange(): { from: number; to: number } | null {
	if (!curves) return null;
	let lo = -1, hi = -1;
	for (let i = 0; i < curves.length; i++) {
		if (curves.pitch[i] !== 0) { if (lo < 0) lo = i; hi = i; }
	}
	return lo < 0 ? null : { from: toOut(Curves.frameToTime(lo)), to: toOut(Curves.frameToTime(hi + 1)) };
}

// ── 畫面更新 ────────────────────────────────────────────────────────────

const aiOverlay = new AIRegionOverlay(document.getElementById('pianoroll-wrap')!, async (region, enabled, offset, formantOffset) => {
 if(!curves || !workState.canStart('render')) return;
 const task=workState.tryBegin('render','更新 AI 修正區域'); if(!task)return;
 const feedbackKey={value:editorOptions.keyValue,label:editorOptions.keyLabel,capturedAt:new Date().toISOString()};
 const before=curves.clone(), next=regionCurves(curves,region,enabled,offset,formantOffset);
 try {
  player.pause();
  await renderer.patch(next,toOut(Curves.frameToTime(region.from)),toOut(Curves.frameToTime(region.to)));
  history.push(before);curves=next;manualBaseline=next.clone();
  region.enabled=enabled;region.feedbackKey=feedbackKey;
  if(enabled){
   region.offset=offset;region.formantOffset=formantOffset;
   region.adjusted=next.pitch.slice(region.from,region.to);region.adjustedFormant=next.formant.slice(region.from,region.to);
   region.edited=region.adjusted.some((v,i)=>Math.abs(v-region.ai[i])>1e-6)||region.adjustedFormant.some((v,i)=>Math.abs(v-region.aiFormant[i])>1e-6);
   region.feedbackType=region.edited?'adjusted':undefined;
  }
  else{resetAIRegionToAI(region);region.feedbackType='rejected';}
  selBase=selection?curves.clone():null;sessionPushed=false;resetParams();
  player.setAudio(renderer.rendered,renderer.sampleRate);
  task.finish('AI 區域已更新');
 } catch(error){task.finish(String(error),true);aiToolbar.setStatus(String(error));}
 finally{aiPreviewCurves=null;task.finish('AI 區域更新結束');}
},(region,enabled,offset,formantOffset)=>{
 if(!region||!curves){aiPreviewCurves=null;return;}
 aiPreviewCurves=regionCurves(curves,region,enabled??region.enabled,offset??region.offset,formantOffset??region.formantOffset);
});
// 黃框位於 canvas 上方，是 canvas 的兄弟節點；事件不會冒泡到 canvas，必須綁定同一套縮放手勢。
bindZoomGesture(aiOverlay.gestureTarget, zoomTimelineAtPointer, () => source !== null);
async function completeAIReview() {
	 if(!curves || !trainingAsset || workState.isBusy)return false;
 if(!aiReview){
  const count=aiRegions.length;aiRegions=[];aiOverlay.clear();syncAIControls();
  trainingStatus.textContent=`已清除檢測檔案載入的 ${count} 個黃框；這些黃框沒有本次工作階段音訊，因此不建立訓練資料`;
	  return true;
 }
	 const task=workState.tryBegin('render','整理 AI 修正回饋');if(!task)return false;
	 let completed=false;
 try {
  for(const region of aiRegions)syncAIRegion(region,curves);
  // 不從曲線差異推測使用者意圖；只保存黃框互動明確留下的分類。
  const feedback=reviewedAIRegions(aiRegions),untouched=aiRegions.length-feedback.length;let rejectedSaved=0,adjustedStaged=0,skipped=0;
  for(const region of feedback){
   const range={start:toOut(Curves.frameToTime(region.from)),end:toOut(Curves.frameToTime(region.to))};
   if(range.end-range.start>5){skipped++;continue;}
   const audio=aiReview.audio.get(region.id);if(!audio){skipped++;continue;}
   const reviewSource=aiReview.sources.get(region.id)??aiReview.runs.find(run=>rangesOverlap(run.input.range,range))??aiReview.runs.at(-1);
   if(!reviewSource){skipped++;continue;}
   const {input,keyLabel,proposal}=reviewSource;
   task.update(`保存 AI 修正回饋 ${rejectedSaved+adjustedStaged+1}/${feedback.length}`);
   const sr=renderer.sampleRate;
   const feedbackType=region.feedbackType!;
   const pair=await prepareTrainingPair({before:proposal,after:curves,beforeAudio:audio.channels,
    afterAudio:renderer.rendered.map(c=>c.slice(Math.round(audio.start*sr),Math.round(audio.end*sr))),
    midi:pitchMidi!,voiced:curveVoiced!,start:audio.start,end:audio.end,sampleRate:sr,
    key:KEY_OPTIONS.find(k=>k.id===(region.feedbackKey?.value ?? input.key.id))??null,
    metadata:{asset:trainingAsset,operation:feedbackType==='adjusted'?'AI 修正後人工調整':'取消 AI 修正',editRange:range,
     keySelection:region.feedbackKey ?? {value:input.key.id,label:keyLabel},
     aiKey:input.key,aiKeyLabel:keyLabel,feedbackType,
     correctionKind:region.kind,aiLevel:input.level,manualOffset:region.offset,
     audioComparison:region.kind==='manual'?'before=manual selection baseline; after=user adjusted result':'before=AI proposal; after=user accepted result',
     originalPitch:Array.from(input.curves.pitch.slice(region.from,region.to)),
     detectionRange:input.range,selection:range}});
   pair.metadata.recordId=region.recordId;
   if(feedbackType==='adjusted'){await stageTrainingPair(pair);adjustedStaged++;}
   else{await storeRejectedTrainingPair(pair);rejectedSaved++;}
   // Completed records are finalized individually, so retries cannot reuse stale feedback.
   aiRegions=aiRegions.filter(r=>r.id!==region.id);aiOverlay.clear();
  }
  aiRegions=[];aiReview=null;aiOverlay.clear();
  trainingStatus.textContent=feedback.length
   ? `取消修正已正式保存 ${rejectedSaved} 筆；人工調整已暫存 ${adjustedStaged} 筆；未操作黃框 ${untouched} 筆不記錄${skipped?`；略過 ${skipped} 筆（超過 5 秒或無可用音訊）`:''}${adjustedStaged?'，匯出 WAV 時保存人工調整資料':''}`
   : `沒有取消勾選或人工重新調整的黃框；${untouched} 筆未操作黃框不建立訓練記錄`;
  task.finish('AI 修正標示已取消，聲音保留目前狀態');
	  completed=true;
	 }catch(error){task.finish(String(error),true);trainingStatus.textContent=`回饋保存失敗，黃框保留供重試：${String(error)}`;}
 finally{task.finish('AI 回饋工作結束');}
	 return completed;
}

const aiSettings = new AISettingsView(document.getElementById('ai-settings-dialog') as HTMLDialogElement, () => {
	aiToolbar.setService(aiSettings.label);
		aiToolbar.setStatus(aiSettings.ready ? '設定已套用；調整程度後按 AI 修正' : aiSettings.label);
		updateAIStrengthText();
		syncAIControls();
});
aiToolbar.setService(aiSettings.label);
void (async () => {
	aiSettings.setBuiltinAIState(false, '正在檢查本機訓練資料');
	try {
		const result = await updateBuiltinAIModel();
		const counts = result.model.counts;
		aiSettings.setBuiltinAIState(true, `${counts.used} 筆可用${result.updated ? '，模型已更新' : '，模型為最新'}`);
		if (aiSettings.settings.provider === 'builtin-ai') aiToolbar.setStatus(`內建 AI 已就緒：手動 ${counts.manual}、拒絕 ${counts.rejected}、再次調整 ${counts.adjusted}，實際採用 ${counts.used} 筆`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		aiSettings.setBuiltinAIState(false, `無法使用：${message}`);
		if (aiSettings.settings.provider === 'builtin-ai') aiToolbar.setStatus(`內建 AI 無法使用：${message}`);
	}
})();
const aiFlow = new AICorrectionFlow({
	workState,
	pausePlayback: () => { player.pause(); syncPlayButton(); },
	sameCurves,
	render: (next, range) => renderer.patch(next, range.start, range.end),
	pushHistory: before => history.push(before),
	commitCurves: next => {
		curves = next;
		manualBaseline = next.clone();
		selBase = selection ? next.clone() : null;
		sessionPushed = false;
		resetParams();
	},
	updatePlayback: () => player.setAudio(renderer.rendered, renderer.sampleRate),
	scheduleBackground: range => scheduleBackground({ from: range.start, to: range.end }),
	collectNotes: collectCorrectionNotesParallel,
});
function updateAIStrengthText() {
	const level = aiToolbar.level;
	if (aiSettings.settings.provider === 'rules') {
		const milliseconds = ruleMinimumDurationMs(level);
		aiToolbar.setStrengthDisplay({ text: `${level} / 10 · ≥${milliseconds}ms`, title: `傳統模式第 ${level} 級：同方向偏離至少持續 ${milliseconds} ms 才修正（固定容許帶 5 cents）；入選後完整修正中心。`, ariaValueText: `${level} 級，修正連續偏離至少 ${milliseconds} 毫秒的區段` });
	} else {
		aiToolbar.setStrengthDisplay({ text: `${level} / 10 · ${level * 10}%`, title: `AI 模式第 ${level} 級：將模型選中的音符中心向目標修正 ${level * 10}%。`, ariaValueText: `${level} 級，修正音符中心偏差的 ${level * 10}%` });
	}
}
updateAIStrengthText();
async function discardAICorrection() {
	if (!curves || !aiReview || workState.isBusy) return;
	const task=workState.tryBegin('render','放棄 AI 修改');if(!task)return;
	const target=aiReview.baseline.clone();
	const restoreRanges=[...aiReview.runs.map(run=>run.input.range),...aiRegions.map(region=>({
		start:toOut(Curves.frameToTime(region.from)),end:toOut(Curves.frameToTime(region.to)),
	}))];
	try {
		player.pause();syncPlayButton();
		task.update('還原 AI 修音前資料');
		for(const range of restoreRanges)await renderer.patch(target,range.start,range.end);
		curves=target;manualBaseline=target.clone();history.truncate(aiReview.historyDepth);
		aiRegions=[];aiReview=null;aiOverlay.clear();clearSelection();selectedAnchors.clear();
		player.setAudio(renderer.rendered,renderer.sampleRate);resetParams();syncToolbar();
		aiToolbar.setStatus('已放棄 AI 修改，整個音頻已回復到 AI 調音前；參考節拍與和弦保留不變');
		hint('已放棄 AI 修改，整個音頻已回復到 AI 調音前；參考節拍與和弦保留不變');
		task.finish('AI 修改已取消');
	}catch(error){const message=`放棄 AI 修改失敗：${error instanceof Error?error.message:String(error)}`;aiToolbar.setStatus(message);task.finish(message,true);}
	finally{task.finish('放棄 AI 修改工作結束');syncAIControls();}
}
function cancelAICorrection() { if (aiFlow.cancel()) aiToolbar.setCancelDisabled(true); }

function rangesOverlap(a:TimeRange,b:TimeRange):boolean {
	return a.start < b.end && a.end > b.start;
}

function aiDetectionConflict(range:TimeRange):'yellow'|null {
	if(aiRegions.some(region=>rangesOverlap(range,{
		start:toOut(Curves.frameToTime(region.from)),end:toOut(Curves.frameToTime(region.to)),
	})))return 'yellow';
	return null;
}

function syncAIControls() {
	syncReferenceButton();
	const locked = workState.isBusy;
	const range = detectionBar.range;
	const conflict=range&&range.end>range.start?aiDetectionConflict(range):null;
	const correctDisabled = locked || !aiReady || !aiSettings.ready || !curves || !pitchMidi || !curveVoiced || !editorOptions.keyValue || !range || range.end <= range.start || !!conflict;
	aiToolbar.setControls({
		disabled: locked,
		correct: correctDisabled,
		correctTitle: locked ? '請等待目前工作完成' : !aiReady ? '主音檔音高分析尚未完成' : !aiSettings.ready ? '請先完成 AI 設定' : !editorOptions.keyValue ? '請先選擇 Key（不能是全部音）' : !range || range.end <= range.start ? '請先在檢測列標示範圍' : conflict==='yellow' ? '此檢測範圍已有黃框；請改選尚未檢測的範圍' : '只分析主要音頻並產生黃框；不會執行參考音軌分析',
		discard: locked || !aiReady || !aiReview || !aiRegions.length,
		discardTitle: aiRegions.length ? '放棄本次 AI 修音及黃框內人工調整；參考節拍與和弦不受影響' : '目前沒有可取消的 AI 修改',
		complete: locked || !aiRegions.length,
	});
	toolLaneControls.setDisabled(!!aiRegions.length || locked);
	syncToolbar();
}

async function startAICorrection() {
	if (!source || !curves || !pitchMidi || !curveVoiced || drag || aiFlow.running) return 'invalid' as const;
	const key = KEY_OPTIONS.find(k => k.id === editorOptions.keyValue);
	const range = detectionBar.range;
	if (!key || !range || range.end <= range.start) return 'invalid' as const;
	const conflict=aiDetectionConflict(range);
	if(conflict){
		const message='檢測範圍已有黃框；請改選沒有黃框的範圍';
		aiToolbar.setStatus(message);hint(message);syncAIControls();return 'invalid' as const;
	}
	const sourceStart = curves.timeMap.outToSrc(range.start);
	const sourceEnd = curves.timeMap.outToSrc(range.end);
	const segments = planBalancedAudioSegments(source.channels, source.sampleRate, {
		start: sourceStart, end: sourceEnd, segmentCount: availableParallelWorkers('cpu'),
	})
		.map(segment => ({ start: curves!.timeMap.srcToOut(segment.start), end: curves!.timeMap.srcToOut(segment.end) }));
	const historyDepthBeforeAI=history.depth;
	const referenceRhythm=referenceRhythmForRange(referenceBeatRecords,range,Number(tempoBpm.value),tempoMeter.value,syncedReferenceRhythm);
	const outcome = await aiFlow.run({
		curves, midi: pitchMidi, voiced: curveVoiced, key, range, segments,
		level: aiToolbar.level, settings: aiSettings.settings, formantFollow: renderer.formantFollow,
		referenceRhythm,
	}, update => {
		aiToolbar.setStatus(update.message);
		aiToolbar.setCancelDisabled(!update.cancellable);
	});
	switch (outcome.status) {
		case 'completed': {
			const { settings, key, level, range } = outcome.input;
			// AICorrectionFlow has committed the corrected curves by this point. Keep the
			// pre/post curve pair and the rendered AI audio so every returned region can
			// be reviewed independently and later exported as training feedback.
			const nextId=aiRegions.reduce((id,region)=>Math.max(id,region.id+1),0);
			const newRegions=createAIRegions(outcome.input.curves,curves!,outcome.regions)
				.map((region,index)=>({...region,id:nextId+index}));
			const proposal=curves!.clone();
			const reviewSource:AIReviewSource={input:outcome.input,proposal,keyLabel:key.label};
			if(!aiReview)aiReview={baseline:outcome.input.curves.clone(),audio:new Map(),historyDepth:historyDepthBeforeAI,
				sources:new Map(),runs:[]};
			aiReview.runs.push(reviewSource);
			const duration = renderer.rendered[0]?.length / renderer.sampleRate || 0;
			for (const region of newRegions) {
				aiReview.sources.set(region.id,reviewSource);
				const regionStart = toOut(Curves.frameToTime(region.from));
				const regionEnd = toOut(Curves.frameToTime(region.to));
				if (regionEnd - regionStart > 5) continue;
				const start = Math.max(0, regionStart - 3);
				const end = Math.min(duration, regionEnd + 3);
				const fromSample = Math.round(start * renderer.sampleRate);
				const toSample = Math.round(end * renderer.sampleRate);
				aiReview.audio.set(region.id, {
					start, end,
					channels: renderer.rendered.map(channel => channel.slice(fromSample, toSample)),
				});
			}
			aiRegions.push(...newRegions);
			clearSelection();setActiveLane('pitch');setTool('select');
			aiToolbar.setStatus(`${settings.provider === 'rules' ? '傳統內建修正' : settings.provider === 'builtin-ai' ? '內建 AI 修正' : '外部 AI 修正'}完成：新增 ${newRegions.length} 個黃框（目前共 ${aiRegions.length} 個） · ${outcome.segmentCount} 個低音壓分段 · ${key.label} · ${level}/10 · ${fmtTime(range.start)}～${fmtTime(range.end)}`);
			break;
		}
		case 'unchanged': {
			aiToolbar.setStatus('沒有需要修正的穩定音符；不確定的音符保留原樣');
			break;
		}
		case 'cancelled':
		case 'failed':
			aiToolbar.setStatus(outcome.message);
			break;
		case 'busy': break;
	}
	syncAIControls();
	return outcome.status;
	}

function commitReferenceBeatRecords() {
	if (!syncedReferenceRhythm || !lastReferenceAnalysisRange) return;
	referenceBeatRecords = mergeReferenceBeats(referenceBeatRecords, syncedReferenceRhythm.barStartsSec,
		syncedReferenceRhythm.bpm, syncedReferenceRhythm.meter, lastReferenceAnalysisRange,
		syncedReferenceRhythm.virtualBarStartsSec, syncedReferenceRhythm.beatHarmony,
		syncedReferenceRhythm.beatTimesSec, syncedReferenceRhythm.virtualBeatTimesSec);
	const chordCount = referenceBeatRecords.filter(row => referenceBeatInRange(row.timeSec, lastReferenceAnalysisRange!) && row.chord).length;
	document.getElementById('ref-beat-status')!.textContent = `已記錄 ${referenceBeatRecords.length} 拍 · 本次 ${referenceBarStarts.length} 個小節起點 · ${chordCount} 拍和弦`;
}

workState.subscribe(state => {
	progressView.render(state.progress);
	computeControl.sync();
	const ai = workState.has('ai');
	aiToolbar.setBusy(ai);
	// Keep playback available during ordinary rendering; all editing follows one policy.
	el.stage.inert = state.blocksEditing;
	globalControls.setInert(state.blocksEditing);
	inspector.setInert(state.blocksEditing);
	headerPanel.setInert(ai);
	headerPanel.setActions({
		canOpenAudio: workState.canStart('load'),
		canOpenProject: workState.canStart('project'),
		canExport: !!source && !!curves && workState.canStart('export'),
		canOverwrite: !!source && !!curves && !!sourceWritebackPath && workState.canStart('export'),
		canSave: !!source && !!curves && !state.blocksEditing,
	});
	referenceControls.setDisabled(!workState.canStart('reference'));
	syncAIControls();
});

const displayCoordinator = new DisplayCoordinator({
 readState: () => ({
  loaded: !!source, selection, curves, previewCurves: aiPreviewCurves, renderingRange,
  selectedAnchors, aiRegions, pitchMidi, beatAnchors: ref.beatAnchorSecs,
  barStarts: referenceBarStarts, virtualBarStarts: referenceVirtualBarStarts, bpm: Number(tempoBpm.value), meter: tempoMeter.value,
  analyzedBeats: referenceBeatsCommitted, beatRecords: ref.name ? referenceBeatRecords : [], locked: workState.isBusy,
 }),
 playback: player, waveform, referenceWaveform: refWave, pianoroll, aiOverlay,
 timeToX: time => view.timeToX(time),
 pitchHeight: () => el.pianoroll.clientHeight,
 setPosition: position => transport.setPosition(fmtTime(position)),
 followPosition: applyFollow,
 autoScrollDrag: autoScrollAnchorDrag,
 syncControls: () => { computeControl.sync(); syncAIControls(); },
 syncNavigation: () => { detectionBar.sync(); hbar.sync(); vbar.sync(); },
});
displayCoordinator.start();
import.meta.hot?.dispose(() => displayCoordinator.stop());

// Test hooks and URL fixtures are deliberately excluded from production builds.
if (import.meta.env.DEV) {
 void import('./dev/diagnostics').then(({ installDiagnostics }) => {
  diagnostics = installDiagnostics({
   get curves() { return curves; },
   get source() { return source; },
   get track() { return track; },
   get selection() { return selection; },
   get pitchMidi() { return pitchMidi; },
   get curveVoiced() { return curveVoiced; },
   get followPlayhead() { return followPlayhead; },
   get selectedAnchors() { return selectedAnchors; },

   get backgroundWaiting() { return !!bgTimer || !!bgPendingRange; },
	   view, player, renderer, history, pianoroll, waveform, refWave, ref, el: {
		...el,
		vibOn: document.getElementById('vib-on') as HTMLInputElement,
		vibDepth: document.getElementById('vib-depth') as HTMLInputElement,
		vibOnsetOn: document.getElementById('vib-onset-on') as HTMLInputElement,
		vibOnset: document.getElementById('vib-onset') as HTMLInputElement,
		bgStatus: document.getElementById('bg-status')!,
	},
   toSrc, toOut, outDuration, waitBackground, rerender, remapSelection, applyTimeMap, load, status,
  }, window, location.search);
  import.meta.hot?.dispose(() => diagnostics?.dispose());
  return diagnostics.autoload();
 });
}
