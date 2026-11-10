#!/usr/bin/env bash
# 运行态目录（PI_RUNTIME_DIR）的准备与迁移。
# 用法：bash scripts/runtime.sh {init|sync|status}
# 不依赖 make，容器里也能直接跑。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

cmd="${1:-status}"

case "$cmd" in
  init)
    mkdir -p runtime/{mainAgent,agents,bundles,sessions,team/inbox,team/merge-proposals}
    chmod 700 runtime
    if [ -z "$(ls -A runtime/sessions 2>/dev/null)" ] && [ -d sessions ]; then
      echo "复制 sessions/ → runtime/sessions/"
      cp -a sessions/. runtime/sessions/
    else
      echo "runtime/sessions 已有数据，跳过（用 sync 增量同步）"
    fi
    ;;

  sync)
    if command -v rsync >/dev/null 2>&1; then
      rsync -a sessions/ runtime/sessions/
    else
      cp -a sessions/. runtime/sessions/
    fi
    echo "已同步：$(ls runtime/sessions | wc -l) 个 session"
    ;;

  status)
    echo "sessions/         $(ls sessions 2>/dev/null | wc -l) 个"
    echo "runtime/sessions  $(ls runtime/sessions 2>/dev/null | wc -l) 个"
    echo "runtime 大小       $(du -sh runtime 2>/dev/null | cut -f1)"
    find runtime -maxdepth 2 -type d | sort
    ;;

  *)
    echo "usage: $0 {init|sync|status}" >&2
    exit 2
    ;;
esac
