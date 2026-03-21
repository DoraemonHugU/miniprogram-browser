from pathlib import Path


def derive_output_path(
    input_path: Path, suffix: str, output: str | None = None
) -> Path:
    if output:
        return Path(output)
    return input_path.with_name(f"{input_path.stem}{suffix}{input_path.suffix}")
