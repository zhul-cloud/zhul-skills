#!/bin/bash

# zhul-skills 安装脚本
# 将所有 skill 以 symlink 方式安装到 ~/.claude/skills/
# git pull 后自动生效，无需重新安装

SKILLS_DIR="$HOME/.claude/skills"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔧 安装 zhul-skills..."
echo "源目录: $REPO_DIR"
echo "目标目录: $SKILLS_DIR"
echo ""

# 确保目标目录存在
mkdir -p "$SKILLS_DIR"

# 遍历所有分类目录下的 skill 文件夹
for skill_path in "$REPO_DIR"/*/*/; do
  skill_name=$(basename "$skill_path")
  target="$SKILLS_DIR/$skill_name"

  if [ -d "$skill_path" ] && [ -f "$skill_path/SKILL.md" ]; then
    # 如果目标已存在（普通目录或旧 symlink），先删除
    if [ -e "$target" ] || [ -L "$target" ]; then
      rm -rf "$target"
      echo "  ♻️  已覆盖: $skill_name"
    else
      echo "  ✅ 安装: $skill_name"
    fi
    ln -s "$skill_path" "$target"
  fi
done

echo ""
echo "✅ 安装完成！已安装的 skills："
for skill_path in "$REPO_DIR"/*/*/; do
  skill_name=$(basename "$skill_path")
  if [ -f "$skill_path/SKILL.md" ]; then
    echo "   · $skill_name"
  fi
done

echo ""
echo "使用方式：在 Claude Code 中输入 /<skill名称>"
