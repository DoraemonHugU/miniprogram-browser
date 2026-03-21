import unittest
from pathlib import Path

from tests.image_processing.helpers import load_lib_module


io_utils = load_lib_module("io_utils.py")
derive_output_path = io_utils.derive_output_path


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
