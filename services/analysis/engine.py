"""Deterministic, inspectable candle analysis. All times are UTC ISO-8601."""
from __future__ import annotations

from datetime import datetime, timezone
from math import isfinite
from statistics import mean
from zoneinfo import ZoneInfo

ENGINE_VERSION = "0.1.0"
RULES = {
    "swing": "A swing high/low is strictly higher/lower than the configured 3 bars on each side; it is published only after the three right-side bars close.",
    "break": "A confirmed break requires a candle close across the latest confirmed swing. A wick-only penetration is provisional and is never counted as BOS/CHoCH.",
    "bias": "Bullish/bearish structure needs the last two confirmed highs and lows to progress in the same direction; otherwise context is mixed/ranging.",
    "zones": "Confirmed pivots within 0.5 times the 14-bar ATR are clustered. Strength is the number of distinct pivot reactions; 3+ is major, 2 is minor.",
    "supplyDemand": "A base of up to three small-range candles followed by a closed displacement candle at least 1.5 ATR with a body at least 60% of its range creates a candidate. Later overlap is a retest; a close through the distal edge invalidates it.",
    "liquidity": "Previous period and equal-pivot levels are references, not orders. A potential sweep requires a wick beyond the reference and a close back across it on the same candle.",
    "sessions": "Asia uses 00:00–08:00 Singapore time; London and New York use 08:00–17:00 in Europe/London and America/New_York. IANA zones handle daylight-saving transitions. These are configurable defaults, not exchange-defined boundaries.",
    "volatility": "Expansion/contraction compares mean true range over the last 5 bars with the preceding 20 bars; ratios above 1.25 expand, below 0.8 contract.",
}


def _time(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")
    text = str(value)
    if text.endswith("Z"):
        return text
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("Candle timestamps must include a UTC offset")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_candles(candles):
    if not isinstance(candles, list):
        raise ValueError("candles must be a list")
    normalized = []
    previous = None
    for item in candles:
        t = _time(item["time"])
        bar = {"time": t, **{key: float(item[key]) for key in ("open", "high", "low", "close")}}
        bar["volume"] = float(item.get("volume", 0) or 0)
        if not all(isfinite(bar[key]) for key in ("open", "high", "low", "close", "volume")):
            raise ValueError(f"Non-finite OHLCV value at {t}")
        if bar["low"] > min(bar["open"], bar["close"]) or bar["high"] < max(bar["open"], bar["close"]) or bar["low"] > bar["high"]:
            raise ValueError(f"Invalid OHLC bounds at {t}")
        if previous is not None and t <= previous:
            raise ValueError("Candles must be unique and strictly ascending by UTC timestamp")
        previous = t
        normalized.append(bar)
    return normalized


def _true_ranges(bars):
    values = []
    for i, bar in enumerate(bars):
        prior = bars[i - 1]["close"] if i else bar["close"]
        values.append(max(bar["high"] - bar["low"], abs(bar["high"] - prior), abs(bar["low"] - prior)))
    return values


def _swings(bars, left=3, right=3):
    highs, lows = [], []
    for i in range(left, len(bars) - right):
        window = bars[i - left:i + right + 1]
        high, low = bars[i]["high"], bars[i]["low"]
        if all(high > b["high"] for j, b in enumerate(window) if j != left):
            highs.append({"kind": "swing_high", "index": i, "confirm_index": i + right, "time": bars[i]["time"], "confirmedAt": bars[i + right]["time"], "price": high})
        if all(low < b["low"] for j, b in enumerate(window) if j != left):
            lows.append({"kind": "swing_low", "index": i, "confirm_index": i + right, "time": bars[i]["time"], "confirmedAt": bars[i + right]["time"], "price": low})
    for items, key in ((highs, "high"), (lows, "low")):
        prior = None
        for pivot in items:
            if prior is not None:
                pivot["label"] = ("HH" if pivot["price"] > prior else "LH") if key == "high" else ("HL" if pivot["price"] > prior else "LL")
            else:
                pivot["label"] = "H" if key == "high" else "L"
            prior = pivot["price"]
    return highs, lows


def _structure_breaks(bars, highs, lows):
    highs_by_confirmation = {}
    lows_by_confirmation = {}
    for pivot in highs:
        highs_by_confirmation.setdefault(pivot["confirm_index"], []).append(pivot)
    for pivot in lows:
        lows_by_confirmation.setdefault(pivot["confirm_index"], []).append(pivot)
    active_high = active_low = None
    broken = set()
    bias = "unknown"
    events = []
    for i in range(1, len(bars)):
        # Strictly less than i: the pivot must have been confirmed before this bar begins.
        for confirm_i, pivots in highs_by_confirmation.items():
            if confirm_i == i - 1:
                active_high = pivots[-1]
        for confirm_i, pivots in lows_by_confirmation.items():
            if confirm_i == i - 1:
                active_low = pivots[-1]
        current, prior = bars[i], bars[i - 1]
        for pivot, side in ((active_high, "up"), (active_low, "down")):
            if pivot is None or pivot["time"] in broken:
                continue
            level = pivot["price"]
            penetrated = current["high"] > level if side == "up" else current["low"] < level
            closed = current["close"] > level if side == "up" else current["close"] < level
            previously_closed = prior["close"] > level if side == "up" else prior["close"] < level
            if penetrated and not closed and not previously_closed:
                events.append({"type": "WICK_PENETRATION", "direction": side, "level": level, "time": current["time"], "referenceSwingTime": pivot["time"], "confirmed": False, "ruleId": "close-confirmed-structure-v1"})
            if closed and not previously_closed:
                kind = "CHOCH" if (bias == "bearish" and side == "up") or (bias == "bullish" and side == "down") else "BOS"
                events.append({"type": kind, "direction": side, "level": level, "time": current["time"], "referenceSwingTime": pivot["time"], "confirmed": True, "ruleId": "close-confirmed-structure-v1"})
                broken.add(pivot["time"])
                bias = "bullish" if side == "up" else "bearish"
    return events


def _zones(pivots, side, atr):
    if not pivots or not atr:
        return []
    tolerance = max(atr * 0.5, 0.01)
    groups = []
    for pivot in sorted(pivots[-40:], key=lambda item: item["price"]):
        if groups and pivot["price"] - mean(p["price"] for p in groups[-1]) <= tolerance:
            groups[-1].append(pivot)
        else:
            groups.append([pivot])
    zones = []
    for group in groups:
        center = mean(p["price"] for p in group)
        pad = tolerance * 0.25
        zones.append({
            "type": side, "low": round(min(p["price"] for p in group) - pad, 5),
            "high": round(max(p["price"] for p in group) + pad, 5), "mid": round(center, 5),
            "tests": len(group), "strength": "major" if len(group) >= 3 else "minor",
            "createdAt": group[0]["time"], "lastTestAt": group[-1]["confirmedAt"],
            "ruleId": "confirmed-pivot-cluster-v1", "invalidation": "A candle close through the far edge weakens this zone; repeated closes beyond it invalidate this interpretation.",
        })
    return sorted(zones, key=lambda zone: zone["mid"])


def _date_group(value, mode):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    if mode == "week":
        iso = parsed.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    if mode == "month":
        return parsed.strftime("%Y-%m")
    return parsed.date().isoformat()


def _period_reference(bars, mode):
    grouped = {}
    for bar in bars:
        grouped.setdefault(_date_group(bar["time"], mode), []).append(bar)
    keys = list(grouped)
    if not keys:
        return None
    last = datetime.fromisoformat(bars[-1]["time"].replace("Z", "+00:00")).astimezone(timezone.utc)
    now = datetime.now(timezone.utc)
    if mode == "day":
        index = len(keys) - 2 if last.date() == now.date() else len(keys) - 1
    elif mode == "week":
        last_key, now_key = _date_group(bars[-1]["time"], mode), _date_group(now.isoformat(), mode)
        index = len(keys) - 2 if last_key == now_key else len(keys) - 1
    elif mode == "month":
        last_key, now_key = _date_group(bars[-1]["time"], mode), _date_group(now.isoformat(), mode)
        index = len(keys) - 2 if last_key == now_key else len(keys) - 1
    else:
        index = len(keys) - 2
    if index < 0:
        return None
    key = keys[index]
    rows = grouped[key]
    return {"period": key, "high": max(row["high"] for row in rows), "low": min(row["low"] for row in rows), "open": rows[0]["open"], "close": rows[-1]["close"], "from": rows[0]["time"], "to": rows[-1]["time"], "ruleId": f"previous-{mode}-ohlc-v1"}


def _session_ranges(bars):
    definitions = {
        "asia": ("Asia/Singapore", 0, 8),
        "london": ("Europe/London", 8, 17),
        "new_york": ("America/New_York", 8, 17),
    }
    ranges = []
    for name, (zone_name, start_hour, end_hour) in definitions.items():
        zone = ZoneInfo(zone_name)
        groups = {}
        for bar in bars[-2000:]:
            stamp = datetime.fromisoformat(bar["time"].replace("Z", "+00:00")).astimezone(zone)
            if start_hour <= stamp.hour < end_hour:
                groups.setdefault(stamp.date().isoformat(), []).append(bar)
        if groups:
            day = sorted(groups)[-1]
            rows = groups[day]
            ranges.append({"session": name, "date": day, "timezone": zone_name, "high": max(row["high"] for row in rows), "low": min(row["low"] for row in rows), "from": rows[0]["time"], "to": rows[-1]["time"], "ruleId": "iana-session-window-range-v1"})
    return ranges


def _supply_demand(bars, atr):
    candidates = []
    for index in range(3, len(bars)):
        impulse = bars[index]
        span = impulse["high"] - impulse["low"]
        if span <= 0 or span < atr * 1.5 or abs(impulse["close"] - impulse["open"]) / span < 0.6:
            continue
        direction = "demand" if impulse["close"] > impulse["open"] else "supply"
        base = []
        for row in reversed(bars[max(0, index - 3):index]):
            if row["high"] - row["low"] > atr * 0.8:
                break
            base.insert(0, row)
        if not base:
            continue
        low, high = min(row["low"] for row in base), max(row["high"] for row in base)
        if direction == "demand" and impulse["close"] <= high:
            continue
        if direction == "supply" and impulse["close"] >= low:
            continue
        later = bars[index + 1:]
        invalidated = any(row["close"] < low if direction == "demand" else row["close"] > high for row in later)
        touches = [row for row in later if row["low"] <= high and row["high"] >= low]
        status = "invalidated" if invalidated else "weakened" if len(touches) > 1 else "partially_tested" if touches else "untested"
        candidates.append({"type": direction, "low": round(low, 5), "high": round(high, 5), "mid": round((low + high) / 2, 5), "baseFrom": base[0]["time"], "baseTo": base[-1]["time"], "displacementAt": impulse["time"], "tests": len(touches), "status": status, "strength": "invalidated" if invalidated else "candidate", "ruleId": "base-displacement-15atr-body60-v1", "invalidation": f"A candle close {'below' if direction == 'demand' else 'above'} {low if direction == 'demand' else high:.5f} invalidates this candidate."})
    return candidates[-12:]


def _liquidity(bars, highs, lows, atr):
    levels = []
    periods = {}
    tolerance = max(atr * 0.15, 0.01)
    for pivots, kind in ((highs, "equal_highs"), (lows, "equal_lows")):
        for previous, current in zip(pivots[-8:], pivots[-7:]):
            if abs(current["price"] - previous["price"]) <= tolerance:
                levels.append({"type": kind, "price": round(mean([previous["price"], current["price"]]), 5), "from": previous["time"], "to": current["time"], "ruleId": "equal-confirmed-pivots-015atr-v1"})
    for mode in ("day", "week", "month"):
        reference = _period_reference(bars, mode)
        if reference:
            periods[mode] = reference
            for side in ("high", "low"):
                levels.append({"type": f"previous_{mode}_{side}", "price": reference[side], "from": reference["from"], "to": reference["to"], "ruleId": reference["ruleId"]})
    for row in bars[-100:]:
        for level in levels:
            swept = row["high"] > level["price"] and row["close"] < level["price"] if level["type"].endswith("highs") or level["type"].endswith("_high") else row["low"] < level["price"] and row["close"] > level["price"]
            if swept:
                level["potentialSweepAt"] = row["time"]
    return {"levels": levels, "sessions": _session_ranges(bars), "periods": periods}


def analyze(candles, timeframe="M15", symbol="XAUUSD"):
    bars = validate_candles(candles)
    if len(bars) < 20:
        return {"engineVersion": ENGINE_VERSION, "symbol": symbol, "timeframe": timeframe, "status": "insufficient_data", "message": "Insufficient data: at least 20 ordered candles are needed.", "candlesAnalyzed": len(bars), "swings": [], "structure": [], "zones": [], "supplyDemand": [], "liquidity": {"levels": [], "sessions": [], "periods": {}}, "patterns": [], "volatility": None, "rules": RULES}
    ranges = _true_ranges(bars)
    atr = mean(ranges[-14:])
    highs, lows = _swings(bars)
    labels_h, labels_l = [p["label"] for p in highs if p["label"] != "H"], [p["label"] for p in lows if p["label"] != "L"]
    bullish = len(labels_h) >= 2 and len(labels_l) >= 2 and labels_h[-2:] == ["HH", "HH"] and labels_l[-2:] == ["HL", "HL"]
    bearish = len(labels_h) >= 2 and len(labels_l) >= 2 and labels_h[-2:] == ["LH", "LH"] and labels_l[-2:] == ["LL", "LL"]
    current = bars[-1]["close"]
    range_ratio = (max(b["high"] for b in bars[-20:]) - min(b["low"] for b in bars[-20:])) / max(atr * 20, 1e-9)
    regime = "bullish_trend" if bullish else "bearish_trend" if bearish else "ranging" if range_ratio < 0.8 else "mixed"
    volatility_ratio = mean(ranges[-5:]) / max(mean(ranges[-25:-5]), 1e-9)
    volatility = "expanding" if volatility_ratio > 1.25 else "contracting" if volatility_ratio < 0.8 else "stable"
    breaks = _structure_breaks(bars, highs, lows)
    wick_events = [event for event in breaks if not event["confirmed"]]
    structure = [event for event in breaks if event["confirmed"]]
    zones = _zones(highs, "resistance", atr) + _zones(lows, "support", atr)
    supply_demand = _supply_demand(bars, atr)
    liquidity = _liquidity(bars, highs, lows, atr)
    recent_highs, recent_lows = highs[-2:], lows[-2:]
    patterns = []
    if len(recent_highs) == 2 and abs(recent_highs[-1]["price"] - recent_highs[-2]["price"]) <= atr * 0.5:
        level = mean(p["price"] for p in recent_highs)
        patterns.append({"type": "double_top_candidate", "level": round(level, 5), "time": recent_highs[-1]["confirmedAt"], "ruleId": "two-confirmed-highs-within-half-atr-v1", "invalidation": f"A candle close above {level:.5f} invalidates the candidate."})
    if len(recent_lows) == 2 and abs(recent_lows[-1]["price"] - recent_lows[-2]["price"]) <= atr * 0.5:
        level = mean(p["price"] for p in recent_lows)
        patterns.append({"type": "double_bottom_candidate", "level": round(level, 5), "time": recent_lows[-1]["confirmedAt"], "ruleId": "two-confirmed-lows-within-half-atr-v1", "invalidation": f"A candle close below {level:.5f} invalidates the candidate."})
    nearest_support = max((z for z in zones if z["type"] == "support" and z["mid"] <= current), key=lambda z: z["mid"], default=None)
    nearest_resistance = min((z for z in zones if z["type"] == "resistance" and z["mid"] >= current), key=lambda z: z["mid"], default=None)
    return {
        "engineVersion": ENGINE_VERSION, "symbol": symbol, "timeframe": timeframe, "status": "ok", "candlesAnalyzed": len(bars),
        "asOf": bars[-1]["time"], "currentClose": current, "atr14": round(atr, 5), "regime": regime,
        "volatility": {"state": volatility, "shortToLongTrueRangeRatio": round(volatility_ratio, 3), "ruleId": "true-range-ratio-v1"},
        "swings": [{key: p[key] for key in ("kind", "time", "confirmedAt", "price", "label")} for p in (highs[-12:] + lows[-12:])],
        "structure": structure[-20:], "provisionalWickPenetrations": wick_events[-10:], "zones": zones,
        "supplyDemand": supply_demand, "liquidity": liquidity,
        "nearestSupport": nearest_support, "nearestResistance": nearest_resistance, "patterns": patterns,
        "ruleDefinitions": RULES, "limitations": ["Pivots are lagging by three closed candles on the right.", "A confirmed close break is not proof of continuation.", "Zone clustering and pattern matches are rule-based hypotheses, not reversal guarantees.", "No spread, slippage, transaction-cost, or news context is included."],
    }


def build_report(results):
    roles = {"D1": "major direction and levels", "H4": "major structure and zones", "H1": "intermediate context", "M15": "entry confirmation", "M5": "optional refinement"}
    context = {tf: {"role": roles.get(tf, "additional context"), "status": result.get("status"), "regime": result.get("regime"), "asOf": result.get("asOf"), "currentClose": result.get("currentClose"), "nearestSupport": result.get("nearestSupport"), "nearestResistance": result.get("nearestResistance"), "supplyDemand": result.get("supplyDemand", []), "liquidity": result.get("liquidity", {"levels": [], "sessions": [], "periods": {}})} for tf, result in results.items()}
    regimes = {tf: r.get("regime") for tf, r in results.items() if r.get("status") == "ok"}
    major = regimes.get("D1")
    intermediate = regimes.get("H1") or regimes.get("H4")
    conflict = bool(major and intermediate and major.startswith(("bullish", "bearish")) and intermediate.startswith(("bullish", "bearish")) and major.split("_")[0] != intermediate.split("_")[0])
    explanations = []
    if conflict:
        explanations.append(f"Higher-timeframe {major.replace('_', ' ')} context conflicts with {intermediate.replace('_', ' ')} intermediate structure. Treat the lower-timeframe move as a possible pullback or reversal; confirmation is missing.")
    if not regimes:
        explanations.append("Insufficient data for a multi-timeframe conclusion.")
    else:
        explanations.append("Timeframes can disagree. No direction is inferred for missing timeframes, and mixed context is retained as mixed.")
    major_result = results.get("D1") or results.get("H4") or {}
    entry_result = results.get("M15") or {}
    price = entry_result.get("currentClose")
    location = "unavailable"
    if price is not None:
        support, resistance = entry_result.get("nearestSupport"), entry_result.get("nearestResistance")
        location = "between_nearest_support_and_resistance" if support and resistance else "near_support" if support else "near_resistance" if resistance else "no_confirmed_nearby_zone"
    explanations.append(f"Current M15 close location: {location}; no missing levels are inferred.")
    explanations.append("Alternative scenario: if the latest close-confirmed structure fails at its documented invalidation level, reassess toward the opposing confirmed zone; otherwise keep the current interpretation conditional.")
    return {"timeframes": context, "conflict": conflict, "currentPriceLocation": {"price": price, "status": location, "support": entry_result.get("nearestSupport"), "resistance": entry_result.get("nearestResistance")}, "higherTimeframeContext": {"timeframe": "D1" if results.get("D1") else "H4", "regime": major_result.get("regime"), "status": major_result.get("status")}, "intermediateContext": {"timeframe": "H1" if results.get("H1") else "H4", "regime": (results.get("H1") or results.get("H4") or {}).get("regime")}, "entryConfirmation": {"timeframe": "M15", "status": entry_result.get("status"), "close": price}, "conflictingSignals": [item for item in explanations if "conflicts" in item.lower() or "conflict" in item.lower()], "alternativeScenarios": ["A candle close through a zone's far edge weakens or invalidates that interpretation.", "If higher and intermediate timeframes conflict, the lower-timeframe move may be a pullback or reversal; wait for additional confirmation."], "noTradeConditions": ["Data is stale or unavailable.", "The relevant timeframe has insufficient candles.", "The proposed setup is invalidated or confirmation is absent.", "Configured risk limits are breached."], "explanations": explanations, "status": "ok" if regimes else "insufficient_data", "asOf": max((r.get("asOf", "") for r in results.values()), default=None)}


def _session_name(value):
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if 0 <= stamp.astimezone(ZoneInfo("Asia/Singapore")).hour < 8:
        return "asia"
    london = 8 <= stamp.astimezone(ZoneInfo("Europe/London")).hour < 17
    new_york = 8 <= stamp.astimezone(ZoneInfo("America/New_York")).hour < 17
    if london and new_york:
        return "london_new_york_overlap"
    if london:
        return "london"
    if new_york:
        return "new_york"
    return "off_session"


def _backtest_slice(bars, begin, end, strategy, stop_atr, reward_risk, total_cost):
    trades = []
    index = max(begin + 20, 20)
    while index < end - 1:
        history = bars[index - 20:index]
        resistance = max(row["high"] for row in history)
        support = min(row["low"] for row in history)
        ranges = _true_ranges(bars[max(0, index - 25):index])
        atr = mean(ranges[-14:]) if len(ranges) >= 14 else 0
        bar = bars[index]
        side, level = None, None
        if atr > 0 and strategy == "breakout":
            if bar["close"] > resistance and bar["close"] > bar["open"]:
                side, level = 1, resistance
            elif bar["close"] < support and bar["close"] < bar["open"]:
                side, level = -1, support
        elif atr > 0 and strategy == "retest":
            tolerance = max(atr * 0.25, 0.01)
            for prior_index in range(index - 5, index):
                if prior_index < 20:
                    continue
                before = bars[prior_index - 20:prior_index]
                prior_bar = bars[prior_index]
                prior_high, prior_low = max(row["high"] for row in before), min(row["low"] for row in before)
                if prior_bar["close"] > prior_high and bar["low"] <= prior_high + tolerance and bar["close"] > prior_high and bar["close"] > bar["open"]:
                    side, level = 1, prior_high
                elif prior_bar["close"] < prior_low and bar["high"] >= prior_low - tolerance and bar["close"] < prior_low and bar["close"] < bar["open"]:
                    side, level = -1, prior_low
                if side:
                    break
        if not side:
            index += 1
            continue
        entry_index = index + 1
        entry = bars[entry_index]["open"]
        risk = atr * stop_atr
        stop = entry - side * risk
        target = entry + side * risk * reward_risk
        exit_price, exit_index, exit_reason = bars[end - 1]["close"], end - 1, "segment_end"
        for future_index in range(entry_index, end):
            future = bars[future_index]
            stop_hit = future["low"] <= stop if side == 1 else future["high"] >= stop
            target_hit = future["high"] >= target if side == 1 else future["low"] <= target
            if stop_hit:
                exit_price, exit_index, exit_reason = stop, future_index, "stop"  # Conservative when both levels trade in one candle.
                break
            if target_hit:
                exit_price, exit_index, exit_reason = target, future_index, "target"
                break
        gross_r = side * (exit_price - entry) / risk
        net_r = gross_r - total_cost / risk
        trades.append({"entryAt": bars[entry_index]["time"], "exitAt": bars[exit_index]["time"], "side": "buy" if side == 1 else "sell", "entry": round(entry, 5), "exit": round(exit_price, 5), "stop": round(stop, 5), "target": round(target, 5), "exitReason": exit_reason, "holdingBars": exit_index - entry_index + 1, "setupType": strategy, "session": _session_name(bars[entry_index]["time"]), "regime": "bullish" if bars[index]["close"] > mean(row["close"] for row in history) else "bearish", "grossR": round(gross_r, 5), "resultR": round(net_r, 5), "ruleId": "close-signal-next-open-fixed-atr-stop-conservative-v1"})
        index = exit_index + 1
    return trades


def _backtest_metrics(trades):
    results = [trade["resultR"] for trade in trades]
    wins, losses = [value for value in results if value > 0], [value for value in results if value < 0]
    equity, peak, drawdown = 0.0, 0.0, 0.0
    for value in results:
        equity += value
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return {"totalTrades": len(results), "winRatePercent": round(100 * len(wins) / len(results), 2) if results else None, "averageWinR": round(mean(wins), 4) if wins else None, "averageLossR": round(mean(losses), 4) if losses else None, "expectancyR": round(mean(results), 4) if results else None, "profitFactor": round(sum(wins) / abs(sum(losses)), 4) if losses else None, "maxDrawdownR": round(drawdown, 4), "netR": round(sum(results), 4), "averageHoldingBars": round(mean(trade["holdingBars"] for trade in trades), 2) if trades else None, "sampleSize": len(results)}


def run_backtest(candles, strategy="breakout", train_fraction=0.7, stop_atr=1.0, reward_risk=2.0, spread_price=0.0, slippage_price=0.0, commission_price=0.0):
    """Close-confirmed 20-bar breakout/retest test; signals enter next bar open."""
    if strategy not in ("breakout", "retest"):
        raise ValueError("strategy must be breakout or retest")
    bars = validate_candles(candles)
    if len(bars) < 80:
        raise ValueError("At least 80 real candles are required for a train/test backtest")
    config_values = (train_fraction, stop_atr, reward_risk, spread_price, slippage_price, commission_price)
    if not all(isfinite(value) for value in config_values) or not 0.5 <= train_fraction <= 0.9 or stop_atr <= 0 or reward_risk <= 0 or any(value < 0 for value in config_values[3:]):
        raise ValueError("Invalid split, stop, or reward/risk configuration")
    costs = spread_price + slippage_price * 2 + commission_price
    split = int(len(bars) * train_fraction)
    train = _backtest_slice(bars, 0, split, strategy, stop_atr, reward_risk, costs)
    test = _backtest_slice(bars, split, len(bars), strategy, stop_atr, reward_risk, costs)
    by_session = {}
    by_regime = {}
    for key, target in (("session", by_session), ("regime", by_regime)):
        for trade in test:
            target.setdefault(trade[key], []).append(trade)
    sensitivities = {}
    for rr in (1.5, 2.0, 2.5):
        sample = _backtest_slice(bars, split, len(bars), strategy, stop_atr, rr, costs)
        sensitivities[f"{rr:.1f}R"] = _backtest_metrics(sample)
    return {"status": "complete", "strategy": strategy, "ruleId": "close-signal-next-open-fixed-atr-stop-conservative-v1", "configuration": {"lookbackBars": 20, "stopAtr": stop_atr, "rewardRisk": reward_risk, "trainFraction": train_fraction, "spreadPrice": spread_price, "slippagePricePerSide": slippage_price, "commissionPriceRoundTrip": commission_price, "totalRoundTripCostPrice": costs}, "train": _backtest_metrics(train), "outOfSample": _backtest_metrics(test), "bySession": {key: _backtest_metrics(value) for key, value in by_session.items()}, "byRegime": {key: _backtest_metrics(value) for key, value in by_regime.items()}, "sensitivityByRewardRisk": sensitivities, "sourceRange": {"from": bars[0]["time"], "to": bars[-1]["time"], "candles": len(bars), "splitAt": bars[split]["time"]}, "trades": test[:500], "limitations": ["This simple research rule is not a recommendation or proof of profitability.", "Signals use only completed candles and enter at the next candle open.", "If stop and target both fit within one candle, stop is conservatively assumed first.", "Costs are explicitly provided in price units and may not equal the broker's realized spread, commission, swaps, or slippage.", "The 70/30 chronological train/test split is a single holdout, not a guarantee of out-of-sample robustness.", "Session labels use Asia/Singapore, Europe/London, and America/New_York IANA timezone hours."]}
