import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from tests.image_processing.helpers import load_lib_module


diffing_lib = load_lib_module("diffing.py")
compute_diff_regions = diffing_lib.compute_diff_regions


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

            sidecar_path = temp_path / "diff.regions.json"

            self.assertEqual(result.stdout.strip(), str(diff_path))
            self.assertTrue(diff_path.exists())
            self.assertTrue(sidecar_path.exists())

            payload = json.loads(sidecar_path.read_text())
            self.assertEqual(payload["imageSize"], {"width": 40, "height": 40})
            self.assertGreaterEqual(len(payload["boxes"]), 1)

            with Image.open(diff_path) as diff_image:
                self.assertEqual(diff_image.size, (40, 40))
                self.assertEqual(diff_image.getpixel((10, 10)), (255, 255, 255, 255))
                self.assertEqual(diff_image.getpixel((28, 28)), (120, 0, 0, 255))

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

            sidecar_path = temp_path / "diff.regions.json"

            self.assertEqual(result.stdout.strip(), str(diff_path))
            self.assertTrue(diff_path.exists())
            payload = json.loads(sidecar_path.read_text())
            self.assertEqual(payload["imageSize"], {"width": 40, "height": 40})
            self.assertGreaterEqual(len(payload["boxes"]), 1)


if __name__ == "__main__":
    unittest.main()
