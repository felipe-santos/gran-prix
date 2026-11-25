import hashlib
import unittest

import helpers  # noqa: F401  (path setup)
import bow
import sample
import traf_sidecar


class Sampling(unittest.TestCase):
    URLS = {f"{i:04d}": f"https://site{i}.example/page/{i}" for i in range(1, 60)}

    def test_order_is_ascending_sha256_of_seed_prefix_plus_url(self):
        want = sorted(self.URLS, key=lambda i: (hashlib.sha256(("gp-dom-v0|20261125|" + self.URLS[i]).encode()).hexdigest(), i))
        self.assertEqual(sample.sample_ids(self.URLS, 10), want[:10])

    def test_prefix_stability_and_independence_from_input_order(self):
        a = sample.sample_ids(self.URLS, 20)
        shuffled = dict(reversed(list(self.URLS.items())))
        self.assertEqual(sample.sample_ids(shuffled, 20), a)
        self.assertEqual(sample.sample_ids(self.URLS, 5), a[:5])

    def test_known_hash(self):
        self.assertEqual(sample.url_hash("https://example.com/"), hashlib.sha256(b"gp-dom-v0|20261125|https://example.com/").hexdigest())


class Metric(unittest.TestCase):
    def test_tokens_are_lowercase_letters_and_digits(self):
        self.assertEqual(bow.tokens("Hello, WORLD_42! café 3.14"), ["hello", "world", "42", "café", "3", "14"])
        self.assertEqual(bow.tokens_wcxb("a_b"), ["a_b"])  # the WCXB script keeps underscores inside a token

    def test_f1_is_a_multiset_f1(self):
        self.assertAlmostEqual(bow.bow_f1("a a b", "a b b"), 2 / 3)  # overlap 2 of 3 tokens each side
        self.assertEqual(bow.bow_f1("x y", "a b"), 0.0)
        self.assertEqual(bow.bow_f1("a b c", "a b c"), 1.0)

    def test_empty_output_scores_zero_never_one(self):
        self.assertEqual(bow.bow_f1("", "a b"), 0.0)
        self.assertEqual(bow.bow_f1(None, "a b"), 0.0)

    def test_bootstrap_is_deterministic_and_brackets_the_mean(self):
        vals = [0.2, 0.5, 0.9, 0.7, 0.4, 0.8, 0.6, 0.3]
        a, b = bow.bootstrap_mean_ci(vals, resamples=2000), bow.bootstrap_mean_ci(vals, resamples=2000)
        self.assertEqual(a, b)
        self.assertLess(a["ci_lo"], a["mean"])
        self.assertGreater(a["ci_hi"], a["mean"])
        self.assertEqual((a["seed"], a["n"]), (20261125, 8))


class SidecarOptions(unittest.TestCase):
    def test_defaults_and_modes(self):
        o = traf_sidecar.effective_options(None)
        self.assertEqual(o["mode"], "default")
        self.assertTrue(o["include_tables"] and o["include_comments"])
        self.assertEqual(traf_sidecar.kwargs_of(traf_sidecar.effective_options({"mode": "recall"}))["favor_recall"], True)
        self.assertEqual(traf_sidecar.kwargs_of(traf_sidecar.effective_options({"mode": "precision"}))["favor_precision"], True)
        self.assertNotIn("favor_recall", traf_sidecar.kwargs_of(o))

    def test_unknown_options_and_modes_are_refused(self):
        with self.assertRaises(ValueError):
            traf_sidecar.effective_options({"mode": "fast"})
        with self.assertRaises(ValueError):
            traf_sidecar.effective_options({"nonsense": True})


if __name__ == "__main__":
    unittest.main()
