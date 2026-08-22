#!/usr/bin/env python3
"""重写每个角色 skills/README.md 里「## 已装备技能」与「## 目录结构」两段，使内容与磁盘实际一致。

只替换这两个标题到下一个二级标题之间的内容，其余手写章节原样保留。
README 里的表格是路由对账之外的第二道人眼防线——它必须由脚本生成，手写迟早会漂。

用法：python3 _shared/gen-skills-readme.py [--check]
      --check 只比对不写入，有差异时退出码 1（可用于发布前卡口）
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HEADING = "## 已装备技能"
TREE_HEADING = "## 目录结构"


def field(text, key):
    m = re.search(rf"^\s*{key}:\s*(.+)$", text, re.M)
    return m.group(1).strip().strip('"') if m else ""


def one_line(desc, limit=52):
    desc = desc.split("。")[0]
    return desc[:limit] + ("…" if len(desc) > limit else "")


def table(skills_dir):
    rows = []
    for d in sorted(p for p in skills_dir.iterdir() if p.is_dir() and not p.name.startswith("_")):
        sk = d / "SKILL.md"
        if not sk.exists():
            continue
        t = sk.read_text(encoding="utf-8")
        rows.append((
            d.name,
            one_line(field(t, "description")),
            "v" + field(t, "version") if field(t, "version") else "—",
            f"{len(t.splitlines())} 行",
            field(t, "allowed-tools"),
        ))
    if not rows:
        return "（本目录暂无已装备技能。）\n"
    out = ["| 技能 | 做什么 | 版本 | 篇幅 | 最小权限（allowed-tools） |",
           "|------|--------|------|------|--------------------------|"]
    for name, desc, ver, size, tools in rows:
        out.append(f"| `{name}` | {desc} | {ver} | {size} | `{tools}` |")
    out.append("")
    out.append(f"合计 **{len(rows)}** 条，全部通过 `_shared/validate-skills.sh` 的 House Spec 十项校验。")
    return "\n".join(out) + "\n"


def tree(skills_dir):
    lines = ["```", "skills/"]
    dirs = sorted(p for p in skills_dir.iterdir() if p.is_dir() and not p.name.startswith("_"))
    dirs = [d for d in dirs if (d / "SKILL.md").exists()]
    for i, d in enumerate(dirs):
        lines.append(f"├── {d.name}/")
        files = ["SKILL.md"] + sorted(
            str(f.relative_to(d)) for f in d.rglob("*")
            if f.is_file() and f.name != "SKILL.md" and "__pycache__" not in str(f)
        )
        stem = "│   "
        for j, f in enumerate(files):
            lines.append(f"{stem}{'└──' if j == len(files) - 1 else '├──'} {f}")
    lines += ["├── _pending/      待审批的候选技能（Agent 只能写这里）",
              "├── _archived/     已淘汰技能的留档",
              "└── _rejected/     评估后否决的技能与否决理由",
              "```"]
    return "\n".join(lines) + "\n"


def replace_block(text, heading, body):
    if heading not in text:
        return text, False
    head, rest = text.split(heading, 1)
    tail = rest.split("\n## ", 1)
    after = "\n## " + tail[1] if len(tail) > 1 else ""
    return f"{head}{heading}\n\n{body}{after}", True


def main():
    check = "--check" in sys.argv
    drift = False
    for readme in sorted(ROOT.glob("*/skills/README.md")):
        text = readme.read_text(encoding="utf-8")
        if HEADING not in text:
            print(f"⚠️  跳过（无「{HEADING}」段）：{readme.relative_to(ROOT)}")
            continue
        new, _ = replace_block(text, HEADING, table(readme.parent))
        new, _ = replace_block(new, TREE_HEADING, tree(readme.parent))
        if new == text:
            print(f"   = {readme.relative_to(ROOT)}")
            continue
        drift = True
        if check:
            print(f"   ✗ 与磁盘不一致：{readme.relative_to(ROOT)}")
        else:
            readme.write_text(new, encoding="utf-8")
            print(f"   ✓ 已更新：{readme.relative_to(ROOT)}")
    if check and drift:
        print("\nREADME 与磁盘不一致，跑一次 python3 _shared/gen-skills-readme.py 再提交。")
        return 1
    print("\nREADME 与磁盘一致。" if not drift else "\n已同步。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
