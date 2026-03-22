from __future__ import annotations

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
BOX_STYLES = [
    {"outline": (17, 24, 39, 255), "fill": (17, 24, 39, 96)},
    {"outline": (30, 64, 175, 255), "fill": (37, 99, 235, 92)},
    {"outline": (21, 128, 61, 255), "fill": (34, 197, 94, 92)},
    {"outline": (107, 33, 168, 255), "fill": (168, 85, 247, 92)},
    {"outline": (194, 65, 12, 255), "fill": (249, 115, 22, 92)},
    {"outline": (250, 204, 21, 255), "fill": (250, 204, 21, 108)},
    {"outline": (34, 211, 238, 255), "fill": (34, 211, 238, 96)},
    {"outline": (255, 255, 255, 255), "fill": (255, 255, 255, 112)},
]


def _relative_luminance(rgb: tuple[int, int, int]) -> float:
    def convert(channel: int) -> float:
        value = channel / 255.0
        if value <= 0.03928:
            return value / 12.92
        return ((value + 0.055) / 1.055) ** 2.4

    r, g, b = rgb
    return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b)


def _contrast_ratio(rgb_a: tuple[int, int, int], rgb_b: tuple[int, int, int]) -> float:
    lum_a = _relative_luminance(rgb_a)
    lum_b = _relative_luminance(rgb_b)
    lighter = max(lum_a, lum_b)
    darker = min(lum_a, lum_b)
    return (lighter + 0.05) / (darker + 0.05)


def _sample_region_color(
    image: Image.Image, box: dict[str, int]
) -> tuple[int, int, int]:
    left = max(0, box["x"])
    top = max(0, box["y"])
    right = min(image.width, box["x"] + box["w"])
    bottom = min(image.height, box["y"] + box["h"])
    if left >= right or top >= bottom:
        return (255, 255, 255)
    region = np.array(
        image.crop((left, top, right, bottom)).convert("RGB"), dtype=np.uint8
    )
    mean = region.mean(axis=(0, 1))
    return (int(mean[0]), int(mean[1]), int(mean[2]))


def pick_box_style(
    index: int,
    sample_color: tuple[int, int, int] = (255, 255, 255),
    used_outlines: set[tuple[int, int, int, int]] | None = None,
) -> dict[str, tuple[int, int, int, int]]:
    used_outlines = used_outlines or set()
    ranked = sorted(
        BOX_STYLES,
        key=lambda style: _contrast_ratio(style["outline"][:3], sample_color),
        reverse=True,
    )
    rotated = ranked[index % len(ranked) :] + ranked[: index % len(ranked)]
    for style in rotated:
        if style["outline"] not in used_outlines:
            return style
    return rotated[0]


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
    highlighted = after.convert("RGBA").copy()
    overlay_image = Image.new("RGBA", highlighted.size, (0, 0, 0, 0))
    drawer = ImageDraw.Draw(highlighted)
    used_outlines: set[tuple[int, int, int, int]] = set()
    for index, box in enumerate(boxes):
        sample_color = _sample_region_color(after, box)
        style = pick_box_style(
            index, sample_color=sample_color, used_outlines=used_outlines
        )
        used_outlines.add(style["outline"])
        left = box["x"]
        top = box["y"]
        right = left + box["w"]
        bottom = top + box["h"]
        mask = threshold_mask[top:bottom, left:right]
        if mask.size:
            mask_image = Image.fromarray(mask.astype("uint8"), mode="L")
            fill_layer = Image.new("RGBA", mask_image.size, style["fill"])
            overlay_image.paste(fill_layer, (left, top), mask_image)
        drawer.rectangle((left, top, right, bottom), outline=style["outline"], width=2)
    return Image.alpha_composite(highlighted, overlay_image)


def compute_diff_regions(
    before_img: Image.Image,
    after_img: Image.Image,
    granularity: str = "coarse",
) -> tuple[float, Image.Image, list[dict[str, int]]]:
    normalized_before, normalized_after = _normalize_pair(before_img, after_img)
    before_gray = _to_gray_array(normalized_before)
    after_gray = _to_gray_array(normalized_after)

    score, diff_map = structural_similarity(before_gray, after_gray, full=True)
    diff_uint8 = ((1.0 - diff_map) * 255.0).clip(0, 255).astype("uint8")
    _, threshold = cv2.threshold(
        diff_uint8, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU
    )
    if granularity == "coarse":
        threshold = cv2.morphologyEx(
            threshold,
            cv2.MORPH_CLOSE,
            np.ones((3, 3), dtype=np.uint8),
            iterations=1,
        )
    elif granularity == "fine":
        threshold = cv2.morphologyEx(
            threshold,
            cv2.MORPH_OPEN,
            np.ones((2, 2), dtype=np.uint8),
            iterations=1,
        )
    else:
        raise ValueError(f"unsupported granularity: {granularity}")

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


def create_diff_artifacts(
    before_path: str | Path,
    after_path: str | Path,
    output_path: str | Path | None = None,
    granularity: str = "coarse",
) -> tuple[Path, list[dict[str, int]]]:
    before_source = Path(before_path)
    after_source = Path(after_path)
    target_path = derive_output_path(
        before_source, suffix=DEFAULT_SUFFIX, output=output_path
    )
    ensure_output_parent(target_path)

    with Image.open(before_source) as before_img, Image.open(after_source) as after_img:
        _score, diff_image, boxes = compute_diff_regions(
            before_img, after_img, granularity=granularity
        )
        save_image(diff_image, target_path)

    return target_path, boxes
