import { trainingServer } from './tools/training-server.mjs';
const buildTime = new Intl.DateTimeFormat('zh-TW', {
	timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
	hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date());
// 相對路徑：build 出來的 dist/ 放在網域根目錄或任何子目錄（例如 /wipitch/）都能用。
export default {
	base: './',
 define: { __BUILD_TIME__: JSON.stringify(buildTime) },
	// 這兩個套件只會在首次載入音檔時由 Worker 動態引入。若不預先最佳化，
	// Vite 會在分析開始後才建立快取，並以「optimized dependencies changed」重載整頁。
	optimizeDeps: { include: ['rubberband-wasm', 'onnxruntime-web/webgpu'] },
 server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/AI訓練/**', '**/AI訓練暫存/**'] } },
 plugins: [{
	name: 'wipitch-build-time',
	transformIndexHtml(html: string) {
		return html.replace('__WIPITCH_BUILD_TIME__', buildTime);
	},
 }, trainingServer()],
};
