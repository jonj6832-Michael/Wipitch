import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const uuid = /^[a-f0-9-]{36}$/;
const trainerVersion = 1;
const median = values => {
 const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
 return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};
const percentile = (values, amount) => {
 const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
 return sorted.length ? sorted[Math.floor((sorted.length - 1) * amount)] : NaN;
};
const pointsIn = (record, field) => (Array.isArray(record[field]) ? record[field] : [])
	.filter(point => point && Number.isFinite(point.time) && point.time >= record.editRange?.start && point.time < record.editRange?.end);
const valuesIn = (record, field) => pointsIn(record, field).filter(point => Number.isFinite(point.midi)).map(point => point.midi);
const pitchClass = midi => ((midi % 12) + 12) % 12;

async function recordFiles(root, category, parts = []) {
 let assets;
 try { assets = await readdir(root, { withFileTypes: true }); }
 catch (error) { if (error.code === 'ENOENT') return []; throw error; }
 const result = [];
 for (const asset of assets) {
  if (!asset.isDirectory() || !uuid.test(asset.name)) continue;
  const assetDir = path.join(root, asset.name);
  for (const item of await readdir(assetDir, { withFileTypes: true })) {
   if (!item.isDirectory() || !uuid.test(item.name)) continue;
   result.push({ category, parts: [...parts, asset.name, item.name], file: path.join(assetDir, item.name, 'record.json'), review: path.join(assetDir, item.name, 'review.json') });
  }
 }
 return result;
}

async function inventory(root) {
 return [
  ...await recordFiles(root, 'manual'),
  ...await recordFiles(path.join(root, 'AI修正調整', '取消修正'), 'rejected', ['AI修正調整', '取消修正']),
  ...await recordFiles(path.join(root, 'AI修正調整', '人工調整'), 'adjusted', ['AI修正調整', '人工調整']),
 ];
}

async function fingerprint(files) {
 const hash = createHash('sha256');
 for (const item of files.sort((a, b) => a.file.localeCompare(b.file))) {
  hash.update(item.parts.join('/') + ':' + item.category);
  for (const file of [item.file, item.review]) {
   try { const info = await stat(file); hash.update(`:${info.size}:${info.mtimeMs}`); }
   catch (error) { if (error.code !== 'ENOENT') throw error; hash.update(':missing'); }
  }
 }
 return hash.digest('hex');
}

function trainingExample(record, category) {
 if (!record?.editRange || record.editRange.end - record.editRange.start <= 0 || record.editRange.end - record.editRange.start > 5) return null;
 const before = valuesIn(record, 'beforePoints'), after = valuesIn(record, 'afterPoints');
 if (before.length < 3 || after.length < 3) return null;
	let source = before, desiredValues = after;
 // AI 回饋的 before 是 AI 提案。取消時 after 是原曲線，因此以 after
 // 作為待判斷的原始中心；被取消的提案成為明確負例。
	if (category === 'rejected') [source, desiredValues] = [after, before];
	if (category === 'adjusted' && Array.isArray(record.originalPitch)) {
	 const edited = pointsIn(record, 'afterPoints');
	 const original = edited.map((point, index) => Number.isFinite(point.midi) && Number.isFinite(point.offset) && Number.isFinite(record.originalPitch[index])
	  ? point.midi - point.offset + record.originalPitch[index] : NaN).filter(Number.isFinite);
	 if (original.length >= 3) source = original;
	}
	const center = median(source), desired = median(desiredValues);
 if (!Number.isFinite(center) || !Number.isFinite(desired)) return null;
 const targetMidi = Math.round(desired);
 const key = record.key ?? record.aiKey;
 if (Array.isArray(key?.pitchClasses) && !key.pitchClasses.includes(pitchClass(targetMidi))) return null;
 const targetDelta = targetMidi - center;
 if (Math.abs(targetDelta) > 1.5 || Math.abs(targetDelta) < .02) return null;
 const duration = record.editRange.end - record.editRange.start;
	const spread = Math.max(0, percentile(source, .9) - percentile(source, .1));
	const actualDelta = category === 'rejected' ? 0 : desired - center;
 const kind = ['onset', 'drift', 'center'].includes(record.correctionKind) ? record.correctionKind
  : duration <= .4 ? 'onset' : duration >= .8 && spread <= .55 ? 'drift' : 'center';
 return {
  duration: +duration.toFixed(4), spread: +spread.toFixed(4), targetDelta: +targetDelta.toFixed(4), kind,
  accepted: category !== 'rejected', strength: category === 'rejected' ? 0 : +Math.min(1.25, Math.abs(actualDelta / targetDelta)).toFixed(4),
  weight: category === 'manual' ? 1 : category === 'adjusted' ? 2 : 3,
 };
}

export async function updateBuiltinAIModel(root) {
 const files = await inventory(root);
 const sourceFingerprint = await fingerprint(files);
 const modelDir = path.join(root, '模型'), modelFile = path.join(modelDir, '內建AI.json');
 try {
  const existing = JSON.parse(await readFile(modelFile, 'utf8'));
  if (existing.schemaVersion === 1 && existing.trainerVersion === trainerVersion && existing.sourceFingerprint === sourceFingerprint) return { updated: false, model: existing };
 } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
 const counts = { manual: 0, rejected: 0, adjusted: 0, excluded: 0, invalid: 0, used: 0 };
 const examples = [];
 for (const item of files) {
  counts[item.category]++;
  try {
   let review = null;
   try { review = JSON.parse(await readFile(item.review, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
   if (review?.status === 'excluded') { counts.excluded++; continue; }
   const record = JSON.parse(await readFile(item.file, 'utf8'));
   const example = trainingExample(record, item.category);
   if (!example) { counts.invalid++; continue; }
   examples.push(example); counts.used++;
  } catch { counts.invalid++; }
 }
 const model = { schemaVersion: 1, trainerVersion, sourceFingerprint, trainedAt: new Date().toISOString(), counts, examples };
 await mkdir(modelDir, { recursive: true });
 const temp = path.join(modelDir, '.內建AI.tmp');
 await writeFile(temp, JSON.stringify(model, null, 2));
 await rename(temp, modelFile);
 return { updated: true, model };
}
