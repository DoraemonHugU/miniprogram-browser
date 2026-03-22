import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT / "skills" / "image-processing" / "scripts"
PYTHON = sys.executable


def _make_inputs(before_path: Path, after_path: Path) -> None:
    before = Image.new("RGBA", (20, 20), (255, 255, 255, 255))
    after = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
    ImageDraw.Draw(before).rectangle((5, 5, 14, 14), fill=(0, 0, 0, 255))
    ImageDraw.Draw(after).rectangle((15, 15, 24, 24), fill=(0, 0, 0, 255))
    ImageDraw.Draw(after).rectangle((28, 28, 34, 34), fill=(0, 0, 0, 255))
    before.save(before_path)
    after.save(after_path)


class WorkflowCliTests(unittest.TestCase):
    def test_all_scripts_work_by_direct_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            before_path = temp_path / "before.png"
            after_path = temp_path / "after.png"
            _make_inputs(before_path, after_path)

            normalized_path = temp_path / "normalized.png"
            montage_path = temp_path / "montage.png"
            diff_path = temp_path / "diff.png"
            overlay_path = temp_path / "overlay.png"
            focus_path = temp_path / "focus.png"
            review_sheet_path = temp_path / "review-sheet.png"

            normalize = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_normalize.py"),
                    str(before_path),
                    "--size",
                    "40x40",
                    "-o",
                    str(normalized_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(normalize.stdout.strip(), str(normalized_path))
            self.assertTrue(normalized_path.exists())

            montage = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_montage.py"),
                    str(before_path),
                    str(after_path),
                    "-o",
                    str(montage_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(montage.stdout.strip(), str(montage_path))
            self.assertTrue(montage_path.exists())

            diff = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_diff.py"),
                    str(before_path),
                    str(after_path),
                    "-o",
                    str(diff_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(diff.stdout.strip(), str(diff_path))
            self.assertTrue(diff_path.exists())
            self.assertTrue((temp_path / "diff.regions.json").exists())

            overlay = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_overlay.py"),
                    str(before_path),
                    str(after_path),
                    "-o",
                    str(overlay_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(overlay.stdout.strip(), str(overlay_path))
            self.assertTrue(overlay_path.exists())

            focus = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_focus_crops.py"),
                    str(before_path),
                    str(after_path),
                    "--regions",
                    str(temp_path / "diff.regions.json"),
                    "-o",
                    str(focus_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(focus.stdout.strip(), str(focus_path))
            self.assertTrue(focus_path.exists())

            review = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_montage.py"),
                    str(before_path),
                    str(after_path),
                    str(diff_path),
                    str(focus_path),
                    "-o",
                    str(review_sheet_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(review.stdout.strip(), str(review_sheet_path))
            self.assertTrue(review_sheet_path.exists())

    def test_default_outputs_work_for_jpeg_inputs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            before_path = temp_path / "before.jpg"
            after_path = temp_path / "after.jpg"

            before = Image.new("RGB", (20, 20), (255, 255, 255))
            after = Image.new("RGB", (40, 40), (255, 255, 255))
            ImageDraw.Draw(before).rectangle((5, 5, 14, 14), fill=(0, 0, 0))
            ImageDraw.Draw(after).rectangle((15, 15, 24, 24), fill=(0, 0, 0))
            ImageDraw.Draw(after).rectangle((28, 28, 34, 34), fill=(0, 0, 0))
            before.save(before_path)
            after.save(after_path)

            normalize = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_normalize.py"),
                    str(before_path),
                    "--size",
                    "40x40",
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertTrue(Path(normalize.stdout.strip()).exists())

            montage = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_montage.py"),
                    str(before_path),
                    str(after_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertTrue(Path(montage.stdout.strip()).exists())

            diff = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_diff.py"),
                    str(before_path),
                    str(after_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            diff_path = Path(diff.stdout.strip())
            self.assertTrue(diff_path.exists())
            self.assertTrue(
                diff_path.with_name(f"{diff_path.stem}.regions.json").exists()
            )

            overlay = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_overlay.py"),
                    str(before_path),
                    str(after_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertTrue(Path(overlay.stdout.strip()).exists())

            focus = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_focus_crops.py"),
                    str(before_path),
                    str(after_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertTrue(Path(focus.stdout.strip()).exists())


if __name__ == "__main__":
    unittest.main()
