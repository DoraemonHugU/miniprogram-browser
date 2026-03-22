from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps


CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from io_utils import derive_output_path, ensure_output_parent
from normalize import normalize_image


DEFAULT_SUFFIX = "-overlay"
DEFAULT_BEFORE_COLOR = (255, 0, 0)
DEFAULT_AFTER_COLOR = (0, 255, 255)


def _normalize_pair(
    before: Image.Image, after: Image.Image
) -> tuple[Image.Image, Image.Image]:
    width = max(before.width, after.width)
    height = max(before.height, after.height)
    size = (width, height)
    return (
        normalize_image(before, size=size, mode="pad"),
        normalize_image(after, size=size, mode="pad"),
    )


def _build_colored_layer(image: Image.Image, color: tuple[int, int, int]) -> np.ndarray:
    gray = np.array(ImageOps.grayscale(image.convert("RGBA")), dtype=np.uint8)
    strength = 255 - gray
    layer = np.zeros((gray.shape[0], gray.shape[1], 4), dtype=np.uint8)
    for index, channel in enumerate(color):
        layer[..., index] = (strength.astype(np.uint16) * channel // 255).astype(
            np.uint8
        )
    layer[..., 3] = strength
    return layer


def color_overlay(
    before_img: Image.Image,
    after_img: Image.Image,
    before_color: tuple[int, int, int] = DEFAULT_BEFORE_COLOR,
    after_color: tuple[int, int, int] = DEFAULT_AFTER_COLOR,
) -> Image.Image:
    normalized_before, normalized_after = _normalize_pair(before_img, after_img)
    before_layer = _build_colored_layer(normalized_before, before_color)
    after_layer = _build_colored_layer(normalized_after, after_color)

    combined = np.zeros_like(before_layer)
    combined[..., :3] = np.clip(
        before_layer[..., :3].astype(np.uint16)
        + after_layer[..., :3].astype(np.uint16),
        0,
        255,
    ).astype(np.uint8)
    combined[..., 3] = np.maximum(before_layer[..., 3], after_layer[..., 3])
    return Image.fromarray(combined, mode="RGBA")


def create_overlay(
    before_path: str | Path,
    after_path: str | Path,
    output_path: str | Path | None = None,
) -> Path:
    before_source = Path(before_path)
    after_source = Path(after_path)
    target_path = derive_output_path(
        before_source, suffix=DEFAULT_SUFFIX, output=output_path
    )
    ensure_output_parent(target_path)

    with Image.open(before_source) as before_img, Image.open(after_source) as after_img:
        overlay = color_overlay(before_img, after_img)
        overlay.save(target_path)

    return target_path
