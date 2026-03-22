from __future__ import annotations

import argparse
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))


DEFAULT_SUFFIX = "-montage"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="把 2 张或多张图片横向拼成一张。",
        epilog=(
            "示例:\n"
            "  python scripts/img_montage.py before.png after.png -o montage.png\n\n"
            "输入尺寸不一致时会自动做最小归一化。成功时会在 stdout 回显保存位置。"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument("images", nargs="+", help="输入图片路径，至少 2 张")
    parser.add_argument("-o", "--output", help="输出拼图路径")
    return parser


def create_montage(
    image_paths: list[str], output_path: str | Path | None = None
) -> Path:
    from PIL import Image

    from io_utils import derive_output_path, save_image
    from layout import build_labeled_montage

    if len(image_paths) < 2:
        raise ValueError("img_montage.py requires at least two input images")

    source_paths = [Path(item) for item in image_paths]
    target_path = derive_output_path(
        source_paths[0], suffix=DEFAULT_SUFFIX, output=output_path
    )

    opened = [Image.open(path).convert("RGBA") for path in source_paths]
    try:
        montage = build_labeled_montage(
            opened, labels=[path.stem for path in source_paths]
        )
        save_image(montage, target_path)
    finally:
        for image in opened:
            image.close()

    return target_path


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    output_path = create_montage(args.images, output_path=args.output)
    print(f"拼图已保存 {Path(output_path).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
