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

            montage_path = temp_path / "montage.png"
            diff_path = temp_path / "diff.png"
            overlay_path = temp_path / "overlay.png"
            focus_path = temp_path / "focus.png"
            review_sheet_path = temp_path / "review-sheet.png"

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
            self.assertIn(f"拼图已保存 {montage_path}", montage.stdout)
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
            self.assertIn(f"差异图已保存 {diff_path}", diff.stdout)
            self.assertIn("box1:", diff.stdout)
            self.assertTrue(diff_path.exists())

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
            self.assertIn(f"叠加图已保存 {overlay_path}", overlay.stdout)
            self.assertTrue(overlay_path.exists())

            focus = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPTS_DIR / "img_focus.py"),
                    str(after_path),
                    "--box",
                    "15,15,10,10",
                    "-o",
                    str(focus_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn(f"裁剪图已保存 {focus_path}", focus.stdout)
            self.assertTrue(focus_path.exists())

            with Image.open(focus_path) as focus_img:
                self.assertGreaterEqual(focus_img.width, 128)
                self.assertGreaterEqual(focus_img.height, 128)

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
            self.assertIn(f"拼图已保存 {review_sheet_path}", review.stdout)
            self.assertTrue(review_sheet_path.exists())

    def test_default_outputs_work_for_jpeg_inputs(self):
        for suffix in (".jpg", ".jpeg"):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as temp_dir:
                temp_path = Path(temp_dir)
                before_path = temp_path / f"before{suffix}"
                after_path = temp_path / f"after{suffix}"

                before = Image.new("RGB", (20, 20), (255, 255, 255))
                after = Image.new("RGB", (40, 40), (255, 255, 255))
                ImageDraw.Draw(before).rectangle((5, 5, 14, 14), fill=(0, 0, 0))
                ImageDraw.Draw(after).rectangle((15, 15, 24, 24), fill=(0, 0, 0))
                ImageDraw.Draw(after).rectangle((28, 28, 34, 34), fill=(0, 0, 0))
                before.save(before_path)
                after.save(after_path)

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
                self.assertIn("拼图已保存 ", montage.stdout)
                self.assertTrue(Path(montage.stdout.strip().split()[-1]).exists())

                diff = subprocess.run(
                    [
                        PYTHON,
                        str(SCRIPTS_DIR / "img_diff.py"),
                        str(before_path),
                        str(after_path),
                        "-o",
                        str(temp_path / f"diff{suffix}"),
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                diff_path = temp_path / f"diff{suffix}"
                self.assertIn(f"差异图已保存 {diff_path}", diff.stdout)
                self.assertIn("box1:", diff.stdout)
                self.assertTrue(diff_path.exists())

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
                self.assertIn("叠加图已保存 ", overlay.stdout)
                self.assertTrue(Path(overlay.stdout.strip().split()[-1]).exists())

                focus = subprocess.run(
                    [
                        PYTHON,
                        str(SCRIPTS_DIR / "img_focus.py"),
                        str(after_path),
                        "--box",
                        "15,15,10,10",
                        "-o",
                        str(temp_path / f"focus{suffix}"),
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertIn("裁剪图已保存 ", focus.stdout)
                with Image.open(Path(focus.stdout.strip().split()[-1])) as focus_img:
                    self.assertGreaterEqual(focus_img.width, 128)
                    self.assertGreaterEqual(focus_img.height, 128)
                self.assertTrue(Path(focus.stdout.strip().split()[-1]).exists())


if __name__ == "__main__":
    unittest.main()
