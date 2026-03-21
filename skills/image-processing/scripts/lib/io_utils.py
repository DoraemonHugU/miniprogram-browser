from pathlib import Path


def derive_output_path(
    input_path: Path, suffix: str, output: str | Path | None = None
) -> Path:
    if output:
        return Path(output)
    return input_path.with_name(f"{input_path.stem}{suffix}{input_path.suffix}")


def ensure_output_parent(output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    return output_path
