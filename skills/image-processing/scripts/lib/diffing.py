from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from skimage.metrics import structural_similarity


CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from io_utils import derive_output_path, ensure_output_parent, save_image
from normalize import normalize_image


DEFAULT_SUFFIX = "-diff"
MIN_CONTOUR_AREA = 4


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


def _to_gray_array(image: Image.Image) -> np.ndarray:
    rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
    return cv2.cvtColor(rgba, cv2.COLOR_RGBA2GRAY)


def _build_highlighted_diff(
    after: Image.Image, threshold_mask: np.ndarray, boxes: list[dict[str, int]]
) -> Image.Image:
    rgba = np.array(after.convert("RGBA"), dtype=np.uint8)
    overlay = np.zeros_like(rgba)
    overlay[..., 0] = 255
    overlay[..., 3] = np.where(threshold_mask > 0, 120, 0).astype(np.uint8)
    highlighted = Image.alpha_composite(
        after.convert("RGBA"), Image.fromarray(overlay, mode="RGBA")
    )
    drawer = ImageDraw.Draw(highlighted)
    for box in boxes:
        left = box["x"]
        top = box["y"]
        right = left + box["w"]
        bottom = top + box["h"]
        drawer.rectangle(
            (left, top, right, bottom), outline=(255, 196, 0, 255), width=2
        )
    return highlighted


def compute_diff_regions(
    before_img: Image.Image, after_img: Image.Image
) -> tuple[float, Image.Image, list[dict[str, int]]]:
    normalized_before, normalized_after = _normalize_pair(before_img, after_img)
    before_gray = _to_gray_array(normalized_before)
    after_gray = _to_gray_array(normalized_after)

    score, diff_map = structural_similarity(before_gray, after_gray, full=True)
    diff_uint8 = ((1.0 - diff_map) * 255.0).clip(0, 255).astype("uint8")
    _, threshold = cv2.threshold(
        diff_uint8, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU
    )
    threshold = cv2.morphologyEx(
        threshold,
        cv2.MORPH_CLOSE,
        np.ones((3, 3), dtype=np.uint8),
        iterations=1,
    )

    contours, _ = cv2.findContours(
        threshold, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    boxes = []
    for contour in contours:
        if cv2.contourArea(contour) < MIN_CONTOUR_AREA:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        boxes.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h)})

    boxes.sort(key=lambda box: (box["y"], box["x"]))
    diff_image = _build_highlighted_diff(normalized_after, threshold, boxes)
    return float(score), diff_image, boxes


def derive_regions_path(output_path: str | Path) -> Path:
    path = Path(output_path)
    return path.with_name(f"{path.stem}.regions.json")


def create_diff_artifacts(
    before_path: str | Path,
    after_path: str | Path,
    output_path: str | Path | None = None,
) -> tuple[Path, Path, float, list[dict[str, int]]]:
    before_source = Path(before_path)
    after_source = Path(after_path)
    target_path = derive_output_path(
        before_source, suffix=DEFAULT_SUFFIX, output=output_path
    )
    regions_path = derive_regions_path(target_path)
    ensure_output_parent(target_path)
    ensure_output_parent(regions_path)

    with Image.open(before_source) as before_img, Image.open(after_source) as after_img:
        score, diff_image, boxes = compute_diff_regions(before_img, after_img)
        save_image(diff_image, target_path)

    payload = {
        "imageSize": {"width": diff_image.width, "height": diff_image.height},
        "boxes": boxes,
    }
    regions_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return target_path, regions_path, score, boxes
