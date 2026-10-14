import { trainingServer } from './tools/training-server.mjs';
// 相對路徑：build 出來的 dist/ 放在網域根目錄或任何子目錄（例如 /wipitch/）都能用。
export default {
	base: './',
 server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/AI訓練/**', '**/AI訓練暫存/**'] } },
 plugins: [trainingServer()],
};
