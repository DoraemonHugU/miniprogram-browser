from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image


CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from diffing import compute_diff_regions
from io_utils import derive_output_path, ensure_output_parent
from layout import horizontal_montage
from normalize import normalize_image


DEFAULT_SUFFIX = "-focus"
ROW_GAP = 8


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


def _expand_box(
    box: dict[str, int], width: int, height: int, padding: int
) -> tuple[int, int, int, int]:
    left = max(0, box["x"] - padding)
    top = max(0, box["y"] - padding)
    right = min(width, box["x"] + box["w"] + padding)
    bottom = min(height, box["y"] + box["h"] + padding)
    return left, top, right, bottom


def _stack_rows(rows: list[Image.Image]) -> Image.Image:
    if not rows:
        raise ValueError("build_focus_sheet requires at least one row")
    width = max(row.width for row in rows)
    height = sum(row.height for row in rows) + ROW_GAP * (len(rows) - 1)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    cursor_y = 0
    for row in rows:
        canvas.paste(row, (0, cursor_y), row)
        cursor_y += row.height + ROW_GAP
    return canvas


def build_focus_sheet(
    before_img: Image.Image,
    after_img: Image.Image,
    boxes: list[dict[str, int]],
    crop_padding: int = 12,
    top_k: int = 6,
) -> Image.Image:
    normalized_before, normalized_after = _normalize_pair(before_img, after_img)
    ordered_boxes = sorted(boxes, key=lambda box: box["w"] * box["h"], reverse=True)[
        :top_k
    ]
    if not ordered_boxes:
        return horizontal_montage([normalized_before, normalized_after], gap=4)

    rows = []
    for box in ordered_boxes:
        left, top, right, bottom = _expand_box(
            box,
            normalized_before.width,
            normalized_before.height,
            crop_padding,
        )
        before_crop = normalized_before.crop((left, top, right, bottom))
        after_crop = normalized_after.crop((left, top, right, bottom))
        _score, diff_crop, _crop_boxes = compute_diff_regions(before_crop, after_crop)
        rows.append(horizontal_montage([before_crop, after_crop, diff_crop], gap=4))

    return _stack_rows(rows)


def load_regions(path: str | Path) -> list[dict[str, int]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return payload.get("boxes", [])


def create_focus_sheet(
    before_path: str | Path,
    after_path: str | Path,
    output_path: str | Path | None = None,
    regions_path: str | Path | None = None,
) -> Path:
    before_source = Path(before_path)
    after_source = Path(after_path)
    target_path = derive_output_path(
        before_source, suffix=DEFAULT_SUFFIX, output=output_path
    )
    ensure_output_parent(target_path)

    with Image.open(before_source) as before_img, Image.open(after_source) as after_img:
        if regions_path:
            boxes = load_regions(regions_path)
        else:
            _score, _diff_image, boxes = compute_diff_regions(before_img, after_img)
        sheet = build_focus_sheet(before_img, after_img, boxes)
        sheet.save(target_path)

    return target_path
