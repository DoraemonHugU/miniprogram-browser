import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from tests.image_processing.helpers import load_lib_module


focus_lib = load_lib_module("focus.py")
build_focus_sheet = focus_lib.build_focus_sheet


SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "image-processing"
    / "scripts"
    / "img_focus_crops.py"
)
PYTHON = sys.executable


def _make_images(before_path: Path, after_path: Path) -> None:
    before = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
    after = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
    ImageDraw.Draw(after).rectangle((24, 24, 34, 34), fill=(0, 0, 0, 255))
    before.save(before_path)
    after.save(after_path)


class FocusLibTests(unittest.TestCase):
    def test_build_focus_sheet_outputs_comparison_sheet(self):
        before = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
        after = Image.new("RGBA", (40, 40), (255, 255, 255, 255))
        ImageDraw.Draw(after).rectangle((24, 24, 34, 34), fill=(0, 0, 0, 255))

        result = build_focus_sheet(
            before,
            after,
            [{"x": 24, "y": 24, "w": 11, "h": 11}],
        )

        self.assertGreater(result.width, result.height)
        self.assertEqual(result.getpixel((80, 20)), (120, 0, 0, 255))


class FocusCliTests(unittest.TestCase):
    def test_focus_crops_outputs_top_changed_regions_sheet(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            before_path = temp_path / "before.png"
            after_path = temp_path / "after.png"
            regions_path = temp_path / "diff.regions.json"
            output_path = temp_path / "focus.png"

            _make_images(before_path, after_path)
            regions_path.write_text(
                json.dumps(
                    {
                        "imageSize": {"width": 40, "height": 40},
                        "boxes": [{"x": 24, "y": 24, "w": 11, "h": 11}],
                    }
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPT_PATH),
                    str(before_path),
                    str(after_path),
                    "--regions",
                    str(regions_path),
                    "-o",
                    str(output_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertEqual(result.stdout.strip(), str(output_path))
            self.assertTrue(output_path.exists())

            with Image.open(output_path) as focus:
                self.assertGreater(focus.width, focus.height)

    def test_focus_crops_can_recompute_regions_without_sidecar(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            before_path = temp_path / "before.png"
            after_path = temp_path / "after.png"
            output_path = temp_path / "focus.png"

            _make_images(before_path, after_path)

            result = subprocess.run(
                [
                    PYTHON,
                    str(SCRIPT_PATH),
                    str(before_path),
                    str(after_path),
                    "-o",
                    str(output_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertEqual(result.stdout.strip(), str(output_path))
            self.assertTrue(output_path.exists())


if __name__ == "__main__":
    unittest.main()
