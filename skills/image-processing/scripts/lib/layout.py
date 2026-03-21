from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from normalize import normalize_image


def normalize_images_to_shared_canvas(
    images: list[Image.Image],
    background: tuple[int, int, int, int] = (0, 0, 0, 0),
) -> list[Image.Image]:
    max_width = max(image.width for image in images)
    max_height = max(image.height for image in images)
    return [
        normalize_image(
            image, size=(max_width, max_height), mode="pad", background=background
        )
        for image in images
    ]


def horizontal_montage(
    images: list[Image.Image],
    gap: int = 0,
    background: tuple[int, int, int, int] = (0, 0, 0, 0),
) -> Image.Image:
    if len(images) < 2:
        raise ValueError("horizontal_montage requires at least two images")

    normalized = normalize_images_to_shared_canvas(images, background=background)
    panel_width = normalized[0].width
    panel_height = normalized[0].height
    total_width = panel_width * len(normalized) + gap * (len(normalized) - 1)
    canvas = Image.new("RGBA", (total_width, panel_height), background)

    cursor_x = 0
    for image in normalized:
        canvas.paste(image, (cursor_x, 0), image)
        cursor_x += panel_width + gap

    return canvas
