import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from tests.image_processing.helpers import load_lib_module


io_utils = load_lib_module("io_utils.py")
normalize_lib = load_lib_module("normalize.py")

derive_output_path = io_utils.derive_output_path
normalize_image = normalize_lib.normalize_image


SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "image-processing"
    / "scripts"
    / "img_normalize.py"
)


class OutputPathTests(unittest.TestCase):
    def test_derive_output_path_uses_suffix_when_output_missing(self):
        result = derive_output_path(Path("/tmp/before.png"), suffix="-normalized")
        self.assertEqual(result, Path("/tmp/before-normalized.png"))

    def test_derive_output_path_uses_explicit_output_override(self):
        result = derive_output_path(
            Path("/tmp/before.png"),
            suffix="-normalized",
            output="/tmp/custom/result.png",
        )
        self.assertEqual(result, Path("/tmp/custom/result.png"))


class NormalizeImageTests(unittest.TestCase):
    def test_normalize_image_pads_to_explicit_canvas_size(self):
        source = Image.new("RGBA", (80, 40), (255, 0, 0, 255))

        result = normalize_image(source, size=(100, 100), mode="pad")

        self.assertEqual(result.size, (100, 100))
        self.assertEqual(result.getpixel((50, 50)), (255, 0, 0, 255))
        self.assertEqual(result.getpixel((0, 0)), (0, 0, 0, 0))


class NormalizeCliTests(unittest.TestCase):
    def test_img_normalize_supports_explicit_fit_mode(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            input_path = temp_path / "source.png"
            Image.new("RGBA", (80, 40), (0, 128, 255, 255)).save(input_path)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    str(input_path),
                    "--size",
                    "100x100",
                    "--mode",
                    "fit",
                ],
                capture_output=True,
                text=True,
                check=True,
            )

            output_path = Path(result.stdout.strip())

            self.assertEqual(output_path, temp_path / "source-normalized.png")
            self.assertTrue(output_path.exists())

            with Image.open(output_path) as normalized:
                self.assertEqual(normalized.size, (100, 100))
                self.assertEqual(normalized.getpixel((0, 0)), (0, 128, 255, 255))


if __name__ == "__main__":
    unittest.main()
