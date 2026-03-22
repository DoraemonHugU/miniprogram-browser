import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from tests.image_processing.helpers import load_lib_module


layout_lib = load_lib_module("layout.py")
horizontal_montage = layout_lib.horizontal_montage
build_labeled_montage = layout_lib.build_labeled_montage
MONTAGE_PADDING = layout_lib.MONTAGE_PADDING
MONTAGE_GAP = layout_lib.MONTAGE_GAP
LABEL_ROW_HEIGHT = layout_lib.LABEL_ROW_HEIGHT


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

    def test_build_labeled_montage_adds_white_header_and_padding(self):
        left = Image.new("RGBA", (40, 40), (255, 0, 0, 255))
        right = Image.new("RGBA", (40, 40), (0, 255, 0, 255))

        result = build_labeled_montage([left, right], labels=["before", "after"])

        self.assertEqual(
            result.size,
            (
                40 * 2 + MONTAGE_GAP + MONTAGE_PADDING * 2,
                40 + LABEL_ROW_HEIGHT + MONTAGE_PADDING * 2,
            ),
        )
        self.assertEqual(result.getpixel((4, 4)), (255, 255, 255, 255))
        self.assertEqual(
            result.getpixel(
                (MONTAGE_PADDING + 20, MONTAGE_PADDING + LABEL_ROW_HEIGHT + 20)
            ),
            (255, 0, 0, 255),
        )
        self.assertEqual(
            result.getpixel(
                (
                    MONTAGE_PADDING + 40 + MONTAGE_GAP + 20,
                    MONTAGE_PADDING + LABEL_ROW_HEIGHT + 20,
                )
            ),
            (0, 255, 0, 255),
        )


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

            self.assertIn(
                f"拼图已保存 {temp_path / 'before-montage.png'}", result.stdout
            )
            output_path = temp_path / "before-montage.png"
            self.assertEqual(output_path, temp_path / "before-montage.png")
            self.assertTrue(output_path.exists())

            with Image.open(output_path) as montage:
                self.assertEqual(
                    montage.size,
                    (
                        40 * 2 + MONTAGE_GAP + MONTAGE_PADDING * 2,
                        40 + LABEL_ROW_HEIGHT + MONTAGE_PADDING * 2,
                    ),
                )
                self.assertEqual(montage.getpixel((4, 4)), (255, 255, 255, 255))
                self.assertEqual(
                    montage.getpixel(
                        (MONTAGE_PADDING + 20, MONTAGE_PADDING + LABEL_ROW_HEIGHT + 20)
                    ),
                    (255, 0, 0, 255),
                )
                self.assertEqual(
                    montage.getpixel(
                        (
                            MONTAGE_PADDING + 40 + MONTAGE_GAP + 20,
                            MONTAGE_PADDING + LABEL_ROW_HEIGHT + 20,
                        )
                    ),
                    (0, 255, 0, 255),
                )


if __name__ == "__main__":
    unittest.main()
