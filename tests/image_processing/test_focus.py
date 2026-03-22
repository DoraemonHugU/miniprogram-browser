import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from tests.image_processing.helpers import load_lib_module


focus_lib = load_lib_module("focus.py")
build_focus_image = focus_lib.build_focus_image


SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "image-processing"
    / "scripts"
    / "img_focus.py"
)
PYTHON = sys.executable


def _make_images(before_path: Path, after_path: Path) -> None:
    before = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
    after = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
    ImageDraw.Draw(after).rectangle((24, 24, 34, 34), fill=(0, 0, 0, 255))
    before.save(before_path)
    after.save(after_path)


class FocusLibTests(unittest.TestCase):
    def test_build_focus_image_crops_single_box_from_any_image(self):
        source = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
        ImageDraw.Draw(source).rectangle((24, 24, 34, 34), fill=(0, 0, 0, 255))

        result = build_focus_image(source, {"x": 24, "y": 24, "w": 11, "h": 11})

        self.assertGreaterEqual(result.width, 128)
        self.assertGreaterEqual(result.height, 128)
        self.assertEqual(result.width, result.height)
        self.assertEqual(result.getpixel((5, 5)), (0, 0, 0, 255))


class FocusCliTests(unittest.TestCase):
    def test_img_focus_outputs_single_cropped_image_from_explicit_box(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            input_path = temp_path / "after.png"
            output_path = temp_path / "focus.png"

            image = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
            ImageDraw.Draw(image).rectangle((24, 24, 34, 34), fill=(0, 0, 0, 255))
            image.save(input_path)

            result = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPT_PATH),
                    str(input_path),
                    "--box",
                    "24,24,11,11",
                    "-o",
                    str(output_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertIn(f"裁剪图已保存 {output_path}", result.stdout)
            self.assertTrue(output_path.exists())

            with Image.open(output_path) as focus:
                self.assertGreaterEqual(focus.width, 128)
                self.assertGreaterEqual(focus.height, 128)
                self.assertEqual(focus.width, focus.height)
                self.assertEqual(focus.getpixel((10, 10)), (0, 0, 0, 255))


if __name__ == "__main__":
    unittest.main()
