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
        description="生成两张图片的彩色叠加图。",
        epilog=(
            "示例:\n"
            "  python scripts/img_overlay.py before.png after.png -o overlay.png\n\n"
            "默认 before=红，after=青。成功时会在 stdout 回显保存位置。"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument("before_image", help="before 图片路径")
    parser.add_argument("after_image", help="after 图片路径")
    parser.add_argument("-o", "--output", help="输出叠加图路径")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    from overlaying import create_overlay

    output_path = create_overlay(
        args.before_image, args.after_image, output_path=args.output
    )
    print(f"叠加图已保存 {Path(output_path).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
