from __future__ import annotations

import os
import subprocess
import sys
import venv
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VENV_DIR = REPO_ROOT / "artifacts" / ".venv-image-processing-tests"
REQUIREMENTS = REPO_ROOT / "skills" / "image-processing" / "requirements.txt"
TEST_DIR = REPO_ROOT / "tests" / "image_processing"


def _venv_bin(name: str) -> Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / f"{name}.exe"
    return VENV_DIR / "bin" / name


def ensure_venv() -> None:
    if VENV_DIR.exists():
        return
    VENV_DIR.parent.mkdir(parents=True, exist_ok=True)
    venv.EnvBuilder(with_pip=True).create(VENV_DIR)


def run() -> int:
    ensure_venv()
    python = _venv_bin("python")

    subprocess.run(
        [str(python), "-m", "pip", "install", "-r", str(REQUIREMENTS)],
        check=True,
    )
    subprocess.run(
        [
            str(python),
            "-m",
            "unittest",
            "discover",
            "-s",
            str(TEST_DIR),
            "-p",
            "test_*.py",
            "-v",
        ],
        check=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
