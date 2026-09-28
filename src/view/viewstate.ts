// 兩個 canvas（piano roll 與波形）共用的時間軸視野。
// 抽出來是為了保證它們永遠對齊——只要有一邊自己算時間，遲早會歪掉。

export class ViewState {
	/** 畫面最左邊對應的時間（秒） */
	startSec = 0;
	/** 一個 CSS 像素等於幾秒。越小 = 放得越大 */
	secPerPx = 0.01;
	/** 素材總長度（秒） */
	duration = 0;

	private listeners: (() => void)[] = [];

	onChange(fn: () => void) { this.listeners.push(fn); }
	private emit() { for (const fn of this.listeners) fn(); }

	timeToX(t: number) { return (t - this.startSec) / this.secPerPx; }
	xToTime(x: number) { return this.startSec + x * this.secPerPx; }

	/**
	 * 目前的縮放程度，0 = 整段塞滿、1 = 最大倍率。
	 *
	 * 用對數刻度：從「100 秒塞滿」到「一個 sample 一個像素」中間跨了五個數量級，
	 * 線性刻度的話滑桿前 1% 就走完了所有實用的範圍。
	 */
	zoomFraction(widthPx: number): number {
		const { minSpp, maxSpp } = this.zoomLimits(widthPx);
		if (maxSpp <= minSpp) return 0;
		return Math.log(maxSpp / this.secPerPx) / Math.log(maxSpp / minSpp);
	}

	setZoomFraction(f: number, widthPx: number) {
		const { minSpp, maxSpp } = this.zoomLimits(widthPx);
		const anchor = this.xToTime(widthPx / 2);       // 以畫面中央為錨點
		this.secPerPx = maxSpp * Math.pow(minSpp / maxSpp, Math.max(0, Math.min(1, f)));
		this.startSec = anchor - (widthPx / 2) * this.secPerPx;
		this.clamp(widthPx);
		this.emit();
	}

	/**
	 * 直接指定畫面上要看到的時間範圍（範圍捲軸用）。
	 * 縮放被夾限時，keep 指定的那一端固定不動、由另一端讓步。
	 */
	setRange(lo: number, hi: number, widthPx: number, keep?: 'lo' | 'hi') {
		const { minSpp, maxSpp } = this.zoomLimits(widthPx);
		this.secPerPx = Math.min(maxSpp, Math.max(minSpp, (hi - lo) / Math.max(1, widthPx)));
		const span = widthPx * this.secPerPx;
		this.startSec = keep === 'hi' ? hi - span : lo;
		this.clamp(widthPx);
		this.emit();
	}

	private zoomLimits(widthPx: number) {
		return {
			minSpp: 1 / 48000,
			maxSpp: Math.max(this.duration / Math.max(1, widthPx), 1e-6),
		};
	}

	/** 把整段塞進指定寬度 */
	fit(widthPx: number) {
		this.startSec = 0;
		this.secPerPx = Math.max(this.duration / Math.max(1, widthPx), 1e-6);
		this.emit();
	}

	/**
	 * 以某個像素位置為錨點縮放。
	 * 錨點不動是重點——不然滑鼠滾輪縮放會讓你看的地方一直跑掉。
	 */
	zoomAt(x: number, factor: number, widthPx: number) {
		const anchor = this.xToTime(x);
		const minSpp = 1 / 48000;                       // 放大到一個 sample 一個像素就夠了
		const maxSpp = Math.max(this.duration / Math.max(1, widthPx), 1e-6);
		this.secPerPx = Math.min(maxSpp, Math.max(minSpp, this.secPerPx * factor));
		this.startSec = anchor - x * this.secPerPx;
		this.clamp(widthPx);
		this.emit();
	}

	scrollBy(deltaPx: number, widthPx: number) {
		this.startSec += deltaPx * this.secPerPx;
		this.clamp(widthPx);
		this.emit();
	}

	/**
	 * 可以捲動到的最遠時間。比素材多留一段空白，錨點才能被拖到檔尾之後
	 * （拖的時候 duration 會跟著變長，所以可以一直往後拉）。
	 */
	get extent() { return this.duration + Math.max(10, this.duration * 0.25); }

	private clamp(widthPx: number) {
		const visible = widthPx * this.secPerPx;
		this.startSec = Math.max(0, Math.min(this.startSec, Math.max(0, this.extent - visible)));
	}
}
