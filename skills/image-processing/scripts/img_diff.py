from __future__ import annotations

import argparse
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="生成两张图片的差异图。",
        epilog=(
            "示例:\n"
            "  python scripts/img_diff.py before.png after.png -o diff.png\n\n"
            "成功时会在 stdout 回显保存位置和差异框。"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument("before_image", help="before 图片路径")
    parser.add_argument("after_image", help="after 图片路径")
    parser.add_argument("-o", "--output", required=True, help="输出差异图路径")
    parser.add_argument(
        "--granularity",
        choices=["coarse", "fine"],
        default="coarse",
        help="差异框粒度：coarse（默认）或 fine",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    from diffing import create_diff_artifacts

    diff_path, boxes = create_diff_artifacts(
        args.before_image,
        args.after_image,
        output_path=args.output,
        granularity=args.granularity,
    )
    lines = [f"差异图已保存 {Path(diff_path).resolve()}"]
    if boxes:
        for index, box in enumerate(boxes, start=1):
            lines.append(
                f"box{index}: x={box['x']} y={box['y']} w={box['w']} h={box['h']}"
            )
    else:
        lines.append("未检测到明显差异")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
