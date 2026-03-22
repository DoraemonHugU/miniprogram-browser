import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from tests.image_processing.helpers import load_lib_module


diffing_lib = load_lib_module("diffing.py")
compute_diff_regions = diffing_lib.compute_diff_regions
pick_box_style = diffing_lib.pick_box_style


def _luma(rgb: tuple[int, int, int]) -> float:
    return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114


SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "image-processing"
    / "scripts"
    / "img_diff.py"
)
PYTHON = sys.executable


def _draw_rect(
    path: Path, size: tuple[int, int], rects: list[tuple[int, int, int, int]]
) -> None:
    image = Image.new("RGBA", size, (255, 255, 255, 255))
    drawer = ImageDraw.Draw(image)
    for left, top, right, bottom in rects:
        drawer.rectangle((left, top, right, bottom), fill=(0, 0, 0, 255))
    image.save(path)


class DiffingLibTests(unittest.TestCase):
    def test_compute_diff_regions_detects_changed_box(self):
        before = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
        after = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
        ImageDraw.Draw(after).rectangle((24, 24, 34, 34), fill=(0, 0, 0, 255))

        score, diff_image, boxes = compute_diff_regions(before, after)

        self.assertLess(score, 1.0)
        self.assertEqual(diff_image.size, (40, 40))
        self.assertGreaterEqual(len(boxes), 1)
        self.assertTrue(any(box["x"] <= 24 <= box["x"] + box["w"] for box in boxes))

    def test_pick_box_style_chooses_distinct_colors_for_neighboring_boxes(self):
        style1 = pick_box_style(0, sample_color=(245, 245, 245))
        style2 = pick_box_style(
            1, sample_color=(245, 245, 245), used_outlines={style1["outline"]}
        )

        self.assertNotEqual(style1["outline"], style2["outline"])
        self.assertNotEqual(style1["fill"], style2["fill"])

    def test_pick_box_style_uses_higher_contrast_for_dark_and_light_regions(self):
        light_style = pick_box_style(0, sample_color=(245, 245, 245))
        dark_style = pick_box_style(0, sample_color=(20, 20, 20))

        self.assertLess(
            _luma(light_style["outline"][:3]), _luma(dark_style["outline"][:3])
        )


class DiffCliTests(unittest.TestCase):
    def test_diff_outputs_highlighted_change_map(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            before_path = temp_path / "before.png"
            after_path = temp_path / "after.png"
            diff_path = temp_path / "diff.png"

            _draw_rect(before_path, (40, 40), [])
            _draw_rect(after_path, (40, 40), [(24, 24, 34, 34)])

            result = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPT_PATH),
                    str(before_path),
                    str(after_path),
                    "-o",
                    str(diff_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertIn(f"差异图已保存 {diff_path}", result.stdout)
            self.assertIn("box1:", result.stdout)
            self.assertTrue(diff_path.exists())

            with Image.open(diff_path) as diff_image:
                self.assertEqual(diff_image.size, (40, 40))
                self.assertEqual(diff_image.getpixel((10, 10)), (255, 255, 255, 255))
                red, green, blue, alpha = diff_image.getpixel((28, 28))
                self.assertNotEqual((red, green, blue), (255, 255, 255))
                self.assertEqual(alpha, 255)

    def test_diff_auto_normalizes_mismatched_input_sizes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            before_path = temp_path / "before.png"
            after_path = temp_path / "after.png"
            diff_path = temp_path / "diff.png"

            _draw_rect(before_path, (20, 20), [(5, 5, 14, 14)])
            _draw_rect(after_path, (40, 40), [(15, 15, 24, 24), (28, 28, 34, 34)])

            result = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPT_PATH),
                    str(before_path),
                    str(after_path),
                    "-o",
                    str(diff_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertIn(f"差异图已保存 {diff_path}", result.stdout)
            self.assertIn("box1:", result.stdout)
            self.assertTrue(diff_path.exists())

    def test_diff_supports_fine_granularity(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            before_path = temp_path / "before.png"
            after_path = temp_path / "after.png"
            coarse_path = temp_path / "diff-coarse.png"
            fine_path = temp_path / "diff-fine.png"

            base = Image.new("RGBA", (200, 120), (255, 255, 255, 255))
            changed = base.copy()
            drawer = ImageDraw.Draw(changed)
            drawer.rectangle((12, 12, 58, 38), fill=(255, 220, 220, 255))
            drawer.rectangle((86, 16, 126, 36), fill=(220, 255, 220, 255))
            drawer.rectangle((152, 12, 188, 38), fill=(220, 220, 255, 255))
            base.save(before_path)
            changed.save(after_path)

            coarse = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPT_PATH),
                    str(before_path),
                    str(after_path),
                    "--granularity",
                    "coarse",
                    "-o",
                    str(coarse_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            fine = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPT_PATH),
                    str(before_path),
                    str(after_path),
                    "--granularity",
                    "fine",
                    "-o",
                    str(fine_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )

            coarse_count = coarse.stdout.count("box")
            fine_count = fine.stdout.count("box")
            self.assertGreaterEqual(fine_count, coarse_count)
            self.assertTrue(coarse_path.exists())
            self.assertTrue(fine_path.exists())


if __name__ == "__main__":
    unittest.main()
