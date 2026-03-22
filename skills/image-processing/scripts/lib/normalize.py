from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageOps


CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from io_utils import derive_output_path, save_image


SUPPORTED_MODES = {"pad", "fit", "crop"}
DEFAULT_SUFFIX = "-normalized"
RESAMPLE = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS


def parse_size(value: str) -> tuple[int, int]:
    width_text, separator, height_text = value.lower().partition("x")
    if separator != "x":
        raise ValueError("size must use WxH format")

    try:
        width = int(width_text)
        height = int(height_text)
    except ValueError as exc:
        raise ValueError("size values must be integers") from exc

    if width <= 0 or height <= 0:
        raise ValueError("size values must be positive")

    return width, height


def normalize_image(
    image: Image.Image,
    size: tuple[int, int],
    mode: str = "pad",
    background: tuple[int, int, int, int] = (0, 0, 0, 0),
) -> Image.Image:
    width, height = size
    if width <= 0 or height <= 0:
        raise ValueError("size values must be positive")
    if mode not in SUPPORTED_MODES:
        raise ValueError(f"unsupported mode: {mode}")

    source = image.convert("RGBA")

    if mode == "fit":
        return source.resize((width, height), RESAMPLE)

    if mode == "crop":
        return ImageOps.fit(
            source, (width, height), method=RESAMPLE, centering=(0.5, 0.5)
        )

    contained = ImageOps.contain(source, (width, height), method=RESAMPLE)
    canvas = Image.new("RGBA", (width, height), background)
    offset = ((width - contained.width) // 2, (height - contained.height) // 2)
    canvas.paste(contained, offset, contained)
    return canvas


def normalize_image_file(
    input_path: str | Path,
    size: tuple[int, int],
    mode: str = "pad",
    output_path: str | Path | None = None,
) -> Path:
    source_path = Path(input_path)
    target_path = derive_output_path(
        source_path, suffix=DEFAULT_SUFFIX, output=output_path
    )

    with Image.open(source_path) as image:
        normalized = normalize_image(image, size=size, mode=mode)
        save_image(normalized, target_path)

    return target_path
