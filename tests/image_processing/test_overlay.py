import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from tests.image_processing.helpers import load_lib_module


overlaying_lib = load_lib_module("overlaying.py")
color_overlay = overlaying_lib.color_overlay


SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "image-processing"
    / "scripts"
    / "img_overlay.py"
)
PYTHON = sys.executable


def _make_shape(
    path: Path, size: tuple[int, int], rects: list[tuple[int, int, int, int]]
) -> None:
    image = Image.new("RGBA", size, (255, 255, 255, 255))
    drawer = ImageDraw.Draw(image)
    for left, top, right, bottom in rects:
        drawer.rectangle((left, top, right, bottom), fill=(0, 0, 0, 255))
    image.save(path)


class OverlayLibTests(unittest.TestCase):
    def test_color_overlay_distinguishes_before_and_after(self):
        before = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
        after = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
        before_draw = ImageDraw.Draw(before)
        after_draw = ImageDraw.Draw(after)
        before_draw.rectangle((5, 10, 14, 19), fill=(0, 0, 0, 255))
        after_draw.rectangle((25, 10, 34, 19), fill=(0, 0, 0, 255))

        result = color_overlay(before, after)

        self.assertEqual(result.size, (40, 40))
        self.assertEqual(result.getpixel((10, 15)), (255, 0, 0, 255))
        self.assertEqual(result.getpixel((30, 15)), (0, 255, 255, 255))
        self.assertEqual(result.getpixel((20, 20)), (0, 0, 0, 0))


class OverlayCliTests(unittest.TestCase):
    def test_overlay_auto_normalizes_mismatched_input_sizes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            before_path = temp_path / "before.png"
            after_path = temp_path / "after.png"

            _make_shape(before_path, (20, 20), [(5, 5, 14, 14)])
            _make_shape(after_path, (40, 40), [(15, 15, 24, 24), (28, 28, 34, 34)])

            result = subprocess.run(
                [PYTHON, str(SCRIPT_PATH), str(before_path), str(after_path)],
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertIn(
                f"叠加图已保存 {temp_path / 'before-overlay.png'}", result.stdout
            )
            output_path = temp_path / "before-overlay.png"
            self.assertEqual(output_path, temp_path / "before-overlay.png")
            self.assertTrue(output_path.exists())

            with Image.open(output_path) as overlay:
                self.assertEqual(overlay.size, (40, 40))
                self.assertEqual(overlay.getpixel((20, 20)), (255, 255, 255, 255))
                self.assertEqual(overlay.getpixel((31, 31)), (0, 255, 255, 255))


if __name__ == "__main__":
    unittest.main()
