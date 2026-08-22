#!/usr/bin/env bash
# 校验本套技能是否符合 House Spec（见 SKILL-SPEC.md）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0; total=0

REQ_SECTIONS=("## 硬约束" "## 权限与数据边界" "## 何时使用" "## 输入输出契约" "## 流程" "## 自检闸门" "## 量化验收指标" "## 常见失败模式" "## 降级与失败路径" "## 执行留痕与记忆写回")

check() {
  local f="$1" dir name
  dir="$(basename "$(dirname "$f")")"
  total=$((total+1))
  echo "── $f"

  # frontmatter 字段
  for k in name description license compatibility metadata allowed-tools; do
    grep -q "^$k:" "$f" || { echo "   ✗ 缺 frontmatter 字段: $k"; fail=1; }
  done

  # name 合规 + 与目录同名
  name=$(awk -F': *' '/^name:/{print $2; exit}' "$f")
  [[ "$name" == "$dir" ]] || { echo "   ✗ name($name) 与目录名($dir) 不一致"; fail=1; }
  [[ "$name" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "   ✗ name 命名不合规: $name"; fail=1; }
  [[ "$name" == *--* ]] && { echo "   ✗ name 含连续连字符"; fail=1; }
  [[ ${#name} -le 64 ]] || { echo "   ✗ name 超过 64 字符"; fail=1; }

  # description 长度
  local dlen; dlen=$(awk -F'description: *' '/^description:/{print length($2); exit}' "$f")
  [[ -n "$dlen" && "$dlen" -le 1024 ]] || { echo "   ✗ description 缺失或超 1024 字符"; fail=1; }

  # 行数 ≤500
  local lines; lines=$(wc -l < "$f")
  [[ "$lines" -le 500 ]] || { echo "   ✗ SKILL.md $lines 行，超过 500 行上限"; fail=1; }

  # 必备段落
  for s in "${REQ_SECTIONS[@]}"; do
    grep -q "^$s" "$f" || { echo "   ✗ 缺段落: $s"; fail=1; }
  done

  # 退出条件硬声明
  grep -q "不得进入下一步" "$f" || { echo "   ✗ 未写死「未满足退出条件不得进入下一步」"; fail=1; }

  echo "   · $lines 行"
}

while IFS= read -r f; do check "$f"; done < <(find "$ROOT" -path "*/skills/*/SKILL.md" | sort)

echo
if [[ $fail -eq 0 ]]; then echo "全部 $total 个技能通过 House Spec 校验。"; else echo "有不合规项，见上。"; exit 1; fi
