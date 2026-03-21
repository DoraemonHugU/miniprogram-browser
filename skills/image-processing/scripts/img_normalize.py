from __future__ import annotations

import argparse
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.normalize import normalize_image_file, parse_size


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Normalize a single image to a target canvas."
    )
    parser.add_argument("input_image", help="path to the source image")
    parser.add_argument(
        "--size", required=True, type=parse_size, help="target size as WxH"
    )
    parser.add_argument(
        "--mode",
        choices=["pad", "fit", "crop"],
        default="pad",
        help="normalization mode",
    )
    parser.add_argument("-o", "--output", help="path for the normalized image")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    output_path = normalize_image_file(
        input_path=args.input_image,
        size=args.size,
        mode=args.mode,
        output_path=args.output,
    )
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
