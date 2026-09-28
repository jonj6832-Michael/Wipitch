// WiPitch 離線版的靜態伺服器：只用 Node 內建模組，不需要 npm。
// 用法：node serve.mjs（PORT、HOST 環境變數可以改位址）
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), 'app');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 5180;

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

createServer((req, res) => {
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
