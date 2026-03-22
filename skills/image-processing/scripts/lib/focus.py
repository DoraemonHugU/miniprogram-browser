from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from io_utils import derive_output_path, save_image


DEFAULT_SUFFIX = "-focus"
MIN_FOCUS_EDGE = 160


def build_focus_image(
    image: Image.Image,
    box: dict[str, int],
    padding: int = 0,
) -> Image.Image:
    left = max(0, box["x"] - padding)
    top = max(0, box["y"] - padding)
    right = min(image.width, box["x"] + box["w"] + padding)
    bottom = min(image.height, box["y"] + box["h"] + padding)
    if left >= right or top >= bottom:
        raise ValueError("focus crop box resolves to an empty region")
    cropped = image.crop((left, top, right, bottom))
    shortest_edge = min(cropped.width, cropped.height)
    if shortest_edge <= 0:
        raise ValueError("focus crop box resolves to an empty region")
    if shortest_edge >= MIN_FOCUS_EDGE:
        return cropped

    scale = MIN_FOCUS_EDGE / shortest_edge
    target_size = (
        max(1, int(round(cropped.width * scale))),
        max(1, int(round(cropped.height * scale))),
    )
    return cropped.resize(target_size, Image.Resampling.NEAREST)


def create_focus_image(
    image_path: str | Path,
    box: dict[str, int],
    output_path: str | Path | None = None,
    padding: int = 0,
) -> Path:
    source = Path(image_path)
    target_path = derive_output_path(source, suffix=DEFAULT_SUFFIX, output=output_path)

    with Image.open(source) as image:
        focused = build_focus_image(image.convert("RGBA"), box, padding=padding)
        save_image(focused, target_path)

    return target_path
