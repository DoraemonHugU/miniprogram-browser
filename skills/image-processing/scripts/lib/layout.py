from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from normalize import normalize_image


MONTAGE_PADDING = 16
MONTAGE_GAP = 16
LABEL_ROW_HEIGHT = 32
MONTAGE_BACKGROUND = (255, 255, 255, 255)
PANEL_BACKGROUND = (255, 255, 255, 255)
PANEL_BORDER = (226, 232, 240, 255)
LABEL_CHIP_BACKGROUND = (248, 250, 252, 255)
LABEL_TEXT = (51, 65, 85, 255)


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


def _draw_label_chip(draw: ImageDraw.ImageDraw, x: int, text: str) -> None:
    font = ImageFont.load_default()
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    text_width = right - left
    text_height = bottom - top
    chip_width = text_width + 12
    chip_height = text_height + 8
    chip_y = MONTAGE_PADDING + max((LABEL_ROW_HEIGHT - chip_height) // 2, 0)
    draw.rounded_rectangle(
        (x, chip_y, x + chip_width, chip_y + chip_height),
        radius=8,
        fill=LABEL_CHIP_BACKGROUND,
        outline=PANEL_BORDER,
    )
    draw.text((x + 6, chip_y + 4), text, fill=LABEL_TEXT, font=font)


def build_labeled_montage(
    images: list[Image.Image],
    labels: list[str],
    gap: int = MONTAGE_GAP,
    background: tuple[int, int, int, int] = MONTAGE_BACKGROUND,
) -> Image.Image:
    if len(images) < 2:
        raise ValueError("build_labeled_montage requires at least two images")
    if len(images) != len(labels):
        raise ValueError("labels length must match images length")

    normalized = normalize_images_to_shared_canvas(images, background=PANEL_BACKGROUND)
    panel_width = normalized[0].width
    panel_height = normalized[0].height
    total_width = (
        panel_width * len(normalized)
        + gap * (len(normalized) - 1)
        + MONTAGE_PADDING * 2
    )
    total_height = panel_height + LABEL_ROW_HEIGHT + MONTAGE_PADDING * 2
    canvas = Image.new("RGBA", (total_width, total_height), background)
    draw = ImageDraw.Draw(canvas)

    panel_y = MONTAGE_PADDING + LABEL_ROW_HEIGHT
    cursor_x = MONTAGE_PADDING
    for image, label in zip(normalized, labels):
        panel = Image.new("RGBA", (panel_width, panel_height), PANEL_BACKGROUND)
        panel.paste(image, (0, 0), image)
        canvas.paste(panel, (cursor_x, panel_y), panel)
        draw.rounded_rectangle(
            (cursor_x, panel_y, cursor_x + panel_width, panel_y + panel_height),
            radius=12,
            outline=PANEL_BORDER,
            width=1,
        )
        _draw_label_chip(draw, cursor_x, label)
        cursor_x += panel_width + gap

    return canvas
