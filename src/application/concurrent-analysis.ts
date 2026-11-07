/** 三個互不等待的工作都先啟動；即使一項失敗也等其他工作收尾再回報。 */
export async function concurrentAnalysis<M, R, B>(jobs: {
	mainPitch(): Promise<M>;
	referencePitch(): Promise<R>;
	rhythm(): Promise<B>;
}): Promise<{ mainPitch: M; referencePitch: R; rhythm: B }> {
	const results = await Promise.allSettled([
		Promise.resolve().then(jobs.mainPitch),
		Promise.resolve().then(jobs.referencePitch),
		Promise.resolve().then(jobs.rhythm),
	]);
	for (const result of results) if (result.status === 'rejected') throw result.reason;
	return {
		mainPitch: (results[0] as PromiseFulfilledResult<M>).value,
		referencePitch: (results[1] as PromiseFulfilledResult<R>).value,
		rhythm: (results[2] as PromiseFulfilledResult<B>).value,
	};
}
