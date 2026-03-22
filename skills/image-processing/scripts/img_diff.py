from __future__ import annotations

import argparse
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPT_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from diffing import create_diff_artifacts


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate a highlighted diff image for two images."
    )
    parser.add_argument("before_image", help="path to the before image")
    parser.add_argument("after_image", help="path to the after image")
    parser.add_argument("-o", "--output", help="path for the diff image")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    diff_path, _regions_path, _score, _boxes = create_diff_artifacts(
        args.before_image,
        args.after_image,
        output_path=args.output,
    )
    print(diff_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
