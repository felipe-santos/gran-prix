"""Tests of bootstrap_ref.py. Run: PYTHONPATH=tools/baselines/.pylibs python3 -m unittest discover -s tools/baselines/stats -p 'test_*.py'
(the TS suite of packages/stats also regenerates both fixtures from these modules and compares the bytes)."""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import numpy as np  # noqa: E402

import bootstrap_ref as ref  # noqa: E402


class CanonicalOrder(unittest.TestCase):
    def test_stratified_pools_are_strata_in_order_then_keys(self):
        units = [("b", "k2"), ("a", "k9"), ("b", "k1"), ("a", "k3")]
        self.assertEqual(ref.canonical_pools(units, True), [[3, 1], [2, 0]])

    def test_flat_is_one_pool_by_key_then_stratum(self):
        units = [("b", "k2"), ("a", "k9"), ("b", "k1"), ("a", "k3")]
        self.assertEqual(ref.canonical_pools(units, False), [[2, 0, 3, 1]])

    def test_empty_and_duplicates(self):
        self.assertEqual(ref.canonical_pools([], True), [])
        self.assertEqual(ref.canonical_pools([], False), [])
        with self.assertRaises(ValueError):
            ref.canonical_pools([("a", "k"), ("a", "k")], True)

    def test_code_point_order(self):
        # U+FF5E is one UTF-16 unit above the surrogates, U+1F600 is a surrogate pair: code points say FF5E < 1F600
        units = [("\U0001f600", "x"), ("～", "x")]
        self.assertEqual(ref.canonical_pools(units, True), [[1], [0]])


class Draws(unittest.TestCase):
    def test_one_integers_call_per_pool_and_replicate(self):
        pools = [[3, 1], [2, 0, 4]]
        rng = np.random.default_rng(5)
        got = [ref.draw_indices(pools, rng) for _ in range(4)]
        rng = np.random.default_rng(5)
        want = [[[int(v) for v in rng.integers(0, 2, size=2)], [int(v) for v in rng.integers(0, 3, size=3)]] for _ in range(4)]
        self.assertEqual(got, want)

    def test_counts_sum_to_pool_sizes(self):
        pools = [[3, 1], [2, 0, 4]]
        picks = ref.draw_indices(pools, np.random.default_rng(1))
        c = ref.counts_of(pools, picks, 5)
        self.assertEqual(c[3] + c[1], 2.0)
        self.assertEqual(c[2] + c[0] + c[4], 3.0)

    def test_mean_draws_are_a_function_of_the_seed(self):
        v, k = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0], ["a", "a", "b", "b", "c", "d"]
        a = ref.cluster_mean_draws(v, k, None, 50, 9, False)
        self.assertEqual(a, ref.cluster_mean_draws(v, k, None, 50, 9, False))
        self.assertNotEqual(a, ref.cluster_mean_draws(v, k, None, 50, 10, False))
        self.assertTrue(all(1.0 <= x <= 6.0 for x in a))


class Interval(unittest.TestCase):
    def test_quantiles_of_the_levels(self):
        self.assertEqual(ref.ci_quantiles(0.95), (0.025, 0.975))
        self.assertEqual(ref.ci_quantiles(0.8), (0.1, 0.9))

    def test_linear_interval_and_refusal(self):
        self.assertEqual(ref.quantile_ci([1, 2, 3, 4, 5], 5, 0.5), [2.0, 4.0])
        self.assertIsNone(ref.quantile_ci([math.nan, math.nan, math.nan, 1.0], 4))
        self.assertEqual(ref.quantile_ci([math.nan, 1, 2, 3], 4, 0.5), [1.5, 2.5])


if __name__ == "__main__":
    unittest.main()
