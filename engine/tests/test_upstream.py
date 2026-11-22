"""Expose the unchanged upstream software fixtures to stdlib unittest discovery."""
from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path
import unittest


def load_tests(loader, tests, pattern):
    path = Path(__file__).resolve().parent / "upstream" / "test_core.py"
    spec = importlib.util.spec_from_file_location("_hana_upstream_core_tests", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load the vendored core tests")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    functions = [
        function for name, function in inspect.getmembers(module, inspect.isfunction)
        if name.startswith("test_") and function.__module__ == module.__name__
    ]
    if len(functions) != 15 or any(inspect.signature(function).parameters for function in functions):
        raise AssertionError("Expected the pinned 15 zero-argument upstream tests")
    tests.addTests(unittest.FunctionTestCase(function) for function in functions)
    return tests
