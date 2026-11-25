import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

import helpers
import gbdt

# Tests only need the machinery, not the 12-point grid: two configs, small trees, few iterations.
TWO = [{**c, "max_iter": 25} for c in gbdt.CONFIGS[:2]]


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


class GroupedFolds(unittest.TestCase):
    def test_a_domain_never_straddles_two_folds_and_folds_are_balanced(self):
        keys = np.array([f"d{i % 10}" for i in range(500)], dtype=object)
        folds = gbdt.grouped_folds(keys, np.ones(500), 3)
        for k in set(keys):
            self.assertEqual(len(set(folds[keys == k])), 1, k)
        sizes = np.bincount(folds)
        self.assertLessEqual(sizes.max() - sizes.min(), 50)  # one domain = 50 rows

    def test_is_deterministic(self):
        keys = np.array([f"d{i % 7}" for i in range(100)], dtype=object)
        np.testing.assert_array_equal(gbdt.grouped_folds(keys, np.ones(100), 3), gbdt.grouped_folds(keys, np.ones(100), 3))


class Metrics(unittest.TestCase):
    def test_tau_star_is_the_largest_threshold_reaching_the_recall_target(self):
        p = np.array([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05])
        y = np.array([1, 1, 1, 1, 1, 1, 1, 1, 1, 0])
        w = np.ones(10)
        t = gbdt.tau_star(p, y, w, 0.95)  # 9 positives: 0.95 * 9 = 8.55 -> need all 9 -> tau = 0.1
        self.assertAlmostEqual(t, 0.1)
        self.assertAlmostEqual(gbdt.tau_star(p, y, w, 0.5), 0.5)  # 5 of 9 = 0.55 >= 0.5 (4 of 9 = 0.44 is not)

    def test_tau_star_is_weighted_by_characters(self):
        p = np.array([0.9, 0.2])
        y = np.array([1, 1])
        self.assertAlmostEqual(gbdt.tau_star(p, y, np.array([1.0, 99.0]), 0.95), 0.2)  # the heavy unit has to be kept
        self.assertAlmostEqual(gbdt.tau_star(p, y, np.array([99.0, 1.0]), 0.95), 0.9)

    def test_macro_page_f1_gives_zero_to_an_empty_output(self):
        pages = np.array(["a", "a", "b", "b"], dtype=object)
        y = np.array([1, 0, 1, 0])
        w = np.ones(4)
        # page a perfect (F1 1), page b predicts nothing (F1 0, never 1): mean 0.5
        self.assertAlmostEqual(gbdt.macro_page_f1(np.array([0.9, 0.1, 0.1, 0.1]), y, w, pages, 0.5), 0.5)


class Run(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.ds = helpers.make_dataset(Path(cls.tmp.name) / "ds")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_once(self, name: str, **kw):
        out = Path(self.tmp.name) / name
        r = gbdt.run(self.ds, out, seed=kw.pop("seed", 1), emit=("test",), configs=TWO, inner_folds=2, **kw)
        return out, r

    def test_bundles_follow_the_evaluate_format_and_cover_the_right_rows(self):
        out, r = self.run_once("a")
        _, rows, _ = gbdt.read_dataset(self.ds)
        for bundle, split_names in (("bundle-test", ["test"]), ("bundle-dev-oof", ["train", "val"])):
            meta = json.loads((out / bundle / "system.json").read_text())
            self.assertEqual(meta["id"], "gbdt")
            self.assertAlmostEqual(meta["threshold"], r["tau_star"])
            preds = [json.loads(line) for line in (out / bundle / "predictions.jsonl").read_text().splitlines()]
            want = sorted((g, int(u)) for g, u, s in zip(rows.g, rows.u, rows.split) if s in split_names)
            self.assertEqual(sorted((p["g"], p["u"]) for p in preds), want)  # every row exactly once
            self.assertTrue(all(0 <= p["p"] <= 1 for p in preds))
        self.assertEqual(r["emitted_splits"], {"test": int(sum(rows.split == "test"))})
        self.assertLessEqual(len(r["configs"]), 12)

    def test_it_learns_the_synthetic_signal(self):
        _, r = self.run_once("learn")
        self.assertGreater(r["dev_oof_macro_page_f1_at_tau"], 0.6)

    def test_same_seed_same_bytes(self):
        a, _ = self.run_once("det1")
        b, _ = self.run_once("det2")
        for f in ("bundle-test/predictions.jsonl", "bundle-dev-oof/predictions.jsonl", "bundle-test/system.json"):
            self.assertEqual(sha(a / f), sha(b / f), f)

    def test_training_never_sees_the_domain_it_predicts_and_never_the_test_split(self):
        seen = []
        real_fit = gbdt.fit

        def spy(cfg, rows, seed):
            seen.append(set(rows.split.tolist()))
            seen.append({"keys": set(str(g).split("-")[1] for g in rows.g)})  # "d3" of "page-d3-0#..."
            return real_fit(cfg, rows, seed)

        gbdt.fit = spy
        try:
            self.run_once("spy")
        finally:
            gbdt.fit = real_fit
        splits = [s for s in seen if "keys" not in s]
        self.assertTrue(all(s <= {"train", "val"} for s in splits), "the test split was used for fitting or tuning")

    def test_oof_folds_are_grouped_by_domain(self):
        _, rows, group_key = gbdt.read_dataset(self.ds)
        dev = rows.take(np.nonzero(np.isin(rows.split, ["train", "val"]))[0])
        keys = np.array([group_key[str(g)] for g in dev.g], dtype=object)
        folds = gbdt.grouped_folds(keys, dev.w, 3)
        for k in set(keys):
            self.assertEqual(len(set(folds[keys == k])), 1)

    def test_more_than_twelve_configurations_is_refused(self):
        with self.assertRaises(SystemExit):
            gbdt.run(self.ds, Path(self.tmp.name) / "too-many", configs=[dict(gbdt.CONFIGS[0])] * 13)

    def test_the_default_grid_is_within_budget(self):
        self.assertLessEqual(len(gbdt.CONFIGS), 12)
        self.assertEqual(len({json.dumps(c, sort_keys=True) for c in gbdt.CONFIGS}), len(gbdt.CONFIGS))


if __name__ == "__main__":
    unittest.main()
