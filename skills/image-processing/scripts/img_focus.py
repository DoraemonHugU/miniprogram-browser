from __future__ import annotations

import argparse
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))


def parse_box(value: str) -> dict[str, int]:
    parts = value.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("box must use x,y,w,h format")
    try:
        x, y, w, h = [int(part) for part in parts]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("box values must be integers") from exc
    if w <= 0 or h <= 0:
        raise argparse.ArgumentTypeError("box width and height must be positive")
    return {"x": x, "y": y, "w": w, "h": h}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="按显式 box 裁剪单张图片。",
        epilog=(
            "示例:\n"
            "  python scripts/img_focus.py page.png --box 120,48,220,120 -o focus.png\n\n"
            "成功时会在 stdout 回显保存位置。"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument("image", help="输入图片路径")
    parser.add_argument(
        "--box", required=True, type=parse_box, help="裁剪区域，格式为 x,y,w,h"
    )
    parser.add_argument("-o", "--output", required=True, help="输出裁剪图路径")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    from focus import create_focus_image

    output_path = create_focus_image(
        args.image,
        args.box,
        output_path=args.output,
    )
    print(f"裁剪图已保存 {Path(output_path).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
