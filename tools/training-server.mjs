import { trainingLibrary } from './training-library.mjs';
import { updateBuiltinAIModel } from './builtin-ai-model.mjs';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile, rename, rm, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { inspectLocalAudio, pickAudioPath, streamLocalAudio } from './local-audio.mjs';
const require = createRequire(import.meta.url);
export function trainingServer() {
 const token = randomUUID(); let queue = Promise.resolve(); let activeAsset = null;
 const enqueue = job => { const pending = queue.then(job); queue = pending.catch(() => {}); return pending; };
 return { name: 'local-training-recorder', configureServer(server) {
  const root = path.join(server.config.root, 'AI訓練');
  const staging = path.join(server.config.root, 'AI訓練暫存');
  server.middlewares.use('/__training', async (req, res) => {
   const reply = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
   const host = req.headers.host;
	   const remote=req.socket?.remoteAddress;
	   const loopback=!remote||remote==='::1'||remote.startsWith('127.')||remote.startsWith('::ffff:127.');
	   if (!loopback || !host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return reply(403, { error: '僅允許本機同來源存取' });
	   if (req.method === 'GET' && req.url === '/config') return reply(200, { token,
	    capabilities:{pickAudio:['darwin','win32'].includes(process.platform),readAudio:true,writeAudio:true,projectFiles:true} });
   if (req.method !== 'POST' || !['/stage', '/store-rejected', '/reset', '/commit', '/library', '/model', '/pick-audio', '/read-audio', '/write-audio', '/find-project', '/write-project'].includes(req.url) || req.headers['x-training-token'] !== token) return reply(403, { error: '無效的儲存請求' });
   try {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 512 * 1024 * 1024) throw new Error('單筆訓練資料超過 512 MiB 傳輸限制，未截短保存'); chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    if (req.url === '/write-audio') {
	     if(body.length<44||body.subarray(0,4).toString('ascii')!=='RIFF'||body.subarray(8,12).toString('ascii')!=='WAVE')throw new Error('回存內容不是有效的 WAV 音訊');
	     const requested = decodeURIComponent(String(req.headers['x-audio-path'] || ''));
	     const result=await enqueue(async()=>{
	     const audio = await inspectLocalAudio(requested);
     const extension = path.extname(audio.path).toLowerCase();
     const basename = path.basename(audio.path, extension);
     const backupPath = path.join(path.dirname(audio.path), `${basename}.wipitch-original${extension}`);
	     try { await copyFile(audio.path, backupPath, constants.COPYFILE_EXCL); }
	     catch (error) {
	      if (error.code !== 'EEXIST') throw error;
	      const backup=await inspectLocalAudio(backupPath);
	      if(backup.size<44)throw new Error('既有原始音訊備份已損壞，為避免無法還原，本次不覆寫原檔');
	     }
     const id = randomUUID(), input = path.join(path.dirname(audio.path), `.wipitch-write-${id}.wav`);
     const output = path.join(path.dirname(audio.path), `.wipitch-write-${id}${extension}`);
     await writeFile(input, body);
     try {
      if (['.wav', '.wave'].includes(extension)) await rename(input, output);
      else {
       const codecs = { '.mp3':['-codec:a','libmp3lame','-b:a','256k'], '.m4a':['-codec:a','aac','-b:a','256k'],
        '.aac':['-codec:a','aac','-b:a','256k'], '.flac':['-codec:a','flac'], '.aif':['-codec:a','pcm_s24be'],
        '.aiff':['-codec:a','pcm_s24be'], '.ogg':['-codec:a','libvorbis','-q:a','7'], '.opus':['-codec:a','libopus','-b:a','192k'] };
       const executable = require('ffmpeg-static'), codec = codecs[extension];
       if (!codec) throw new Error(`不支援回存 ${extension} 音訊`);
       await new Promise((resolve, reject) => {
        const proc = spawn(executable, ['-v','error','-nostdin','-i',input,'-vn',...codec,output], { stdio:'ignore' });
        const timer=setTimeout(()=>{proc.kill();reject(new Error('音訊轉碼逾時'));},120000);
        proc.on('error',error=>{clearTimeout(timer);reject(error);});
        proc.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('音訊轉碼失敗'));});
       });
      }
      await rename(output, audio.path);
     } finally { await rm(input,{force:true}); await rm(output,{force:true}); }
	     return { path:audio.path, backupPath };
	     });
	     return reply(200,result);
    }
    const data = JSON.parse(body.toString());
	if (req.url === '/find-project') {
	 const audio=await inspectLocalAudio(data.path),extension=path.extname(audio.path),base=path.basename(audio.path,extension);
	 const candidates=[`${base}.wipitch.json`,`${base}.wipitch-detection.json`].map(name=>path.join(path.dirname(audio.path),name));
	 const found=[];for(const candidate of candidates){try{const info=await stat(candidate);if(info.isFile())found.push({candidate,mtime:info.mtimeMs});}catch(error){if(error.code!=='ENOENT')throw error;}}
	 if(!found.length)return reply(404,{missing:true});
	 const selected=found.sort((a,b)=>b.mtime-a.mtime)[0].candidate;
	 return reply(200,{path:selected,name:path.basename(selected),text:await readFile(selected,'utf8')});
	}
	if (req.url === '/write-project') {
	 const audio=await inspectLocalAudio(data.path);
	 if(typeof data.text!=='string'||data.text.length>128*1024*1024)throw new Error('檢測檔案內容無效或過大');
	 const parsed=JSON.parse(data.text);if(parsed?.format!=='wipitch-project')throw new Error('檢測檔案格式無效');
	 const extension=path.extname(audio.path),base=path.basename(audio.path,extension),name=`${base}.wipitch.json`;
	 const destination=path.join(path.dirname(audio.path),name),temporary=path.join(path.dirname(audio.path),`.wipitch-project-${randomUUID()}.json`);
	 try{await writeFile(temporary,data.text);await rename(temporary,destination);}finally{await rm(temporary,{force:true});}
	 return reply(200,{path:destination,name});
	}
    if (req.url === '/pick-audio') {
     const selected = await pickAudioPath();
     return selected ? reply(200, await inspectLocalAudio(selected)) : reply(409, { cancelled: true });
    }
    if (req.url === '/read-audio') {
     const audio = await inspectLocalAudio(data.path);
     return streamLocalAudio(res, audio);
    }
    if (req.url === '/library') return reply(200, await enqueue(() => trainingLibrary(root, data)));
    if (req.url === '/model') return reply(200, await enqueue(() => updateBuiltinAIModel(root)));
    if (req.url === '/reset' || req.url === '/commit') {
     const assetId = data.assetId;
     if (typeof assetId !== 'string' || !/^[a-f0-9-]{36}$/.test(assetId)) throw new Error('無效的素材識別碼');
     const result = await enqueue(async () => {
      if (req.url === '/reset') {
       await mkdir(staging, { recursive: true });
       for (const name of await readdir(staging)) await rm(path.join(staging, name), { recursive: true, force: true });
       activeAsset = assetId;
       return { count: 0, categories: { manual: 0, adjusted: 0, rejected: 0 } };
      }
      if (activeAsset !== assetId) throw new Error('暫存工作階段已變更，請重新開啟音檔');
      const from = path.join(staging, assetId);
      let names;
      try { names = await readdir(from); } catch (error) { if (error.code === 'ENOENT') return { count: 0, categories: { manual: 0, adjusted: 0, rejected: 0 } }; throw error; }
      let moved = 0; const categories = { manual: 0, adjusted: 0, rejected: 0 };
      for (const name of names) {
       if (!/^[a-f0-9-]{36}$/.test(name)) continue;
       const src = path.join(from, name);
       const record=JSON.parse(await readFile(path.join(src,'record.json'),'utf8'));
       const feedback=record.feedbackType;
       const category=feedback==='adjusted'?'adjusted':feedback==='rejected'?'rejected':'manual';
       const destinationRoot=feedback==='rejected'||feedback==='adjusted' ? path.join(root,'AI修正調整',feedback==='rejected'?'取消修正':'人工調整') : root;
       const dest=path.join(destinationRoot,assetId,name);
       await mkdir(path.dirname(dest), { recursive: true });
       let exists = false;
       try { await readFile(path.join(dest, 'record.json')); exists = true; }
       catch (error) { if (error.code !== 'ENOENT') throw error; }
       if (exists) await rm(src, { recursive: true, force: true });
       else await rename(src, dest);
       moved++;
       categories[category]++;
      }
      await rm(from, { recursive: true, force: true });
      return { count: moved, categories };
     });
     return reply(200, result);
    }
    if (data.metadata?.kind !== 'manual-pitch' || !(data.metadata.clip?.duration > 0 && Number.isFinite(data.metadata.clip.duration))) throw new Error('無效的訓練資料');
    if(data.metadata.feedbackType && !['rejected','adjusted'].includes(data.metadata.feedbackType)) throw new Error('無效的 AI 回饋類別');
    if(req.url === '/store-rejected' && data.metadata.feedbackType !== 'rejected') throw new Error('只有取消 AI 修正資料可以直接存入正式資料庫');
    const edit = data.metadata.editRange;
    if (!edit || !Number.isFinite(edit.start) || !Number.isFinite(edit.end) || edit.end < edit.start) throw new Error('缺少有效的修改範圍');
    if (edit.end - edit.start > 5) throw new Error('修改範圍超過 5 秒，不儲存訓練資料');
    const assetId = data.metadata.asset?.id;
    if (typeof assetId !== 'string' || !/^[a-f0-9-]{36}$/.test(assetId)) throw new Error('無效的素材識別碼');
    const id = data.metadata.recordId ?? randomUUID();
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('無效的操作識別碼');
    const directRejected = req.url === '/store-rejected';
    const folder = directRejected ? path.join(root, 'AI修正調整', '取消修正', assetId) : path.join(staging, assetId);
    const temp = path.join(folder, `.pending-${id}`), dest = path.join(folder, id);
    const job = async () => {
     if (activeAsset !== assetId) throw new Error('暫存工作階段已變更，請重新開啟音檔');
     // A completed write may have lost its HTTP response; retry by stable ID.
     try { await readFile(path.join(dest, 'record.json')); return; }
     catch (error) { if (error.code !== 'ENOENT') throw error; }
     const executable = require('ffmpeg-static');
     await mkdir(temp, { recursive: true });
     try {
      for (const side of ['before', 'after']) {
       for (const [suffix, field] of (data.overlayPng ? [['wav', 'Wav']] : [['wav', 'Wav'], ['png', 'Png']])) {
        if (typeof data[side + field] !== 'string') throw new Error('缺少音訊或圖片');
        await writeFile(path.join(temp, `${side}.${suffix}`), Buffer.from(data[side + field], 'base64'));
       }
       await new Promise((resolve, reject) => {
        const proc = spawn(executable, ['-v', 'error', '-nostdin', '-i', path.join(temp, `${side}.wav`), '-codec:a', 'libmp3lame', '-b:a', '192k', path.join(temp, `${side}.mp3`)], { stdio: 'ignore' });
        const timer = setTimeout(() => { proc.kill(); reject(new Error('MP3 編碼逾時')); }, 30000);
        proc.on('error', e => { clearTimeout(timer); reject(e); });
        proc.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('MP3 編碼失敗')); });
       });
       await rm(path.join(temp, `${side}.wav`));
      }
      if (data.overlayPng) await writeFile(path.join(temp, 'pitch.png'), Buffer.from(data.overlayPng, 'base64'));
      const metadata = { ...data.metadata, id, files: { beforeAudio: 'before.mp3', afterAudio: 'after.mp3', ...(data.overlayPng ? { pitchImage: 'pitch.png' } : { beforeImage: 'before.png', afterImage: 'after.png' }) }, mp3: { bitrate: 192000, note: 'Lossy training preview; encoder may resample to an MP3-supported rate' } };
      if (data.metadata.image?.rows) await writeFile(path.join(temp, '音高行對應.csv'), '\uFEFFy像素,MIDI,音名,頻率Hz\n' + data.metadata.image.rows.map(row => [row.y, row.midi, row.note, row.frequencyHz].join(',')).join('\n'));
      await writeFile(path.join(temp, 'record.json'), JSON.stringify(metadata, null, 2));
      await writeFile(path.join(temp, '對應表.csv'), '\uFEFF欄位,值\n' + Object.entries({ id, ...data.metadata, ...metadata.files }).map(([k,v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)].map(x => '"' + x.replaceAll('"','""') + '"').join(',')).join('\n'));
      await rename(temp, dest);
     } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
    };
    await enqueue(job); reply(200, { id: `${assetId}/${id}` });
   } catch (error) { reply(500, { error: error.message }); }
  });
 } };
}
