import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const AUDIO_TYPES = new Map([
	['.wav', 'audio/wav'], ['.wave', 'audio/wav'], ['.mp3', 'audio/mpeg'],
	['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'], ['.flac', 'audio/flac'],
	['.aif', 'audio/aiff'], ['.aiff', 'audio/aiff'], ['.ogg', 'audio/ogg'], ['.opus', 'audio/ogg'],
]);

export async function inspectLocalAudio(inputPath) {
	if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) throw new Error('音訊路徑必須是絕對路徑');
	const extension = path.extname(inputPath).toLowerCase();
	const type = AUDIO_TYPES.get(extension);
	if (!type) throw new Error('專案記錄的路徑不是支援的音訊格式');
	let resolved;
	try { resolved = await realpath(inputPath); }
	catch (error) { if (error.code === 'ENOENT') throw new Error(`找不到原始音訊：${inputPath}`); throw error; }
	const info = await stat(resolved);
	if (!info.isFile()) throw new Error('專案記錄的音訊路徑不是檔案');
	return { path: resolved, name: path.basename(resolved), size: info.size, lastModified: info.mtimeMs, type };
}

export function pickAudioPath() {
	if (process.platform !== 'darwin') return Promise.reject(new Error('目前的本機檔案選擇器僅支援 macOS'));
	return new Promise((resolve, reject) => {
		const script = 'set selectedFile to choose file with prompt "選擇 WiPitch 音訊檔" of type {"public.audio"}\nPOSIX path of selectedFile';
		const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '', errorText = '';
		child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { errorText += chunk; });
		child.on('error', reject);
		child.on('exit', code => {
			if (code === 0) resolve(output.trim());
			else if (code === 1 && /cancel|取消/i.test(errorText)) resolve(null);
			else reject(new Error(errorText.trim() || '無法開啟音訊選擇器'));
		});
	});
}

export function streamLocalAudio(res, audio) {
	res.statusCode = 200;
	res.setHeader('Content-Type', audio.type);
	res.setHeader('Content-Length', String(audio.size));
	res.setHeader('X-Audio-Name', encodeURIComponent(audio.name));
	res.setHeader('X-Audio-Last-Modified', String(audio.lastModified));
	createReadStream(audio.path).pipe(res);
}
