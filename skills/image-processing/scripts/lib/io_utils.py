from pathlib import Path

from PIL import Image


JPEG_SUFFIXES = {".jpg", ".jpeg"}


def derive_output_path(
    input_path: Path, suffix: str, output: str | Path | None = None
) -> Path:
    if output:
        return Path(output)
    return input_path.with_name(f"{input_path.stem}{suffix}{input_path.suffix}")


def ensure_output_parent(output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    return output_path


def save_image(image: Image.Image, output_path: str | Path) -> Path:
    target = ensure_output_parent(Path(output_path))
    if target.suffix.lower() in JPEG_SUFFIXES:
        flattened = Image.new("RGB", image.size, (255, 255, 255))
        if image.mode == "RGBA":
            flattened.paste(image, mask=image.getchannel("A"))
        else:
            flattened.paste(image.convert("RGB"))
        flattened.save(target)
        return target
    image.save(target)
    return target
