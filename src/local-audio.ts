interface PickedAudio {
	path: string;
	name: string;
	size: number;
	lastModified: number;
}

interface LocalConfig{token:string;capabilities?:{pickAudio?:boolean}}
let configPromise: Promise<LocalConfig> | null = null;
async function localConfig():Promise<LocalConfig>{
	configPromise ??= fetch('/__training/config').then(async response => {
		if (!response.ok) throw new Error('目前服務未提供本機檔案功能；請使用完整工作站或一般檔案選擇');
		return await response.json() as LocalConfig;
	});
	return configPromise;
}
async function localToken(): Promise<string> {return String((await localConfig()).token);}

export async function hasLocalFileAccess():Promise<boolean>{
	try{return (await localConfig()).capabilities?.pickAudio??true;}
	catch{configPromise=null;return false;}
}

async function localPost(path: string, body: object): Promise<Response> {
	const token = await localToken();
	return fetch(`/__training/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Training-Token': token },
		body: JSON.stringify(body),
	});
}

export async function pickLocalAudio(): Promise<PickedAudio | null> {
	const response = await localPost('pick-audio', {});
	const data = await response.json();
	if (response.status === 409 && data.cancelled) return null;
	if (!response.ok) throw new Error(data.error || '無法開啟本機音訊選擇器');
	return data as PickedAudio;
}

export async function readLocalAudio(audioPath: string, known?: PickedAudio): Promise<File> {
	const response = await localPost('read-audio', { path: audioPath });
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(data.error || '無法讀取專案記錄的原始音訊');
	}
	const name = decodeURIComponent(response.headers.get('X-Audio-Name') || '') || known?.name || audioPath.split(/[\\/]/).pop() || 'audio';
	const lastModified = Number(response.headers.get('X-Audio-Last-Modified')) || known?.lastModified || Date.now();
	return new File([await response.blob()], name, { type: response.headers.get('Content-Type') || 'application/octet-stream', lastModified });
}

export async function overwriteLocalAudio(audioPath:string,wav:Blob):Promise<{path:string;backupPath:string}> {
	const token=await localToken();
	const response=await fetch('/__training/write-audio',{
		method:'POST',headers:{'Content-Type':'audio/wav','X-Training-Token':token,'X-Audio-Path':encodeURIComponent(audioPath)},body:wav,
	});
	const data=await response.json().catch(()=>({}));
	if(!response.ok)throw new Error(data.error||'無法回存原始音訊');
	return data as {path:string;backupPath:string};
}

export async function findLocalDetectionFile(audioPath:string):Promise<File|null>{
	const response=await localPost('find-project',{path:audioPath});
	const data=await response.json().catch(()=>({}));
	if(response.status===404)return null;
	if(!response.ok)throw new Error(data.error||'無法搜尋同目錄檢測檔案');
	return new File([data.text],data.name||'inspection.wipitch.json',{type:'application/json'});
}

export async function writeLocalDetectionFile(audioPath:string,text:string):Promise<{path:string;name:string}>{
	const response=await localPost('write-project',{path:audioPath,text});
	const data=await response.json().catch(()=>({}));
	if(!response.ok)throw new Error(data.error||'無法儲存同目錄檢測檔案');
	return data as {path:string;name:string};
}
