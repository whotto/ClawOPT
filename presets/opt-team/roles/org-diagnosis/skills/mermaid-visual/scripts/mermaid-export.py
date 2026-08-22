#!/usr/bin/env python3
"""
text-visualizer: Mermaid 图表导出 PNG 脚本
调用 mmdc (mermaid-cli) 将 .mmd 文件或内联 Mermaid 代码导出为 PNG。

用法:
  python mermaid-export.py --input diagram.mmd --output diagram.png
  python mermaid-export.py --content "flowchart LR\n  A-->B" --output diagram.png
  python mermaid-export.py --input diagram.mmd --theme dark
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def check_mmdc() -> str:
    """检测 mmdc 是否可用，返回路径。"""
    mmdc = shutil.which("mmdc")
    if mmdc:
        return mmdc

    # 尝试 npx
    try:
        result = subprocess.run(
            ["npx", "--yes", "@mermaid-js/mermaid-cli", "--version"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            return "npx_mermaid"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return ""


def export_mermaid(
    input_path: str | None,
    content: str | None,
    output: str,
    theme: str = "default",
    background: str = "white",
    width: int = 2560,
    scale: int = 2,
) -> str:
    """导出 Mermaid 图表为 PNG。"""

    mmdc = check_mmdc()
    if not mmdc:
        print(
            "错误: mmdc (mermaid-cli) 未安装。\n"
            "安装方式:\n"
            "  npm install -g @mermaid-js/mermaid-cli\n"
            "或:\n"
            "  npx @mermaid-js/mermaid-cli --help",
            file=sys.stderr,
        )
        sys.exit(1)

    # 如果传入的是内联内容，写入临时文件
    tmp_file = None
    if content and not input_path:
        tmp_file = tempfile.NamedTemporaryFile(suffix=".mmd", mode="w", delete=False, encoding="utf-8")
        tmp_file.write(content)
        tmp_file.close()
        input_path = tmp_file.name

    if not input_path or not os.path.isfile(input_path):
        print(f"错误: 输入文件不存在: {input_path}", file=sys.stderr)
        sys.exit(1)

    Path(output).parent.mkdir(parents=True, exist_ok=True)

    # 构建 mmdc 命令
    if mmdc == "npx_mermaid":
        cmd = ["npx", "--yes", "@mermaid-js/mermaid-cli"]
    else:
        cmd = [mmdc]

    cmd += [
        "-i", input_path,
        "-o", output,
        "-t", theme,
        "-b", background,
        "-w", str(width),
        "-s", str(scale),
    ]

    try:
        print(f"[mermaid] 导出中: {input_path} → {output}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        if result.returncode != 0:
            print(f"[mermaid] mmdc 错误:\n{result.stderr}", file=sys.stderr)
            sys.exit(1)

        print(f"[mermaid] 已保存: {output}")
        return output

    except subprocess.TimeoutExpired:
        print("[mermaid] 导出超时（60s）", file=sys.stderr)
        sys.exit(1)
    finally:
        if tmp_file and os.path.exists(tmp_file.name):
            os.unlink(tmp_file.name)


def main():
    parser = argparse.ArgumentParser(
        description="text-visualizer: Mermaid 图表导出 PNG",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s --input diagram.mmd --output diagram.png
  %(prog)s --content "flowchart LR\\n  A-->B" --output diagram.png
  %(prog)s --input diagram.mmd --theme dark --output dark-diagram.png

依赖:
  需要安装 mermaid-cli: npm install -g @mermaid-js/mermaid-cli
  或通过 npx 自动安装: npx @mermaid-js/mermaid-cli
        """,
    )

    input_group = parser.add_mutually_exclusive_group()
    input_group.add_argument("--input", "-i", type=str, help="Mermaid 文件路径 (.mmd)")
    input_group.add_argument("--content", "-c", type=str, help="内联 Mermaid 代码")

    parser.add_argument("--output", "-o", type=str, default="output.png", help="输出 PNG 路径 (默认: output.png)")
    parser.add_argument("--theme", choices=["default", "dark", "forest", "neutral"], default="default", help="Mermaid 主题 (默认: default)")
    parser.add_argument("--background", "-b", type=str, default="white", help="背景色 (默认: white)")
    parser.add_argument("--width", "-w", type=int, default=2560, help="输出宽度 (默认: 2560)")
    parser.add_argument("--scale", "-s", type=int, default=2, help="缩放倍数 (默认: 2)")

    args = parser.parse_args()

    if not args.input and not args.content:
        parser.print_help()
        print("\n错误: 请提供 --input 或 --content 参数。", file=sys.stderr)
        sys.exit(1)

    # 处理转义换行符
    content = args.content
    if content:
        content = content.replace("\\n", "\n")

    export_mermaid(
        input_path=args.input,
        content=content,
        output=args.output,
        theme=args.theme,
        background=args.background,
        width=args.width,
        scale=args.scale,
    )


if __name__ == "__main__":
    main()
