#!/usr/bin/env bash

# 使用真实目录链接安装，git pull 后源文件更新会自动反映到技能目录。
# 不启用 nounset：兼容 macOS Bash 3.2 对空数组展开的行为。
set -eo pipefail

usage() {
  cat <<'EOF'
用法: ./install.sh [--agent both|claude|codex] [--skill <技能目录名称>]
  --agent  默认 claude；Claude: ~/.claude/skills，Codex: ~/.agents/skills
  --skill  只安装指定技能，例如：烛龙智能询价；省略则安装全部技能
  --help   显示帮助
示例: ./install.sh --agent both --skill '烛龙智能询价'
Windows PowerShell: .\install.ps1 [-Agent both|claude|codex] [-Skill <技能目录名称>]
EOF
}
fail() { printf '错误: %s\n' "$*" >&2; exit 1; }

agent=claude
skill_filter=
while (($#)); do
  case "$1" in
    --agent|--skill)
      (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || fail "$1 缺少参数"
      if [[ "$1" == --agent ]]; then agent=$2; else skill_filter=$2; fi
      shift 2 ;;
    --help) usage; exit 0 ;;
    *) fail "未知参数: $1（使用 --help 查看用法）" ;;
  esac
done
case "$agent" in both|claude|codex) ;; *) fail "未知 agent: $agent" ;; esac
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    command -v powershell.exe >/dev/null || fail 'Windows 安装需要 PowerShell'
    command -v cygpath >/dev/null || fail 'Windows 安装需要 Git Bash 的 cygpath'
    args=(-NoProfile -NonInteractive -File "$(cygpath -aw "$REPO_DIR/install.ps1")" -Agent "$agent")
    [[ -z "$skill_filter" ]] || args+=(-Skill "$skill_filter")
    exec powershell.exe "${args[@]}" ;;
esac
[[ -n "${HOME:-}" ]] || fail 'HOME 未设置'

skills=()
names=()
for skill_path in "$REPO_DIR"/*/*/; do
  [[ -f "$skill_path/SKILL.md" ]] || continue
  skill_path=${skill_path%/}
  skill_name=${skill_path##*/}
  [[ -z "$skill_filter" || "$skill_filter" == "$skill_name" ]] || continue
  for name in "${names[@]}"; do
    [[ "$name" != "$skill_name" ]] || fail "技能目录名称重复: $skill_name"
  done
  skills+=("$skill_path")
  names+=("$skill_name")
done
((${#skills[@]})) || fail "未找到技能: ${skill_filter:-全部}"
destinations=()
[[ "$agent" == codex ]] || destinations+=("$HOME/.claude/skills")
[[ "$agent" == claude ]] || destinations+=("$HOME/.agents/skills")

# 返回值：0 = 同一真实链接，2 = 不存在，1 = 冲突。
check_link() {
  if [[ -L "$2" && "$2" -ef "$1" ]]; then return 0
  elif [[ -e "$2" || -L "$2" ]]; then return 1
  else return 2; fi
}

# 先检查全部目标，避免发现已有目录时只安装了一部分。
for destination in "${destinations[@]}"; do
  for i in "${!skills[@]}"; do
    target="$destination/${names[$i]}"
    if check_link "${skills[$i]}" "$target"; then :
    else
      status=$?
      [[ "$status" == 2 ]] || fail "目标已存在: $target。请先将它移到技能搜索目录外备份，再重新安装；脚本不会删除或覆盖它。"
    fi
  done
done

for destination in "${destinations[@]}"; do
  mkdir -p -- "$destination" || fail "无法创建目录: $destination"
  for i in "${!skills[@]}"; do
    source=${skills[$i]}
    target="$destination/${names[$i]}"
    if check_link "$source" "$target"; then :
    else
      status=$?
      [[ "$status" == 2 ]] || fail "目标发生冲突: $target；请移到技能搜索目录外备份后重试。"
      ln -s -- "$source" "$target" || fail "无法创建链接: $target"
      check_link "$source" "$target" || fail "未创建真实链接: $target"
    fi
    printf '已连接: %s\n' "$target"
  done
done
printf '安装完成。仓库执行 git pull 后，链接中的技能文件会同步更新。\n'
