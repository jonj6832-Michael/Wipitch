// 讓 Node 能直接跑 src/ 底下的 TypeScript。
//
// Vite 允許 import './foo' 這種省略副檔名的寫法，Node 的 ESM 不允許。
// 這個 hook 在解析失敗時補上 .ts 再試一次，這樣 spike/ 的測試就能
// 直接 import 真正的產品程式碼，而不是抄一份平行實作。
//
// 用法：node --experimental-strip-types --import ./tools/ts-resolve.mjs your-test.mjs
import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
