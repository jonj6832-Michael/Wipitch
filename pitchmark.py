#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
 pitchmark.py —— 一個給 Rubber Band 用的陽春修音工具
================================================================================

這支程式做的事情很單純：

  1. 讓你用鍵盤一邊播放音檔、一邊標出「從哪裡到哪裡」（in / out point）
  2. 針對那個區段指定「要調高或調低幾個半音」
  3. 把所有標記整理成 Rubber Band 看得懂的 pitchmap 檔案
  4. 呼叫 rubberband 這個命令列工具，把整首歌算繪出來

它不是 Melodyne，它不會幫你偵測音高、也不會自動判斷哪裡走音。
它只是把「手動標時間、手動填半音數」這件苦工變得沒那麼苦而已。


--------------------------------------------------------------------------------
 需要先裝的東西
--------------------------------------------------------------------------------

  brew install rubberband mpv ffmpeg

  - rubberband : 真正做移調的引擎
  - mpv        : 播放引擎（我們用它的 IPC socket 遠端遙控它）
  - ffmpeg     : 切出預覽用的片段、查詢音檔資訊

程式只用到 Python 標準函式庫，不需要 pip install 任何東西。


--------------------------------------------------------------------------------
 用法
--------------------------------------------------------------------------------

  python3 pitchmark.py vocal.wav

  開檔之後如果旁邊已經有 vocal.wav.pitchsession.json，會自動載入之前的標記。


--------------------------------------------------------------------------------
 一個很重要的觀念：「區段」和「斷點」不是同一件事
--------------------------------------------------------------------------------

這是整支程式最核心、也最容易搞混的地方，先講清楚。

你在腦袋裡想的是「區段」：

    從 3.0 秒到 3.5 秒，調高 2 個半音。

但 Rubber Band 的 pitchmap 檔案想的是「斷點」——它的每一行是說
「從這個 sample frame 開始，音高偏移改成 X，直到下一行為止」。
所以上面那個區段，寫成 pitchmap 其實是「兩行」：

    132300 2.0      <- 從這裡開始 +2
    154350 0.0      <- 到這裡變回 0

也就是說：一個區段 = 兩個（以上）的斷點。

因此這支程式的資料結構分成兩層：

    內層（Segment）：使用者看得到的，「一段一段」的東西，方便列出、編輯、刪除
    外層（展平）  ：輸出檔案時才即時算出來的斷點序列，使用者平常不用管

想改行為的話，八成是要改 Session.flatten_to_breakpoints() 那個函式。


--------------------------------------------------------------------------------
 另一個坑：邊界的爆音
--------------------------------------------------------------------------------

如果音高在一個 sample 之內從 0 跳到 +2，聽起來會「啵」一聲，很難聽。
所以展平的時候會在區段的頭尾各加一小段「斜坡」（ramp），讓音高平滑地滑上去、
再平滑地滑回來。斜坡長度預設 30 毫秒，可以用 RAMP_MS 這個常數調整。

斜坡是加在區段「外面」的（in point 之前、out point 之後），
所以你標的那一段，從頭到尾都是完整的目標音高。

如果兩個區段靠得太近，斜坡會自動縮短來避免打架，這個邏輯也在 flatten 裡面。
"""

import json
import os
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import termios
import time
import tty


# ==============================================================================
#  可以直接改的設定
# ==============================================================================

# 區段邊界的斜坡長度（毫秒）。太短會爆音，太長會讓移調「糊」到旁邊的音。
# 人聲的話 20～50ms 通常都不錯，可以自己試。
RAMP_MS = 30

# 斜坡要切成幾段。切越多越平滑，但 pitchmap 檔案會變長。16 段通常聽不出接縫。
RAMP_STEPS = 16

# 單段預覽時，前後要多切多少秒的「前後文」出來。
# 有前後文才聽得出邊界過渡自不自然，不然你只會聽到一段孤零零的聲音。
PREVIEW_PAD_SEC = 0.6

# 微調（+ / - 鍵）一次動幾個半音。
NUDGE_STEP = 0.1

# 預覽和算繪各自要用哪個 Rubber Band 引擎。
#   "-2" = R2，快，適合一直重跑的預覽
#   "-3" = R3，品質好但慢，適合最後輸出
PREVIEW_ENGINE = "-2"
RENDER_ENGINE = "-3"

# 是否保留共振峰（formant）。人聲修音幾乎一定要開，不然會有花栗鼠感。
# 不是人聲的素材（例如合成器）可以關掉試試。
PRESERVE_FORMANT = True

# 主畫面那條時間軸總覽要畫多寬（字元數）。
TIMELINE_WIDTH = 56


# ==============================================================================
#  小工具函式
# ==============================================================================

def fmt_time(seconds):
    """把秒數格式化成 m:ss.mmm，例如 83.456 -> '1:23.456'。"""
    if seconds is None:
        return "--:--.---"
    if seconds < 0:
        seconds = 0.0
    m = int(seconds // 60)
    s = seconds - m * 60
    return "%d:%06.3f" % (m, s)


def need_tool(name, hint):
    """
    檢查某個外部程式在不在 PATH 裡面。
    找不到就直接印出人看得懂的錯誤訊息然後結束，不要吐 traceback 嚇人。
    """
    path = shutil.which(name)
    if path is None:
        print("找不到 %s 這個程式。" % name)
        print("  → %s" % hint)
        sys.exit(1)
    return path


def probe_audio(path):
    """
    用 ffprobe 查出音檔的取樣率、聲道數、總長度。

    取樣率非常重要，因為 pitchmap 裡面的數字全部都是 sample frame，
    而 sample frame 換算成秒數要除以取樣率。如果取樣率搞錯，
    整份 pitchmap 的時間點都會歪掉，而且不會報錯，只會聽起來很怪。
    """
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels",
        "-show_entries", "format=duration",
        "-of", "json", path,
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        print("ffprobe 讀不出這個檔案：%s" % path)
        print("  → 確認一下它真的是音檔，而且沒有壞掉。")
        sys.exit(1)

    info = json.loads(out)
    if not info.get("streams"):
        print("這個檔案裡面找不到音訊軌：%s" % path)
        sys.exit(1)

    stream = info["streams"][0]
    return {
        "samplerate": int(stream["sample_rate"]),
        "channels": int(stream.get("channels", 2)),
        "duration": float(info["format"]["duration"]),
    }


# ==============================================================================
#  終端機鍵盤輸入
# ==============================================================================

class Keyboard:
    """
    把終端機切成「一次讀一個字元、不用按 Enter」的模式。

    為什麼要這樣？因為我們希望播放到一半按 i 就馬上標記，
    如果還要按 Enter，等你按完那個時間點早就過去了。

    但是輸入數字（例如「調高幾個半音」）的時候又需要正常的行輸入，
    所以有 cooked() 這個東西可以暫時切回去。
    """

    def __init__(self):
        self.fd = sys.stdin.fileno()
        self.saved = None

    def __enter__(self):
        self.saved = termios.tcgetattr(self.fd)
        # setcbreak 而不是 setraw：這樣 Ctrl-C 還是有效，比較不會卡死
        tty.setcbreak(self.fd)
        return self

    def __exit__(self, *exc):
        self.restore()

    def restore(self):
        """把終端機還原成原本的樣子。程式結束前一定要呼叫，否則終端機會壞掉。"""
        if self.saved is not None:
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)

    def read(self, timeout):
        """
        等最多 timeout 秒，看看使用者有沒有按鍵。

        有按 → 回傳那個字元
        沒按 → 回傳 None

        用 select 而不是直接 read，是因為我們在等按鍵的空檔還要順便
        更新畫面上的播放位置，不能被 read 卡住。
        """
        ready, _, _ = select.select([sys.stdin], [], [], timeout)
        if ready:
            return sys.stdin.read(1)
        return None

    def ask(self, prompt):
        """
        暫時切回正常模式，用 input() 問使用者一個問題，然後再切回單鍵模式。

        使用者直接按 Enter（空字串）或按 Ctrl-C 的話回傳 None，
        呼叫端要記得處理「使用者反悔了」這個情況。
        """
        self.restore()
        try:
            answer = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            answer = ""
        finally:
            tty.setcbreak(self.fd)
        return answer if answer else None


# ==============================================================================
#  mpv 播放器（透過 IPC socket 遙控）
# ==============================================================================

class MpvPlayer:
    """
    在背景開一個 mpv，然後用 Unix socket 對它下指令。

    為什麼用 mpv 而不是自己寫播放程式？因為播放這件事看起來簡單，
    實際上要處理音效裝置、緩衝區、執行緒、精確 seek……全部自己寫會寫到天亮。
    mpv 已經把這些都做好了，而且它的 IPC 協定就是傳 JSON 過去而已，很好接。

    IPC 協定長這樣：
        送出 → {"command": ["get_property", "time-pos"], "request_id": 7}\n
        收到 → {"error":"success", "data": 12.345, "request_id": 7}\n

    注意 mpv 也會自己主動送一堆「事件」訊息過來（例如檔案播完了），
    我們對這些沒興趣，讀到的時候要跳過，繼續找 request_id 對得上的那一則。
    """

    def __init__(self):
        # socket 放在暫存目錄，程式結束時會刪掉
        self.tmpdir = tempfile.mkdtemp(prefix="pitchmark-")
        self.sockpath = os.path.join(self.tmpdir, "mpv.sock")
        self.request_id = 0
        self.recv_buffer = b""

        self.proc = subprocess.Popen(
            [
                "mpv",
                "--idle=yes",             # 沒檔案也不要結束，在那邊等我們餵
                "--no-video",             # 我們只放聲音
                "--no-terminal",          # 不要在終端機印東西，會蓋掉我們的畫面
                "--keep-open=yes",        # 播完不要自動關掉
                "--input-ipc-server=" + self.sockpath,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # mpv 啟動需要一點時間，socket 檔案不會立刻出現，所以要等一下
        self.sock = None
        for _ in range(100):            # 最多等 5 秒
            if os.path.exists(self.sockpath):
                try:
                    self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    self.sock.connect(self.sockpath)
                    break
                except OSError:
                    self.sock = None
            time.sleep(0.05)

        if self.sock is None:
            raise RuntimeError("連不上 mpv 的 IPC socket，mpv 可能沒有正常啟動。")

    # ---- 底層通訊 ----------------------------------------------------------

    def command(self, *args):
        """
        送一個指令給 mpv，等它回覆，回傳 data 欄位的內容。

        出任何錯都回傳 None，不要讓播放器的小問題把整個程式弄掛。
        """
        if self.sock is None:
            return None

        self.request_id += 1
        rid = self.request_id
        payload = json.dumps({"command": list(args), "request_id": rid})

        try:
            self.sock.sendall((payload + "\n").encode("utf-8"))
        except OSError:
            return None

        # 一直讀，直到看到 request_id 對得上的那一則回覆
        deadline = time.time() + 2.0
        while time.time() < deadline:
            # 先看看緩衝區裡有沒有完整的一行
            while b"\n" in self.recv_buffer:
                line, self.recv_buffer = self.recv_buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except ValueError:
                    continue
                if msg.get("request_id") == rid:
                    return msg.get("data")
                # 其他的都是 mpv 主動送的事件通知，忽略

            # 緩衝區沒東西了，再去 socket 撈
            ready, _, _ = select.select([self.sock], [], [], 0.1)
            if not ready:
                continue
            try:
                chunk = self.sock.recv(65536)
            except OSError:
                return None
            if not chunk:
                return None
            self.recv_buffer += chunk

        return None

    # ---- 常用操作的包裝 ----------------------------------------------------

    def load(self, path, start_at=0.0):
        """載入一個檔案並跳到指定位置。載入之後預設是暫停的。"""
        self.command("loadfile", path, "replace")
        # loadfile 是非同步的，馬上 seek 會被忽略，所以等一下下
        time.sleep(0.25)
        self.command("set_property", "pause", True)
        if start_at > 0:
            self.seek_absolute(start_at)

    def time_pos(self):
        """回傳目前播放位置（秒）。還沒載入檔案的話回傳 None。"""
        value = self.command("get_property", "time-pos")
        return float(value) if isinstance(value, (int, float)) else None

    def is_paused(self):
        return bool(self.command("get_property", "pause"))

    def set_paused(self, paused):
        self.command("set_property", "pause", bool(paused))

    def seek_absolute(self, seconds):
        """跳到絕對時間位置。exact 表示要精確跳，不要跳到最近的關鍵影格。"""
        if seconds < 0:
            seconds = 0.0
        self.command("seek", seconds, "absolute", "exact")

    def seek_relative(self, delta):
        """相對目前位置前後跳。"""
        self.command("seek", delta, "relative", "exact")

    def set_ab_loop(self, a, b):
        """
        設定 A-B 循環播放區間。傳 None 表示取消循環。

        標完 in / out 之後自動開循環，這樣按 space 就會一直重複聽那一小段，
        修音的時候超好用。
        """
        if a is None or b is None:
            self.command("set_property", "ab-loop-a", "no")
            self.command("set_property", "ab-loop-b", "no")
        else:
            self.command("set_property", "ab-loop-a", float(a))
            self.command("set_property", "ab-loop-b", float(b))

    def close(self):
        """關掉 mpv 並清乾淨暫存目錄。"""
        try:
            if self.sock:
                self.command("quit")
                self.sock.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=2)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        shutil.rmtree(self.tmpdir, ignore_errors=True)


# ==============================================================================
#  資料模型：區段與 Session
# ==============================================================================

class Segment:
    """
    一個標記區段。

    注意 start / end 存的是 sample frame（整數），不是秒數。
    這是因為 pitchmap 檔案本身就是用 frame 計算的，
    全程用 frame 可以避免來回換算產生的誤差。

    semitones 是浮點數，可以是負的（調低），也可以是小數（微調音準）。
    """

    def __init__(self, start, end, semitones):
        self.start = int(start)
        self.end = int(end)
        self.semitones = float(semitones)

    def to_dict(self):
        return {"start": self.start, "end": self.end, "semitones": self.semitones}

    @staticmethod
    def from_dict(d):
        return Segment(d["start"], d["end"], d["semitones"])


class Session:
    """
    一次工作階段的全部狀態：音檔資訊 + 所有標記區段 + 復原歷史。

    存檔格式是 JSON，放在音檔旁邊，檔名是「原檔名.pitchsession.json」。
    裡面會一併記下取樣率，載入時會比對——因為如果你把 44.1k 的 session
    套到 48k 的音檔上，所有時間點都會歪掉，而且是那種不會報錯的歪法。
    """

    def __init__(self, audio_path, samplerate, duration):
        self.audio_path = os.path.abspath(audio_path)
        self.samplerate = samplerate
        self.duration = duration
        self.segments = []
        self.undo_stack = []        # 每次改動前先把整個 segments 複製一份丟進來
        self.dirty = False          # 有沒有未存檔的變更

    # ---- 路徑 --------------------------------------------------------------

    @property
    def session_path(self):
        return self.audio_path + ".pitchsession.json"

    @property
    def pitchmap_path(self):
        return self.audio_path + ".pitchmap"

    # ---- 單位換算 ----------------------------------------------------------

    def sec_to_frame(self, seconds):
        return int(round(seconds * self.samplerate))

    def frame_to_sec(self, frame):
        return frame / float(self.samplerate)

    @property
    def total_frames(self):
        return self.sec_to_frame(self.duration)

    # ---- 復原 --------------------------------------------------------------

    def snapshot(self):
        """
        在動到 segments 之前呼叫這個，把現況存進復原堆疊。

        只留最近 50 步，免得吃太多記憶體（雖然說實話也吃不了多少）。
        """
        self.undo_stack.append([Segment(s.start, s.end, s.semitones)
                                for s in self.segments])
        if len(self.undo_stack) > 50:
            self.undo_stack.pop(0)

    def undo(self):
        """復原上一步。成功回傳 True，沒東西可復原回傳 False。"""
        if not self.undo_stack:
            return False
        self.segments = self.undo_stack.pop()
        self.dirty = True
        return True

    # ---- 區段管理 ----------------------------------------------------------

    def sorted_segments(self):
        """依照起點排序後的區段。列出、展平的時候都要用排序過的。"""
        return sorted(self.segments, key=lambda s: s.start)

    def find_overlap(self, start, end, ignore=None):
        """
        檢查 [start, end) 有沒有跟現有的區段重疊。

        為什麼要擋重疊？因為 pitchmap 是一維的斷點序列，
        它沒辦法表達「這裡同時 +2 又 -1」這種事。兩個區段重疊的話，
        展平出來的結果會很難預測，不如一開始就擋掉。

        ignore 是編輯現有區段時用的：檢查時要把自己排除掉，
        不然它會跟自己重疊。
        """
        for seg in self.segments:
            if seg is ignore:
                continue
            if start < seg.end and end > seg.start:
                return seg
        return None

    def add_segment(self, start, end, semitones):
        """新增一個區段。回傳 (成功與否, 訊息)。"""
        if end <= start:
            return False, "out point 必須在 in point 後面。"

        clash = self.find_overlap(start, end)
        if clash is not None:
            return False, "跟現有的區段重疊了（%s ~ %s，%+.2f 半音）。" % (
                fmt_time(self.frame_to_sec(clash.start)),
                fmt_time(self.frame_to_sec(clash.end)),
                clash.semitones,
            )

        self.snapshot()
        self.segments.append(Segment(start, end, semitones))
        self.dirty = True
        return True, "已新增。"

    # ---- 核心：把區段展平成 pitchmap 斷點 ----------------------------------

    def flatten_to_breakpoints(self):
        """
        這是整支程式的核心。把「一段一段」的 Segment 轉成
        Rubber Band pitchmap 要的「一個一個」斷點。

        回傳的是一個 [(frame, semitones), ...] 的 list，已經照 frame 排好序。

        做法：
          對每個區段，產生五個部分——
            1. 斜坡起點（音高 0）
            2. 斜坡上升的中間點們
            3. in point（音高 = 目標值）
            4. out point（音高還是目標值，撐到這裡）
            5. 斜坡下降，最後回到 0

        斜坡是加在區段外面的，所以你標的範圍內從頭到尾都是完整的目標音高。

        兩個區段靠太近的時候，中間塞不下兩條完整的斜坡，
        這時候就把可用的空隙對半分給兩邊。這是為什麼下面要先排序、
        再一個個看前後鄰居有多遠。
        """
        segs = self.sorted_segments()
        if not segs:
            return []

        default_ramp = int(self.samplerate * RAMP_MS / 1000.0)
        total = self.total_frames
        points = []

        for index, seg in enumerate(segs):
            # --- 算出這一段的頭尾各能用多長的斜坡 ---

            # 前面的空間：到前一段的結尾為止，或到檔案開頭為止
            prev_end = segs[index - 1].end if index > 0 else 0
            gap_before = seg.start - prev_end
            # 除以 2 是因為這個空隙要跟前一段的下降斜坡共用
            ramp_in = min(default_ramp, max(0, gap_before // 2))

            # 後面的空間：到下一段的開頭為止，或到檔案結尾為止
            next_start = segs[index + 1].start if index + 1 < len(segs) else total
            gap_after = next_start - seg.end
            ramp_out = min(default_ramp, max(0, gap_after // 2))

            target = seg.semitones

            # --- 上升斜坡 ---
            if ramp_in > 0:
                for k in range(RAMP_STEPS):
                    ratio = k / float(RAMP_STEPS)          # 0.0 → 接近 1.0
                    frame = seg.start - ramp_in + int(ramp_in * ratio)
                    points.append((frame, target * ratio))
            else:
                # 沒空間做斜坡，只好硬跳。可能會有一點爆音，但至少不會壞掉。
                points.append((max(0, seg.start - 1), 0.0))

            # --- 區段本體：從 in 到 out 維持目標音高 ---
            points.append((seg.start, target))
            points.append((seg.end, target))

            # --- 下降斜坡 ---
            if ramp_out > 0:
                for k in range(1, RAMP_STEPS + 1):
                    ratio = k / float(RAMP_STEPS)          # 接近 0 → 1.0
                    frame = seg.end + int(ramp_out * ratio)
                    points.append((frame, target * (1.0 - ratio)))
            else:
                points.append((seg.end + 1, 0.0))

        # 排序，並把 frame 重複的去掉（保留後面那個，因為它是「比較新的狀態」）
        points.sort(key=lambda p: p[0])
        cleaned = []
        for frame, value in points:
            if cleaned and cleaned[-1][0] == frame:
                cleaned[-1] = (frame, value)
            else:
                cleaned.append((frame, value))

        return cleaned

    def write_pitchmap(self, path=None, breakpoints=None):
        """
        把斷點寫成 Rubber Band 吃得下的檔案。

        格式非常單純：每行兩個數字，用一個空格隔開。
        第一個是 sample frame（整數），第二個是半音偏移（浮點數）。

        Rubber Band 不接受註解行，所以這個檔案裡不能寫任何說明文字。
        （你的標記資訊都在 .pitchsession.json 裡面，那個才是「原始檔」，
          這個 .pitchmap 是產生出來的，可以隨時重新生成。）
        """
        if path is None:
            path = self.pitchmap_path
        if breakpoints is None:
            breakpoints = self.flatten_to_breakpoints()

        with open(path, "w", encoding="utf-8") as f:
            for frame, value in breakpoints:
                f.write("%d %.4f\n" % (max(0, frame), value))
        return path

    # ---- 存檔／載入 --------------------------------------------------------

    def save(self):
        """存 session（JSON）並順便重新產生 pitchmap 檔。"""
        data = {
            "audio_path": self.audio_path,
            "samplerate": self.samplerate,
            "duration": self.duration,
            "segments": [s.to_dict() for s in self.sorted_segments()],
        }
        with open(self.session_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.write_pitchmap()
        self.dirty = False

    def load_if_exists(self):
        """
        開檔時看看旁邊有沒有之前存的 session，有的話載進來。

        回傳一段訊息字串給呼叫端印出來（或 None 表示沒有東西可載）。
        """
        if not os.path.exists(self.session_path):
            return None

        try:
            with open(self.session_path, encoding="utf-8") as f:
                data = json.load(f)
        except (ValueError, OSError) as e:
            return "找到舊的 session 檔但讀不起來（%s），先跳過。" % e

        # 取樣率不一樣的話一定要警告，這種錯誤不會當掉，只會讓成品聽起來很怪
        old_sr = data.get("samplerate")
        if old_sr and old_sr != self.samplerate:
            return ("警告：舊 session 的取樣率是 %d Hz，但這個檔案是 %d Hz。"
                    "為了安全起見沒有載入舊標記。" % (old_sr, self.samplerate))

        self.segments = [Segment.from_dict(d) for d in data.get("segments", [])]
        self.dirty = False
        return "載入了 %d 個既有標記。" % len(self.segments)


# ==============================================================================
#  Rubber Band 相關
# ==============================================================================

def build_rubberband_cmd(infile, outfile, pitchmap=None, semitones=None,
                         engine=PREVIEW_ENGINE):
    """
    組出 rubberband 的命令列參數。

    有兩種模式：
      - 給 pitchmap：整個檔案照著 pitchmap 動態變調
      - 給 semitones：整個檔案固定移調（比較快，單段預覽有時候用得到）

    注意 --pitchmap 會強制 rubberband 進入 realtime 模式，
    這代表輸出的長度不會跟輸入完全一樣（可能差幾十個 sample）。
    這也是為什麼「所有標記操作一律以原始檔案的時間軸為準」——
    預覽檔只拿來聽，不要拿來標。
    """
    cmd = ["rubberband", engine]

    if PRESERVE_FORMANT:
        cmd.append("-F")

    if pitchmap:
        cmd += ["--pitchmap", pitchmap]
    elif semitones is not None:
        cmd += ["-p", "%.4f" % semitones]

    # 時間不變，只動音高
    cmd += ["-t", "1.0"]
    cmd += [infile, outfile]
    return cmd


def run_rubberband(cmd, label="處理中"):
    """
    執行 rubberband，把它的輸出吃掉不要洗版。
    成功回傳 True，失敗的話把錯誤訊息印出來並回傳 False。
    """
    print("  %s……" % label, end="", flush=True)
    started = time.time()
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    elapsed = time.time() - started

    if proc.returncode != 0:
        print(" 失敗。")
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        for line in err.splitlines()[-5:]:      # 只印最後幾行，不然很長
            print("    %s" % line)
        return False

    print(" 完成（%.1f 秒）。" % elapsed)
    return True


def extract_segment(src, dst, start_frame, end_frame, samplerate):
    """
    用 ffmpeg 從原始檔案切出一段。

    用 atrim 濾鏡的 start_sample / end_sample 而不是 -ss / -to，
    是因為前者是精確到 sample 的，後者會有一點點誤差。
    我們的整個系統都建立在 sample frame 上面，所以這裡不能馬虎。
    """
    cmd = [
        "ffmpeg", "-v", "error", "-y",
        "-i", src,
        "-af", "atrim=start_sample=%d:end_sample=%d,asetpts=N/SR/TB" % (
            max(0, start_frame), max(1, end_frame)),
        dst,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        print("  ffmpeg 切檔失敗：")
        print("    " + proc.stderr.decode("utf-8", errors="replace").strip()[:400])
        return False
    return True


# ==============================================================================
#  主程式
# ==============================================================================

class PitchMark:
    """
    把上面所有東西兜起來的主控類別。

    狀態大致上分成三組：
      - 標記中的暫存狀態：in_point / out_point / pending_semitones
      - 播放狀態：last_play_start / ab_mode / preview_file
      - 持久狀態：session（裡面裝所有已確認的區段）
    """

    def __init__(self, audio_path):
        self.audio_path = os.path.abspath(audio_path)

        info = probe_audio(self.audio_path)
        self.session = Session(self.audio_path, info["samplerate"], info["duration"])

        # 還沒按 w 確認的暫存標記
        self.in_point = None            # sample frame，或 None
        self.out_point = None
        self.pending_semitones = 0.0

        # 播放相關
        self.last_play_start = 0.0      # 給 b 鍵用的「上次開始播放的位置」
        self.playing_preview = False    # 現在播的是預覽檔還是原始檔
        self.preview_path = None        # 目前這個預覽檔在哪
        self.preview_offset = 0.0       # 預覽檔的第 0 秒相當於原檔的第幾秒

        # 暫存檔放這裡，結束時整個刪掉
        self.workdir = tempfile.mkdtemp(prefix="pitchmark-work-")

        self.player = MpvPlayer()
        self.player.load(self.audio_path)

        self.running = True

    # ---- 畫面輸出 ----------------------------------------------------------

    def clear_status_line(self):
        """
        把那條會原地更新的狀態列擦掉。

        因為狀態列是用 \\r 回到行首覆寫的，如果不先擦乾淨就 print 別的東西，
        會留下前一次的殘影。所以每次要印正式訊息前都先呼叫這個。
        """
        sys.stdout.write("\r" + " " * 78 + "\r")
        sys.stdout.flush()

    def print_status_line(self):
        """
        畫面最下面那一行的即時狀態：播放位置、in/out、待設定的半音數。
        用 \\r 原地更新，所以不會把畫面洗掉。
        """
        pos = self.player.time_pos()

        # 如果現在播的是預覽檔，要換算回原始檔案的時間才有意義
        display_pos = pos
        if pos is not None and self.playing_preview:
            display_pos = pos + self.preview_offset

        symbol = "▶" if not self.player.is_paused() else "‖"
        source = "預覽" if self.playing_preview else "原始"

        marks = []
        if self.in_point is not None:
            marks.append("I=" + fmt_time(self.session.frame_to_sec(self.in_point)))
        if self.out_point is not None:
            marks.append("O=" + fmt_time(self.session.frame_to_sec(self.out_point)))
        if self.pending_semitones:
            marks.append("%+.2f 半音" % self.pending_semitones)

        line = "  %s %s [%s]  %s" % (
            symbol, fmt_time(display_pos), source, "  ".join(marks))

        sys.stdout.write("\r" + line.ljust(78)[:78])
        sys.stdout.flush()

    def print_timeline(self):
        """
        畫一條 ASCII 時間軸總覽，讓你一眼看出哪些地方已經標過了。

        '=' 是還沒標的，'#' 是已經標的區段，'^' 是目前播放頭的位置。
        """
        width = TIMELINE_WIDTH
        cells = ["="] * width
        total = max(1.0, self.session.duration)

        for seg in self.session.segments:
            a = int(self.session.frame_to_sec(seg.start) / total * width)
            b = int(self.session.frame_to_sec(seg.end) / total * width)
            for i in range(max(0, a), min(width, max(b, a + 1))):
                cells[i] = "#"

        bar = "".join(cells)

        pos = self.player.time_pos() or 0.0
        if self.playing_preview:
            pos += self.preview_offset
        cursor_col = int(min(1.0, pos / total) * (width - 1))
        cursor = " " * cursor_col + "^"

        print("  [%s]" % bar)
        print("   %s" % cursor)

    def print_help(self):
        """按 ? 的時候顯示的說明。"""
        print()
        print("  ── 播放 ──────────────────────────────────────────")
        print("   space  播放／暫停（有標 in+out 時會循環播放那一段）")
        print("   {  }   往前／往後 10 秒")
        print("   [  ]   往前／往後 1 秒")
        print("   <  >   往前／往後 0.1 秒")
        print("   b      跳回上次開始播放的位置")
        print("   g      跳到指定時間（會問你要跳到第幾秒）")
        print()
        print("  ── 標記 ──────────────────────────────────────────")
        print("   i  o   標記 in point／out point（播放中直接按）")
        print("   t      設定這一段要調高／低幾個半音")
        print("   +  -   微調 %+.1f 半音，並自動重跑預覽" % NUDGE_STEP)
        print("   x      清掉目前的 in/out 標記，重來")
        print()
        print("  ── 試聽 ──────────────────────────────────────────")
        print("   p      預覽目前這一段（含前後文，聽得到邊界過渡）")
        print("   a      在原始和預覽之間 A/B 切換")
        print("   P      整首預覽（套用所有已存的標記）")
        print()
        print("  ── 管理 ──────────────────────────────────────────")
        print("   w      把目前的 in/out/半音數確認存進清單")
        print("   l      列出所有已存的區段")
        print("   e      編輯某一行的半音數")
        print("   d      刪除某一行")
        print("   u      復原上一步")
        print("   s      存檔（session + pitchmap）")
        print("   R      算繪整首並輸出檔案")
        print()
        print("   ?      顯示這份說明")
        print("   q      離開")
        print()

    # ---- 各個指令 ----------------------------------------------------------

    def current_original_position(self):
        """
        取得目前播放頭在「原始檔案時間軸」上的位置（秒）。

        因為預覽檔是從中間切出來的，它的第 0 秒不等於原檔的第 0 秒，
        所以播預覽的時候要加上 preview_offset 才是真正的位置。
        """
        pos = self.player.time_pos()
        if pos is None:
            return 0.0
        if self.playing_preview:
            return pos + self.preview_offset
        return pos

    def cmd_toggle_play(self):
        """播放／暫停。開始播的時候記住起點，給 b 鍵用。"""
        if self.player.is_paused():
            self.last_play_start = self.current_original_position()
            self.player.set_paused(False)
            self.clear_status_line()
            print("  ▶ 從 %s 開始播放。" % fmt_time(self.last_play_start))
        else:
            self.player.set_paused(True)
            self.clear_status_line()
            print("  ‖ 停在 %s。" % fmt_time(self.current_original_position()))

    def cmd_seek(self, delta):
        """相對 seek。播預覽時也是直接對預覽檔 seek，行為一致。"""
        self.player.seek_relative(delta)

    def cmd_goto(self, keyboard):
        """按 g：問使用者要跳到第幾秒。支援 '83'、'1:23'、'1:23.5' 三種寫法。"""
        self.clear_status_line()
        answer = keyboard.ask("  跳到哪裡？（秒數，或 m:ss）> ")
        if answer is None:
            print("  取消。")
            return

        seconds = parse_time_input(answer)
        if seconds is None:
            print("  看不懂「%s」這個時間格式。" % answer)
            return

        # 如果現在在播預覽，要先切回原始檔才跳得到正確位置
        if self.playing_preview:
            self.switch_to_original(seconds)
        else:
            self.player.seek_absolute(seconds)
        print("  跳到 %s。" % fmt_time(seconds))

    def cmd_mark_in(self):
        """按 i：把目前位置設成 in point。"""
        pos = self.current_original_position()
        self.in_point = self.session.sec_to_frame(pos)
        self.clear_status_line()
        print("  in  → %s（frame %d）" % (fmt_time(pos), self.in_point))
        self.refresh_loop()

    def cmd_mark_out(self):
        """按 o：把目前位置設成 out point。"""
        pos = self.current_original_position()
        self.out_point = self.session.sec_to_frame(pos)
        self.clear_status_line()
        print("  out → %s（frame %d）" % (fmt_time(pos), self.out_point))

        if self.in_point is not None and self.out_point <= self.in_point:
            print("  （注意：out 在 in 前面或同一點，按 w 之前要修一下。）")
        self.refresh_loop()

    def refresh_loop(self):
        """
        in/out 都有的時候，自動把 mpv 的 A-B 循環設在那一段。

        這樣按 space 就會一直重複播那一小段，修音的時候不用一直手動 seek。
        只在播原始檔的時候設，播預覽的話時間軸對不上，設了會亂跳。
        """
        if self.playing_preview:
            return
        if self.in_point is not None and self.out_point is not None \
                and self.out_point > self.in_point:
            self.player.set_ab_loop(
                self.session.frame_to_sec(self.in_point),
                self.session.frame_to_sec(self.out_point))
        else:
            self.player.set_ab_loop(None, None)

    def cmd_clear_marks(self):
        """按 x：把暫存的標記全部清掉重來。"""
        self.in_point = None
        self.out_point = None
        self.pending_semitones = 0.0
        self.player.set_ab_loop(None, None)
        self.clear_status_line()
        print("  已清除目前的 in/out 標記。")

    def cmd_set_semitones(self, keyboard):
        """按 t：輸入半音數。可以是負的，可以是小數。"""
        self.clear_status_line()
        answer = keyboard.ask("  要調幾個半音？（可負可小數，例如 -1.5）> ")
        if answer is None:
            print("  取消。")
            return
        try:
            self.pending_semitones = float(answer)
        except ValueError:
            print("  「%s」不是數字。" % answer)
            return
        print("  設定為 %+.2f 半音。" % self.pending_semitones)

    def cmd_nudge(self, delta, keyboard):
        """
        按 + / -：微調半音數，然後自動重跑預覽。

        修音實際上的動作就是「試、聽、再試」，這個迴圈越短越好用，
        所以這裡故意做成「改完馬上就聽得到」。
        """
        self.pending_semitones += delta
        self.clear_status_line()
        print("  → %+.2f 半音" % self.pending_semitones)
        if self.in_point is not None and self.out_point is not None:
            self.cmd_preview_segment(auto_play=True)

    def cmd_preview_segment(self, auto_play=True):
        """
        按 p：把目前 in/out 這一段（前後多切一點）拿去 rubberband 處理並播放。

        為什麼要多切前後文？因為移調的邊界過渡自不自然，
        是要跟旁邊沒動過的聲音比較才聽得出來的。
        只聽孤零零的一段完全判斷不出接縫的問題。
        """
        if self.in_point is None or self.out_point is None:
            self.clear_status_line()
            print("  還沒標好 in 和 out。")
            return
        if self.out_point <= self.in_point:
            self.clear_status_line()
            print("  out point 在 in point 前面，先修一下。")
            return

        self.clear_status_line()

        sr = self.session.samplerate
        pad = int(PREVIEW_PAD_SEC * sr)
        cut_start = max(0, self.in_point - pad)
        cut_end = min(self.session.total_frames, self.out_point + pad)

        chunk = os.path.join(self.workdir, "chunk.wav")
        out = os.path.join(self.workdir, "preview.wav")

        if not extract_segment(self.audio_path, chunk, cut_start, cut_end, sr):
            return

        # 做一份「只有這一段」的臨時 pitchmap。
        # 注意 frame 要減掉 cut_start，因為切出來的檔案是從 0 開始算的。
        temp_session = Session(chunk, sr, (cut_end - cut_start) / float(sr))
        temp_session.segments = [Segment(self.in_point - cut_start,
                                         self.out_point - cut_start,
                                         self.pending_semitones)]
        map_path = os.path.join(self.workdir, "preview.pitchmap")
        temp_session.write_pitchmap(map_path)

        cmd = build_rubberband_cmd(chunk, out, pitchmap=map_path,
                                   engine=PREVIEW_ENGINE)
        if not run_rubberband(cmd, "產生預覽（%+.2f 半音）" % self.pending_semitones):
            return

        self.preview_path = out
        self.preview_offset = cut_start / float(sr)
        self.playing_preview = True

        self.player.set_ab_loop(None, None)
        self.player.load(out)
        if auto_play:
            self.player.set_paused(False)
        print("  ▶ 播放預覽（%s ~ %s，含前後 %.1f 秒）" % (
            fmt_time(self.session.frame_to_sec(self.in_point)),
            fmt_time(self.session.frame_to_sec(self.out_point)),
            PREVIEW_PAD_SEC))

    def switch_to_original(self, at_seconds=None):
        """切回播原始檔。at_seconds 沒給的話就停在目前對應的位置。"""
        if at_seconds is None:
            at_seconds = self.current_original_position()
        self.playing_preview = False
        self.preview_offset = 0.0
        self.player.set_ab_loop(None, None)
        self.player.load(self.audio_path, start_at=at_seconds)
        self.refresh_loop()

    def cmd_ab_toggle(self):
        """
        按 a：在原始和處理後之間切換，而且盡量停在同一個位置。

        沒有這個功能很難判斷自己是不是修過頭了——
        單獨聽處理後的版本，耳朵會很快習慣，覺得「好像本來就這樣」。
        """
        self.clear_status_line()
        pos = self.current_original_position()

        if self.playing_preview:
            self.switch_to_original(pos)
            print("  切到【原始】@ %s" % fmt_time(pos))
        else:
            if not self.preview_path or not os.path.exists(self.preview_path):
                print("  還沒產生過預覽，先按 p。")
                return
            # 換算成預覽檔裡面的相對位置
            local = max(0.0, pos - self.preview_offset)
            self.playing_preview = True
            self.player.set_ab_loop(None, None)
            self.player.load(self.preview_path, start_at=local)
            print("  切到【預覽】@ %s" % fmt_time(pos))

        self.player.set_paused(False)

    def cmd_write(self):
        """
        按 w：把目前的 in/out/半音數確認下來，加進區段清單。

        存進去之後暫存標記會清空，可以馬上標下一段。
        session 檔和 pitchmap 檔也會同步更新，所以就算程式突然掛掉也不會白做工。
        """
        self.clear_status_line()

        if self.in_point is None or self.out_point is None:
            print("  還沒標好 in 和 out。")
            return
        if self.pending_semitones == 0.0:
            print("  半音數是 0，這樣存進去等於沒動。先按 t 設定一下？")
            return

        ok, message = self.session.add_segment(
            self.in_point, self.out_point, self.pending_semitones)

        if not ok:
            print("  存不進去：%s" % message)
            return

        print("  ✓ 已存：%s ~ %s  %+.2f 半音" % (
            fmt_time(self.session.frame_to_sec(self.in_point)),
            fmt_time(self.session.frame_to_sec(self.out_point)),
            self.pending_semitones))

        self.session.save()
        print("    → %s" % os.path.basename(self.session.pitchmap_path))

        # 清空暫存標記，準備標下一段
        self.in_point = None
        self.out_point = None
        self.pending_semitones = 0.0
        self.player.set_ab_loop(None, None)

    def cmd_list(self):
        """按 l：列出所有已存的區段，附行號（給 e / d 用）。"""
        self.clear_status_line()
        segs = self.session.sorted_segments()

        if not segs:
            print("  目前還沒有任何標記。")
            return

        print()
        print("   #   in           out          長度      半音")
        print("  ───  ───────────  ───────────  ────────  ──────")
        for i, seg in enumerate(segs, start=1):
            a = self.session.frame_to_sec(seg.start)
            b = self.session.frame_to_sec(seg.end)
            print("  %3d  %11s  %11s  %6.3f s  %+.2f" % (
                i, fmt_time(a), fmt_time(b), b - a, seg.semitones))
        print()
        self.print_timeline()
        print()

    def cmd_edit(self, keyboard):
        """按 e：改某一行的半音數。這是實務上最常做的動作。"""
        self.clear_status_line()
        segs = self.session.sorted_segments()
        if not segs:
            print("  沒有東西可以編輯。")
            return

        answer = keyboard.ask("  要編輯第幾行？（按 l 可以看清單）> ")
        if answer is None:
            print("  取消。")
            return
        try:
            index = int(answer)
        except ValueError:
            print("  「%s」不是行號。" % answer)
            return
        if not (1 <= index <= len(segs)):
            print("  行號要在 1 到 %d 之間。" % len(segs))
            return

        seg = segs[index - 1]
        print("  第 %d 行目前是 %+.2f 半音。" % (index, seg.semitones))

        answer = keyboard.ask("  改成幾個半音？> ")
        if answer is None:
            print("  取消。")
            return
        try:
            value = float(answer)
        except ValueError:
            print("  「%s」不是數字。" % answer)
            return

        self.session.snapshot()
        seg.semitones = value
        self.session.dirty = True
        self.session.save()
        print("  ✓ 第 %d 行改成 %+.2f 半音。" % (index, value))

    def cmd_delete(self, keyboard):
        """按 d：刪掉某一行。刪錯了可以按 u 復原。"""
        self.clear_status_line()
        segs = self.session.sorted_segments()
        if not segs:
            print("  沒有東西可以刪除。")
            return

        answer = keyboard.ask("  要刪除第幾行？（按 l 可以看清單）> ")
        if answer is None:
            print("  取消。")
            return
        try:
            index = int(answer)
        except ValueError:
            print("  「%s」不是行號。" % answer)
            return
        if not (1 <= index <= len(segs)):
            print("  行號要在 1 到 %d 之間。" % len(segs))
            return

        target = segs[index - 1]
        self.session.snapshot()
        self.session.segments.remove(target)
        self.session.dirty = True
        self.session.save()
        print("  ✓ 刪除了第 %d 行（%s ~ %s，%+.2f 半音）。按 u 可以復原。" % (
            index,
            fmt_time(self.session.frame_to_sec(target.start)),
            fmt_time(self.session.frame_to_sec(target.end)),
            target.semitones))

    def cmd_undo(self):
        """按 u：復原上一步。"""
        self.clear_status_line()
        if self.session.undo():
            self.session.save()
            print("  ✓ 已復原。現在有 %d 個區段。" % len(self.session.segments))
        else:
            print("  沒有東西可以復原了。")

    def cmd_save(self):
        """按 s：手動存檔。（其實每次 w/e/d/u 都會自動存，這個是保險用的。）"""
        self.clear_status_line()
        self.session.save()
        print("  ✓ 已存檔：")
        print("    %s" % os.path.basename(self.session.session_path))
        print("    %s" % os.path.basename(self.session.pitchmap_path))

    def cmd_preview_all(self):
        """
        按 P：把整首歌套用所有標記，產生預覽並播放。

        用 R2 引擎（快）。最後要輸出成品的時候按 R，那個才用 R3。
        """
        self.clear_status_line()

        if not self.session.segments:
            print("  還沒有任何標記，整首預覽等於原始檔案。")
            return

        breakpoints = self.session.flatten_to_breakpoints()
        map_path = os.path.join(self.workdir, "full.pitchmap")
        self.session.write_pitchmap(map_path, breakpoints)

        out = os.path.join(self.workdir, "preview_all.wav")
        cmd = build_rubberband_cmd(self.audio_path, out, pitchmap=map_path,
                                   engine=PREVIEW_ENGINE)

        print("  %d 個區段 → %d 個斷點。" % (len(self.session.segments),
                                              len(breakpoints)))
        if not run_rubberband(cmd, "產生整首預覽"):
            return

        self.preview_path = out
        self.preview_offset = 0.0       # 整首預覽的時間軸大致對得上原始檔
        self.playing_preview = True
        self.player.set_ab_loop(None, None)
        self.player.load(out)
        self.player.set_paused(False)
        print("  ▶ 播放整首預覽。（按 space 可以停，按 a 切回原始。）")
        print("    注意：pitchmap 會啟用 realtime 模式，長度可能跟原檔差一點點，")
        print("    所以預覽的時間軸僅供參考，標記還是以原始檔為準。")

    def cmd_render(self, keyboard):
        """
        按 R：用 R3 引擎算繪整首，輸出成檔案。

        這是最後一步，會比較慢，因為 R3 引擎的 CPU 負擔重很多，
        但品質也明顯比較好。
        """
        self.clear_status_line()

        if not self.session.segments:
            print("  還沒有任何標記，沒東西好算繪的。")
            return

        base, ext = os.path.splitext(self.audio_path)
        default_out = base + "_pitched" + (ext if ext else ".wav")

        answer = keyboard.ask("  輸出檔名？（直接 Enter 用 %s）> "
                              % os.path.basename(default_out))
        out_path = answer if answer else default_out
        out_path = os.path.abspath(os.path.expanduser(out_path))

        # 覆寫確認。手滑蓋掉原始檔會很想哭，所以這裡一定要問。
        if os.path.exists(out_path):
            confirm = keyboard.ask("  「%s」已經存在，要覆寫嗎？(y/N) > "
                                   % os.path.basename(out_path))
            if not confirm or confirm.lower() not in ("y", "yes"):
                print("  取消。")
                return

        if out_path == self.audio_path:
            print("  不能寫回原始檔案，換一個檔名吧。")
            return

        # 存檔並產生正式的 pitchmap
        self.session.save()
        breakpoints = self.session.flatten_to_breakpoints()

        cmd = build_rubberband_cmd(self.audio_path, out_path,
                                   pitchmap=self.session.pitchmap_path,
                                   engine=RENDER_ENGINE)

        print("  %d 個區段 → %d 個斷點，用 %s 引擎。" % (
            len(self.session.segments), len(breakpoints), RENDER_ENGINE))
        if not run_rubberband(cmd, "算繪（會比較久，請稍等）"):
            return

        print("  ✓ 輸出完成：%s" % out_path)

    # ---- 主迴圈 ------------------------------------------------------------

    def run(self):
        """
        程式的主迴圈。

        結構很單純：等按鍵（最多等 0.1 秒），有按就處理，
        沒按就更新一下狀態列，然後回到迴圈開頭。

        0.1 秒的輪詢間隔是「畫面看起來夠即時」和「不要吃太多 CPU」之間的平衡點，
        覺得卡的話可以調小，覺得風扇太吵可以調大。
        """
        print()
        print("  ══════════════════════════════════════════════════")
        print("   pitchmark —— Rubber Band 手動修音工具")
        print("  ══════════════════════════════════════════════════")
        print()
        print("  檔案：%s" % os.path.basename(self.audio_path))
        print("  取樣率：%d Hz　聲道：%d　長度：%s" % (
            self.session.samplerate,
            probe_audio(self.audio_path)["channels"],
            fmt_time(self.session.duration)))

        loaded = self.session.load_if_exists()
        if loaded:
            print("  %s" % loaded)

        print()
        print("  按 ? 看說明，按 q 離開。")
        print()

        # 每個按鍵對應到哪個動作。
        # 要加新功能的話，寫一個 cmd_xxx 方法，然後在這裡加一行就好。
        with Keyboard() as kb:
            simple_actions = {
                " ": self.cmd_toggle_play,
                "{": lambda: self.cmd_seek(-10.0),
                "}": lambda: self.cmd_seek(+10.0),
                "[": lambda: self.cmd_seek(-1.0),
                "]": lambda: self.cmd_seek(+1.0),
                "<": lambda: self.cmd_seek(-0.1),
                ">": lambda: self.cmd_seek(+0.1),
                ",": lambda: self.cmd_seek(-0.1),   # < 不用按 shift 的版本
                ".": lambda: self.cmd_seek(+0.1),   # > 不用按 shift 的版本
                "i": self.cmd_mark_in,
                "o": self.cmd_mark_out,
                "x": self.cmd_clear_marks,
                "p": self.cmd_preview_segment,
                "a": self.cmd_ab_toggle,
                "P": self.cmd_preview_all,
                "w": self.cmd_write,
                "l": self.cmd_list,
                "u": self.cmd_undo,
                "s": self.cmd_save,
                "?": self.print_help,
            }

            # 這些需要用到鍵盤物件（因為要問使用者問題）
            asking_actions = {
                "g": self.cmd_goto,
                "t": self.cmd_set_semitones,
                "e": self.cmd_edit,
                "d": self.cmd_delete,
                "R": self.cmd_render,
                "+": lambda k: self.cmd_nudge(+NUDGE_STEP, k),
                "=": lambda k: self.cmd_nudge(+NUDGE_STEP, k),  # + 不用按 shift
                "-": lambda k: self.cmd_nudge(-NUDGE_STEP, k),
            }

            while self.running:
                key = kb.read(0.1)

                if key is None:
                    # 沒按鍵，更新一下狀態列就好
                    self.print_status_line()
                    continue

                if key == "b":
                    self.clear_status_line()
                    if self.playing_preview:
                        self.switch_to_original(self.last_play_start)
                    else:
                        self.player.seek_absolute(self.last_play_start)
                    print("  ← 回到 %s。" % fmt_time(self.last_play_start))

                elif key == "q":
                    self.clear_status_line()
                    if self.session.dirty:
                        answer = kb.ask("  還有沒存的變更，真的要離開嗎？(y/N) > ")
                        if not answer or answer.lower() not in ("y", "yes"):
                            print("  沒事，繼續。")
                            continue
                    self.running = False

                elif key in simple_actions:
                    simple_actions[key]()

                elif key in asking_actions:
                    asking_actions[key](kb)

                elif key == "\x03":     # Ctrl-C
                    self.running = False

                # 其他按鍵一律無視，不要囉唆

        print()
        print("  掰掰！")

    def cleanup(self):
        """關閉播放器、刪掉暫存檔。程式結束時一定要跑到。"""
        try:
            self.player.close()
        except Exception:
            pass
        shutil.rmtree(self.workdir, ignore_errors=True)


def parse_time_input(text):
    """
    把使用者輸入的時間字串轉成秒數。

    支援三種寫法：
        83        → 83 秒
        1:23      → 83 秒
        1:23.456  → 83.456 秒

    看不懂的話回傳 None。
    """
    text = text.strip()

    # m:ss 或 m:ss.mmm
    match = re.match(r"^(\d+):(\d+(?:\.\d+)?)$", text)
    if match:
        return int(match.group(1)) * 60 + float(match.group(2))

    # 純秒數
    try:
        return float(text)
    except ValueError:
        return None


def main():
    if len(sys.argv) < 2:
        print("用法：python3 pitchmark.py <音檔>")
        print()
        print("例如：python3 pitchmark.py vocal.wav")
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print("找不到檔案：%s" % audio_path)
        sys.exit(1)

    # 開工前先確認外部工具都在，不要做到一半才發現少東西
    need_tool("mpv", "brew install mpv")
    need_tool("rubberband", "brew install rubberband")
    need_tool("ffmpeg", "brew install ffmpeg")
    need_tool("ffprobe", "brew install ffmpeg")

    app = None
    try:
        app = PitchMark(audio_path)
        app.run()
    except KeyboardInterrupt:
        print()
        print("  中斷。")
    finally:
        if app is not None:
            app.cleanup()


if __name__ == "__main__":
    # 忽略 SIGPIPE，避免把輸出接到 head 之類的東西時噴錯
    try:
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    except (AttributeError, ValueError):
        pass
    main()
