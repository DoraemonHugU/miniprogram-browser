import unittest
from pathlib import Path

from tests.image_processing.helpers import load_lib_module


io_utils = load_lib_module("io_utils.py")
derive_output_path = io_utils.derive_output_path


class OutputPathTests(unittest.TestCase):
    def test_derive_output_path_uses_suffix_when_output_missing(self):
        result = derive_output_path(Path("/tmp/before.png"), suffix="-normalized")
        self.assertTrue(str(result).endswith("before-normalized.png"))
