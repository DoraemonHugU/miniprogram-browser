from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image


SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from io_utils import derive_output_path, ensure_output_parent
from layout import horizontal_montage


DEFAULT_SUFFIX = "-montage"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build a horizontal montage from two or more images."
    )
    parser.add_argument("images", nargs="+", help="input image paths")
    parser.add_argument("-o", "--output", help="path for the montage image")
    return parser


def create_montage(
    image_paths: list[str], output_path: str | Path | None = None
) -> Path:
    if len(image_paths) < 2:
        raise ValueError("img_montage.py requires at least two input images")

    source_paths = [Path(item) for item in image_paths]
    target_path = derive_output_path(
        source_paths[0], suffix=DEFAULT_SUFFIX, output=output_path
    )
    ensure_output_parent(target_path)

    opened = [Image.open(path).convert("RGBA") for path in source_paths]
    try:
        montage = horizontal_montage(opened)
        montage.save(target_path)
    finally:
        for image in opened:
            image.close()

    return target_path


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    output_path = create_montage(args.images, output_path=args.output)
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
