#!/bin/sh
# 把 main 的最新內容做成 public 分支上的一個新 commit，推到公開 repo。
#
# public 分支跟 main 沒有共同歷史，所以 main 的舊 commit（含早期的測試音檔）
# 永遠不會被推出去。public 分支絕對不要從 main merge 或 rebase，只用這個腳本更新。
#
# 用法：sh tools/publish.sh "這次更新的說明"
set -e

msg="${1:-同步最新版本}"

if [ "$(git branch --show-current)" != "main" ]; then
	echo "請先切回 main 分支再執行"; exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "main 有未 commit 的改動，請先 commit"; exit 1
fi

git switch -q public
# 內容完全換成 main 的版本（包含 main 裡刪掉的檔案）
git restore --source=main --staged --worktree :/
if git diff --cached --quiet; then
	echo "（公開版已經是最新，沒有新改動）"
else
	git commit -q -m "$msg"
	echo "已建立公開版 commit：$(git log -1 --format='%h %s')"
fi
git push public public:main
git switch -q main
