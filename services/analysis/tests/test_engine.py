import unittest
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import _swings, _supply_demand, analyze, run_backtest, validate_candles


def candles_from_closes(closes):
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    result = []
    for index, close in enumerate(closes):
        center = float(close)
        result.append({"time": (start + timedelta(minutes=15 * index)).isoformat().replace("+00:00", "Z"), "open": center - 0.2, "high": center + 0.5, "low": center - 0.5, "close": center, "volume": 1})
    return result


class AnalysisEngineTests(unittest.TestCase):
    def test_insufficient_data_is_explicit(self):
        result = analyze(candles_from_closes(range(10)))
        self.assertEqual(result["status"], "insufficient_data")
        self.assertIn("Insufficient data", result["message"])

    def test_bad_or_duplicate_times_are_rejected(self):
        rows = candles_from_closes(range(24))
        rows[2]["time"] = rows[1]["time"]
        with self.assertRaisesRegex(ValueError, "unique"):
            validate_candles(rows)

    def test_pivots_are_only_reported_after_confirmation(self):
        closes = [10, 11, 12, 13, 14, 15, 16, 14, 13, 12, 11, 10, 9, 10, 11, 12, 13, 14, 15, 16, 15, 14, 13, 12, 11, 10, 9, 8, 9, 10]
        result = analyze(candles_from_closes(closes))
        self.assertEqual(result["status"], "ok")
        for swing in result["swings"]:
            self.assertGreaterEqual(swing["confirmedAt"], swing["time"])
            self.assertNotIn("index", swing)

    def test_analysis_has_rule_ids_and_provisional_breaks_are_separate(self):
        closes = [10, 11, 12, 13, 14, 13, 12, 11, 10, 9, 8, 9, 10, 11, 12, 13, 14, 15, 14, 13, 12, 11, 10, 9, 8, 9, 10, 11, 12, 13]
        result = analyze(candles_from_closes(closes))
        self.assertEqual(result["status"], "ok")
        self.assertIn("volatility", result)
        self.assertIn("provisionalWickPenetrations", result)
        self.assertTrue(all("ruleId" in event for event in result["structure"]))

    def test_swing_is_not_available_until_three_right_bars_exist(self):
        rows = candles_from_closes([100] * 24)
        rows[4].update({"high": 105, "open": 100, "close": 100})
        early, _ = _swings(rows[:7])
        complete, _ = _swings(rows[:8])
        self.assertFalse(any(swing["time"] == rows[4]["time"] for swing in early))
        confirmed = next(swing for swing in complete if swing["time"] == rows[4]["time"])
        self.assertEqual(confirmed["confirmedAt"], rows[7]["time"])

    def test_wick_penetration_does_not_count_as_structure_break(self):
        rows = candles_from_closes([100] * 30)
        rows[4].update({"high": 105, "open": 100, "close": 100})
        rows[8].update({"high": 106, "open": 100, "close": 100})
        result = analyze(rows)
        self.assertTrue(any(event["level"] == 105 and event["type"] == "WICK_PENETRATION" for event in result["provisionalWickPenetrations"]))
        self.assertFalse(any(event["level"] == 105 for event in result["structure"]))

    def test_structure_break_requires_candle_close_beyond_confirmed_level(self):
        rows = candles_from_closes([100] * 30)
        rows[4].update({"high": 105, "open": 100, "close": 100})
        rows[8].update({"high": 107, "open": 104, "low": 103, "close": 106})
        result = analyze(rows)
        event = next(event for event in result["structure"] if event["level"] == 105)
        self.assertEqual(event["type"], "BOS")
        self.assertTrue(event["confirmed"])
        self.assertEqual(event["time"], rows[8]["time"])

    def test_supply_demand_zone_requires_base_and_closed_displacement(self):
        rows = candles_from_closes([100, 100, 100, 101, 102, 103])
        rows[0].update({"open": 99.8, "high": 100, "low": 99.5, "close": 99.8})
        rows[1].update({"open": 99.8, "high": 100, "low": 99.5, "close": 99.8})
        rows[2].update({"open": 99.8, "high": 100, "low": 99.5, "close": 99.8})
        rows[3].update({"open": 100, "high": 102, "low": 99.9, "close": 101.9})
        rows[4].update({"open": 101.9, "high": 102.2, "low": 101.7, "close": 102.1})
        zones = _supply_demand(rows, 1.0)
        self.assertEqual(zones[0]["type"], "demand")
        self.assertEqual(zones[0]["status"], "untested")
        self.assertEqual(zones[0]["ruleId"], "base-displacement-15atr-body60-v1")

    def test_backtest_uses_next_open_and_chronological_holdout(self):
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        rows = []
        for index in range(120):
            close = 100 + index * 0.3 if index >= 30 else 100 + (index % 4) * 0.1
            open_price = close - 0.1
            rows.append({"time": (start + timedelta(minutes=15 * index)).isoformat().replace("+00:00", "Z"), "open": open_price, "high": close + 0.2, "low": open_price - 0.2, "close": close, "volume": 1})
        result = run_backtest(rows, "breakout", spread_price=0.05)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["sourceRange"]["candles"], 120)
        self.assertLess(result["sourceRange"]["splitAt"], result["sourceRange"]["to"])
        self.assertTrue(result["trades"])
        self.assertGreaterEqual(result["trades"][0]["entryAt"], result["sourceRange"]["splitAt"])
        self.assertIn("conservatively assumed first", " ".join(result["limitations"]))


if __name__ == "__main__":
    unittest.main()
