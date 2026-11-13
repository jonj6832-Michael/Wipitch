// WiPitch 離線版的靜態伺服器：只用 Node 內建模組，不需要 npm。
// 用法：node serve.mjs（PORT、HOST 環境變數可以改位址）
import { createServer } from 'node:http';
import { createReadStream, statSync, constants } from 'node:fs';
import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
let localAudioModule;
try { localAudioModule = await import('../local-audio.mjs'); }
catch { localAudioModule = await import('./local-audio.mjs'); }
const { inspectLocalAudio, pickAudioPath, streamLocalAudio } = localAudioModule;

const root = join(dirname(fileURLToPath(import.meta.url)), 'app');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 5180;
const python = process.env.WIPITCH_PYTHON || join(dirname(fileURLToPath(import.meta.url)), '.venv', 'bin', 'python');
const localToken = randomUUID();
let fileQueue = Promise.resolve();
const enqueueFile = job => { const pending=fileQueue.then(job);fileQueue=pending.catch(()=>{});return pending; };

const types = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.wasm': 'application/wasm',
	'.onnx': 'application/octet-stream',
	'.wav': 'audio/wav',
};

function resolveFile(urlPath) {
	let rel;
	try { rel = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
	const file = normalize(join(root, rel));
	if (file !== root && !file.startsWith(root + sep)) return null;
	try {
		const st = statSync(file);
		if (st.isFile()) return file;
		if (st.isDirectory()) return resolveFile(join(rel, 'index.html'));
	} catch {}
	return null;
}

function readBody(req, maximum = 512 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];let bytes=0;
		req.on('data', chunk => {bytes+=chunk.length;if(bytes>maximum){reject(new Error('請求內容超過大小限制'));req.destroy();return;}chunks.push(chunk);});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function localRequestAllowed(req) {
	const remote=req.socket.remoteAddress||'';
	const loopback=remote==='::1'||remote.startsWith('127.')||remote.startsWith('::ffff:127.');
	const requestHost=req.headers.host||'';
	return loopback&&/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestHost)
		&&(!req.headers.origin||req.headers.origin===`http://${requestHost}`)
		&&(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']));
}

async function localFileEndpoint(req,res,requestUrl){
	if(!requestUrl.pathname.startsWith('/__training/'))return false;
	const route=requestUrl.pathname.slice('/__training'.length);
	const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
	if(!localRequestAllowed(req)){reply(403,{error:'僅允許本機同來源存取'});return true;}
	if(req.method==='GET'&&route==='/config'){reply(200,{token:localToken,capabilities:{pickAudio:['darwin','win32'].includes(process.platform),readAudio:true,writeAudio:true,projectFiles:true}});return true;}
	if(req.method!=='POST'||req.headers['x-training-token']!==localToken){reply(403,{error:'無效的本機檔案請求'});return true;}
	try{
		if(route==='/write-audio'){
			const body=await readBody(req);
			if(body.length<44||body.subarray(0,4).toString('ascii')!=='RIFF'||body.subarray(8,12).toString('ascii')!=='WAVE')throw new Error('回存內容不是有效的 WAV 音訊');
			const result=await enqueueFile(async()=>{
				const requested=decodeURIComponent(String(req.headers['x-audio-path']||''));
				const audio=await inspectLocalAudio(requested),extension=extname(audio.path).toLowerCase();
				if(!['.wav','.wave'].includes(extension))throw new Error('離線版目前只支援 WAV/WAVE 原檔回存；其他格式請使用完整工作站');
				const base=basename(audio.path,extension),backupPath=join(dirname(audio.path),`${base}.wipitch-original${extension}`);
				try{await copyFile(audio.path,backupPath,constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST')throw error;const backup=await inspectLocalAudio(backupPath);if(backup.size<44)throw new Error('既有原始音訊備份已損壞，本次不覆寫原檔');}
				const temporary=join(dirname(audio.path),`.wipitch-write-${randomUUID()}${extension}`);
				try{await writeFile(temporary,body);await rename(temporary,audio.path);}finally{await rm(temporary,{force:true});}
				return{path:audio.path,backupPath};
			});reply(200,result);return true;
		}
		const body=JSON.parse((await readBody(req,route==='/write-project'?128*1024*1024:1024*1024)).toString()||'{}');
		if(route==='/pick-audio'){const selected=await pickAudioPath();reply(selected?200:409,selected?await inspectLocalAudio(selected):{cancelled:true});return true;}
		if(route==='/read-audio'){return streamLocalAudio(res,await inspectLocalAudio(body.path)),true;}
		if(route==='/find-project'){
			const audio=await inspectLocalAudio(body.path),extension=extname(audio.path),base=basename(audio.path,extension);
			const candidates=[`${base}.wipitch.json`,`${base}.wipitch-detection.json`].map(name=>join(dirname(audio.path),name));
			const found=[];for(const candidate of candidates){try{const info=await stat(candidate);if(info.isFile())found.push({candidate,mtime:info.mtimeMs});}catch(error){if(error.code!=='ENOENT')throw error;}}
			if(!found.length){reply(404,{missing:true});return true;}const selected=found.sort((a,b)=>b.mtime-a.mtime)[0].candidate;
			reply(200,{path:selected,name:basename(selected),text:await readFile(selected,'utf8')});return true;
		}
		if(route==='/write-project'){
			const result=await enqueueFile(async()=>{const audio=await inspectLocalAudio(body.path);if(typeof body.text!=='string'||body.text.length>128*1024*1024)throw new Error('檢測檔案內容無效或過大');
				const parsed=JSON.parse(body.text);if(parsed?.format!=='wipitch-project')throw new Error('檢測檔案格式無效');
				const extension=extname(audio.path),base=basename(audio.path,extension),name=`${base}.wipitch.json`,destination=join(dirname(audio.path),name),temporary=join(dirname(audio.path),`.wipitch-project-${randomUUID()}.json`);
				try{await writeFile(temporary,body.text);await rename(temporary,destination);}finally{await rm(temporary,{force:true});}return{path:destination,name};});reply(200,result);return true;
		}
		reply(404,{error:'未知的本機檔案操作'});
	}catch(error){if(!res.destroyed)reply(500,{error:error.message});}
	return true;
}

async function analysisEndpoint(req, res, script, args) {
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return true; }
	try {
		const body = await readBody(req);
		const child = spawn(python, [join(dirname(fileURLToPath(import.meta.url)), script), ...args]);
		const output = [], errors = [];
		let replied = false;
		const reply = (status, payload) => {
			if (replied || res.destroyed) return;
			replied = true; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(payload);
		};
		child.stdout.on('data', chunk => output.push(chunk));
		child.stderr.on('data', chunk => errors.push(chunk));
		child.stdin.on('error', error => errors.push(Buffer.from(`\nstdin: ${error.message}`)));
		child.on('error', error => reply(503, JSON.stringify({ error: `無法啟動 Python 分析器：${error.message}` })));
		child.on('close', code => reply(code === 0 ? 200 : 503,
			code === 0 ? Buffer.concat(output) : JSON.stringify({ error: Buffer.concat(errors).toString() })));
		child.stdin.end(body);
	} catch (error) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: String(error) }));
	}
	return true;
}

createServer(async (req, res) => {
	const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
	if(await localFileEndpoint(req,res,requestUrl))return;
	if (requestUrl.pathname === '/__analysis/librosa-rhythm') {
		const meter = requestUrl.searchParams.get('meter') || '';
		if (!/^([234])\/[0-9]+$/.test(meter)) { res.writeHead(400); res.end('invalid meter'); return; }
		await analysisEndpoint(req, res, 'librosa-rhythm.py', ['--sample-rate', requestUrl.searchParams.get('sampleRate') || '16000',
			'--anchor-sec', requestUrl.searchParams.get('anchorSec') || '0', '--bpm', requestUrl.searchParams.get('bpm') || '120', '--meter', meter,
			'--bpm-tolerance',requestUrl.searchParams.get('bpmTolerance')||'0.05','--onset-prominence',requestUrl.searchParams.get('onsetProminence')||'0.65',
			'--confirmation-threshold',requestUrl.searchParams.get('confirmationThreshold')||'0.58',
			'--instrument-profile',requestUrl.searchParams.get('instrumentProfile')==='rhythm'?'rhythm':'melody']);
		return;
	}
	if (requestUrl.pathname === '/__analysis/librosa-chords') {
		await analysisEndpoint(req, res, 'librosa-chords.py', ['--sample-rate', requestUrl.searchParams.get('sampleRate') || '16000',
			'--beat-times', requestUrl.searchParams.get('beatTimes') || '[]', '--fallback-beat-duration', requestUrl.searchParams.get('fallbackBeatDuration') || '0.5']);
		return;
	}
	const file = resolveFile(req.url || '/') ?? (extname(req.url || '') ? null : join(root, 'index.html'));
	if (!file) { res.writeHead(404); res.end('Not found'); return; }
	res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
	createReadStream(file).pipe(res);
}).listen(port, host, () => {
	const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
	console.log(`WiPitch 已啟動：${url}（按 Ctrl+C 結束）`);
	if (process.env.NO_OPEN) return;
	const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
	spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}).on('error', e => {
	console.error(e.code === 'EADDRINUSE' ? `連接埠 ${port} 已被佔用，可以用 PORT=5181 ./start.sh 換一個。` : e.message);
	process.exit(1);
});
