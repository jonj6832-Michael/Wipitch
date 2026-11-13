import { trainingServer } from './tools/training-server.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

interface PythonRuntime { command: string; prefix: string[] }
function findLibrosaPython(root: string): PythonRuntime | null {
	const candidates: PythonRuntime[] = process.platform === 'win32' ? [
		...(process.env.WIPITCH_PYTHON ? [{ command: process.env.WIPITCH_PYTHON, prefix: [] }] : []),
		{ command: join(root, '.venv', 'Scripts', 'python.exe'), prefix: [] },
		{ command: 'py', prefix: ['-3'] }, { command: 'python', prefix: [] },
	] : [
		...(process.env.WIPITCH_PYTHON ? [{ command: process.env.WIPITCH_PYTHON, prefix: [] }] : []),
		{ command: join(root, '.venv', 'bin', 'python'), prefix: [] },
		{ command: 'python3', prefix: [] }, { command: '/usr/bin/python3', prefix: [] },
	];
	for (const candidate of candidates) {
		const check = spawnSync(candidate.command, [...candidate.prefix, '-c', 'import librosa, numpy'],
			{ cwd: root, stdio: 'ignore' });
		if (check.status === 0) return candidate;
	}
	return null;
}

function runPythonAnalysis(req: any, res: any, cwd: string, python: PythonRuntime | null,
	script: string, args: string[]) {
	const chunks: Buffer[] = [];
	let replied = false;
	const reply = (status: number, payload: Buffer | string) => {
		if (replied || res.destroyed) return;
		replied = true; res.statusCode = status;
		res.setHeader('Content-Type', 'application/json'); res.end(payload);
	};
	req.on('data', (chunk: Buffer) => chunks.push(chunk));
	req.on('error', (error: Error) => reply(400, JSON.stringify({ error: `音訊請求讀取失敗：${error.message}` })));
	req.on('aborted', () => { replied = true; });
	req.on('end', () => {
		if (!python) {
			reply(503, JSON.stringify({ error: '找不到已安裝 Librosa 與 NumPy 的 Python；請重新執行安裝流程' }));
			return;
		}
		const child = spawn(python.command, [...python.prefix, script, ...args], { cwd });
		const output: Buffer[] = [], errors: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
		child.stdin.on('error', (error: Error) => errors.push(Buffer.from(`\nstdin: ${error.message}`)));
		child.on('error', (error: Error) => reply(503,
			JSON.stringify({ error: `無法啟動 Python 分析器：${error.message}` })));
		child.on('close', code => reply(code === 0 ? 200 : 503, code === 0
			? Buffer.concat(output) : JSON.stringify({ error: Buffer.concat(errors).toString() })));
		child.stdin.end(Buffer.concat(chunks));
	});
}
const buildTime = new Intl.DateTimeFormat('zh-TW', {
	timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
	hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date());
const projectRoot = process.cwd();
const librosaPython = findLibrosaPython(projectRoot);
// 相對路徑：build 出來的 dist/ 放在網域根目錄或任何子目錄（例如 /wipitch/）都能用。
export default {
	base: './',
 define: { __BUILD_TIME__: JSON.stringify(buildTime) },
	// CPU 與 GPU 音高引擎使用不同入口，都必須在首次啟動 Worker 前完成最佳化。
	// 這些套件只會在首次載入音檔時由 Worker 動態引入。若不預先最佳化，
	// Vite 會在分析開始後才建立快取，並以「optimized dependencies changed」重載整頁。
	optimizeDeps: { include: ['rubberband-wasm', 'onnxruntime-web/wasm', 'onnxruntime-web/webgpu'] },
 server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/AI訓練/**', '**/AI訓練暫存/**'] } },
 plugins: [{
	name: 'wipitch-build-time',
	transformIndexHtml(html: string) {
		return html.replace('__WIPITCH_BUILD_TIME__', buildTime);
	},
 }, trainingServer(), {
	name: 'wipitch-librosa-chords',
	configureServer(server: any) {
		server.middlewares.use('/__analysis/librosa-chords', (req: any, res: any) => {
			if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
			const url = new URL(req.url ?? '/', 'http://localhost');
			const sampleRate = Number(url.searchParams.get('sampleRate'));
			const beatTimes = url.searchParams.get('beatTimes');
			const fallback = Number(url.searchParams.get('fallbackBeatDuration') ?? '0.5');
			if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !beatTimes) {
				res.statusCode = 400; res.end('invalid analysis parameters'); return;
			}
			runPythonAnalysis(req, res, server.config.root, librosaPython, 'tools/librosa-chords.py',
				['--sample-rate', String(sampleRate), '--beat-times', beatTimes,
					'--fallback-beat-duration', String(fallback)]);
		},);
	},
 }, {
	name: 'wipitch-librosa-rhythm',
	configureServer(server: any) {
		server.middlewares.use('/__analysis/librosa-rhythm', (req: any, res: any) => {
			if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
			const url = new URL(req.url ?? '/', 'http://localhost');
			const sampleRate = Number(url.searchParams.get('sampleRate'));
			const anchorSec = Number(url.searchParams.get('anchorSec'));
			const bpm = Number(url.searchParams.get('bpm'));
			const bpmTolerance = Number(url.searchParams.get('bpmTolerance') ?? '0.05');
			const onsetProminence = Number(url.searchParams.get('onsetProminence') ?? '0.65');
			const confirmationThreshold = Number(url.searchParams.get('confirmationThreshold') ?? '0.58');
			const instrumentProfile = url.searchParams.get('instrumentProfile') === 'rhythm' ? 'rhythm' : 'melody';
			const meter = url.searchParams.get('meter');
			if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isFinite(anchorSec)
				|| !Number.isFinite(bpm) || !meter) { res.statusCode = 400; res.end('invalid rhythm parameters'); return; }
			runPythonAnalysis(req, res, server.config.root, librosaPython, 'tools/librosa-rhythm.py',
				['--sample-rate', String(sampleRate), '--anchor-sec', String(anchorSec),
					'--bpm', String(bpm), '--meter', meter,'--bpm-tolerance',String(bpmTolerance),
					'--onset-prominence',String(onsetProminence),'--confirmation-threshold',String(confirmationThreshold),
					'--instrument-profile',instrumentProfile]);
		});
	},
 }],
};
