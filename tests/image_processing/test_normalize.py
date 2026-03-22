import unittest
from pathlib import Path

from PIL import Image

from tests.image_processing.helpers import load_lib_module


io_utils = load_lib_module("io_utils.py")
normalize_lib = load_lib_module("normalize.py")

derive_output_path = io_utils.derive_output_path
normalize_image = normalize_lib.normalize_image


PUBLIC_SCRIPT_PATH = (
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


class NormalizeSurfaceTests(unittest.TestCase):
    def test_normalize_is_internal_only(self):
        self.assertFalse(PUBLIC_SCRIPT_PATH.exists())


if __name__ == "__main__":
    unittest.main()
