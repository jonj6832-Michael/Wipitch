import { readdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
const uuid = /^[a-f0-9-]{36}$/;
async function folder(root, asset, id) {
 if (!uuid.test(asset ?? '') || !uuid.test(id ?? '')) throw new Error('無效的記錄識別碼');
 const base = await realpath(root), location = await realpath(path.join(root, asset, id));
 if (!location.startsWith(base + path.sep)) throw new Error('資料路徑超出訓練目錄');
 return location;
}
async function reviewAt(dir) {
 try { return JSON.parse(await readFile(path.join(dir, 'review.json'), 'utf8')); }
 catch (e) { if (e.code === 'ENOENT') return { status: 'unreviewed', note: '' }; throw e; }
}
export async function trainingLibrary(root, data) {
 if(data.category){
  if(!['rejected','adjusted'].includes(data.category))throw new Error('無效的回饋分類');
  return trainingLibrary(path.join(root,'AI修正調整',data.category==='rejected'?'取消修正':'人工調整'),{...data,category:undefined,internal:true});
 }
 if (data.action === 'list') {
  let assets; try { assets = await readdir(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return { records: [] }; throw e; }
  const records = [];
  for (const asset of assets.filter(a => a.isDirectory() && uuid.test(a.name))) {
   for (const item of await readdir(path.join(root, asset.name), { withFileTypes: true })) {
    if (!item.isDirectory() || !uuid.test(item.name)) continue;
    try {
     const dir = await folder(root, asset.name, item.name);
     const record = JSON.parse(await readFile(path.join(dir, 'record.json'), 'utf8'));
     records.push({ assetId: asset.name, id: item.name, name: record.asset?.name ?? asset.name,
      operation: record.operation, key: record.keySelection?.label ?? record.key?.label ?? '全部音', clip: record.clip, createdAt: record.createdAt, review: await reviewAt(dir) });
    } catch (e) { records.push({ assetId: asset.name, id: item.name, name: asset.name, error: '記錄無法讀取', review: { status: 'unreviewed', note: '' } }); }
   }
  }
  if(!data.internal)for(const category of ['rejected','adjusted']){
   const nested=await trainingLibrary(path.join(root,'AI修正調整',category==='rejected'?'取消修正':'人工調整'),{action:'list',internal:true});
   records.push(...nested.records.map(record=>({...record,category})));
  }
  return { records: records.sort((a,b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')) };
 }
 const dir = await folder(root, data.assetId, data.id);
 if (data.action === 'review') {
  if (!['unreviewed', 'approved', 'excluded'].includes(data.status) || typeof data.note !== 'string' || data.note.length > 4000) throw new Error('無效的審核資料');
  const review = { status: data.status, note: data.note, updatedAt: new Date().toISOString() };
  await writeFile(path.join(dir, '.review.tmp'), JSON.stringify(review, null, 2));
  await rename(path.join(dir, '.review.tmp'), path.join(dir, 'review.json'));
  return { review };
 }
 if (data.action !== 'get') throw new Error('未知操作');
 const record = JSON.parse(await readFile(path.join(dir, 'record.json'), 'utf8'));
 const media = {}, missing = [];
 for (const name of ['before.mp3', 'after.mp3', 'pitch.png', 'before.png', 'after.png']) {
  try {
   const file = await realpath(path.join(dir, name));
   if (!file.startsWith(dir + path.sep)) throw new Error('無效檔案路徑');
   media[name] = (await readFile(file)).toString('base64');
  } catch (e) { if (name.endsWith('.mp3') || Object.values(record.files ?? {}).includes(name)) missing.push(name); }
 }
 return { record, media, missing, review: await reviewAt(dir) };
}
