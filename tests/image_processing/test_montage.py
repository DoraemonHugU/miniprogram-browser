import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from tests.image_processing.helpers import load_lib_module


layout_lib = load_lib_module("layout.py")
horizontal_montage = layout_lib.horizontal_montage


SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "image-processing"
    / "scripts"
    / "img_montage.py"
)


class MontageLayoutTests(unittest.TestCase):
    def test_horizontal_montage_stitches_images_horizontally(self):
        left = Image.new("RGBA", (40, 40), (255, 0, 0, 255))
        right = Image.new("RGBA", (40, 40), (0, 255, 0, 255))

        result = horizontal_montage([left, right])

        self.assertEqual(result.size, (80, 40))
        self.assertEqual(result.getpixel((20, 20)), (255, 0, 0, 255))
        self.assertEqual(result.getpixel((60, 20)), (0, 255, 0, 255))


class MontageCliTests(unittest.TestCase):
    def test_img_montage_auto_normalizes_mismatched_input_sizes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            before_path = temp_path / "before.png"
            after_path = temp_path / "after.png"

            Image.new("RGBA", (20, 40), (255, 0, 0, 255)).save(before_path)
            Image.new("RGBA", (40, 20), (0, 255, 0, 255)).save(after_path)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    str(before_path),
                    str(after_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )

            output_path = Path(result.stdout.strip())

            self.assertEqual(output_path, temp_path / "before-montage.png")
            self.assertTrue(output_path.exists())

            with Image.open(output_path) as montage:
                self.assertEqual(montage.size, (80, 40))
                self.assertEqual(montage.getpixel((20, 20)), (255, 0, 0, 255))
                self.assertEqual(montage.getpixel((60, 20)), (0, 255, 0, 255))
                self.assertEqual(montage.getpixel((0, 0)), (0, 0, 0, 0))
                self.assertEqual(montage.getpixel((79, 0)), (0, 0, 0, 0))


if __name__ == "__main__":
    unittest.main()
