"""Read-only FundingPips MT5 collector. Requires Windows, MetaTrader 5 desktop, and MetaTrader5 Python package."""
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    import MetaTrader5 as mt5
except ImportError as exc:
    raise SystemExit("Install MetaTrader5 on the Windows VPS with: py -m pip install MetaTrader5") from exc


def load_local_env():
    """Load simple KEY=VALUE entries from the private collector .env without expanding shell syntax."""
    env_file = Path(__file__).with_name(".env")
    if not env_file.is_file():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if key and key.replace("_", "").isalnum():
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            os.environ.setdefault(key, value)


load_local_env()


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
API_URL = os.environ.get("COLLECTOR_API_URL", "").rstrip("/")
TOKEN = os.environ.get("COLLECTOR_TOKEN", "")
SYMBOL = os.environ.get("MT5_SYMBOL", "XAUUSD")
TERMINAL_PATH = os.environ.get("MT5_TERMINAL_PATH", "")
POLL_SECONDS = max(3, int(os.environ.get("POLL_SECONDS", "10")))
BOOTSTRAP_BARS = min(2000, max(100, int(os.environ.get("BOOTSTRAP_BARS", "600"))))
TIMEFRAMES = {
    "M5": (mt5.TIMEFRAME_M5, 300), "M15": (mt5.TIMEFRAME_M15, 900),
    "M30": (mt5.TIMEFRAME_M30, 1800), "H1": (mt5.TIMEFRAME_H1, 3600),
    "H4": (mt5.TIMEFRAME_H4, 14400), "D1": (mt5.TIMEFRAME_D1, 86400),
}


def utc_iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def initialize():
    # Credentials remain in the MT5 terminal's own account store. This script never accepts a password.
    args = {"timeout": 20_000}
    if TERMINAL_PATH:
        args["path"] = TERMINAL_PATH
    if not mt5.initialize(**args):
        raise RuntimeError(f"MT5 initialize failed ({mt5.last_error()}); open the terminal and log in to the assigned FundingPips server")
    terminal = mt5.terminal_info()
    if terminal is None or not terminal.connected:
        raise RuntimeError("MT5 terminal is open but disconnected from its broker server")
    account = mt5.account_info()
    if account is None or not account.server:
        raise RuntimeError("MT5 is connected, but account/server details are unavailable")
    expected_server = os.environ.get("MT5_EXPECTED_SERVER", "").strip()
    if not expected_server:
        raise RuntimeError("Set MT5_EXPECTED_SERVER to the exact assigned server shown in FundingPips Credentials before connecting")
    if account.server != expected_server:
        raise RuntimeError(f"Connected to server {account.server!r}, which does not match configured MT5_EXPECTED_SERVER")
    info = mt5.symbol_info(SYMBOL)
    if info is None:
        matching = [item.name for item in (mt5.symbols_get() or ()) if "XAU" in item.name.upper() or "GOLD" in item.name.upper()]
        raise RuntimeError(f"Configured symbol {SYMBOL!r} was not found. Candidate names: {matching[:20]}; set MT5_SYMBOL explicitly after checking the terminal.")
    if not mt5.symbol_select(SYMBOL, True):
        raise RuntimeError(f"Could not select configured symbol {SYMBOL!r}: {mt5.last_error()}")
    return info


def compatibility_check():
    info = initialize()
    terminal = mt5.terminal_info()
    account = mt5.account_info()
    tick = mt5.symbol_info_tick(SYMBOL)
    rates = mt5.copy_rates_from_pos(SYMBOL, mt5.TIMEFRAME_M15, 1, 3)
    if account is None:
        raise RuntimeError("MT5 is connected, but account_info is unavailable; verify the terminal is logged into the intended FundingPips account")
    if tick is None or rates is None or len(rates) < 1:
        raise RuntimeError("Symbol is selected, but a tick or closed M15 candle could not be read")
    tick_time = getattr(tick, "time_msc", 0) / 1000 if getattr(tick, "time_msc", 0) else tick.time
    report = {
        "terminalConnected": bool(terminal.connected), "terminalVersion": mt5.version(),
        "accountServer": account.server, "accountCurrency": account.currency,
        "symbol": info.name, "closedM15CandlesReadable": len(rates),
        "tickAgeSeconds": round(time.time() - tick_time, 1),
        "tickReadable": bool(tick.bid and tick.ask and tick.ask >= tick.bid),
        "readOnlyCheck": True,
    }
    print(json.dumps(report, indent=2))


def missing_gaps(rates, seconds):
    gaps = []
    for before, after in zip(rates, rates[1:]):
        delta = int(after["time"]) - int(before["time"])
        # Overnight/session/weekend closures are not reported as candle holes.
        if seconds < delta <= min(seconds * 2, 8 * 3600):
            gaps.append({"from": utc_iso(before["time"]), "to": utc_iso(after["time"]), "expectedIntervalSeconds": seconds})
    return gaps


def post(payload):
    request = urllib.request.Request(
        API_URL + "/api/collector/ingest", data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read())


def collect(info):
    terminal = mt5.terminal_info()
    if terminal is None or not terminal.connected:
        raise ConnectionError("MT5 terminal disconnected")
    tick = mt5.symbol_info_tick(SYMBOL)
    if tick is None or not tick.time:
        raise ConnectionError(f"No tick available for {SYMBOL}")
    price_time = getattr(tick, "time_msc", 0) / 1000 if getattr(tick, "time_msc", 0) else tick.time
    account = mt5.account_info()
    expected_server = os.environ.get("MT5_EXPECTED_SERVER", "").strip()
    if account is None or not account.server or (expected_server and account.server != expected_server):
        raise RuntimeError("MT5 account server is unavailable or no longer matches MT5_EXPECTED_SERVER")
    candle_sets, gaps = {}, {}
    for name, (mt_timeframe, seconds) in TIMEFRAMES.items():
        rates = mt5.copy_rates_from_pos(SYMBOL, mt_timeframe, 1, BOOTSTRAP_BARS)
        if rates is None:
            raise RuntimeError(f"Could not read {name} rates: {mt5.last_error()}")
        rows = sorted((dict(row) for row in rates), key=lambda row: row["time"])
        candle_sets[name] = [{
            "time": utc_iso(row["time"]), "open": float(row["open"]), "high": float(row["high"]),
            "low": float(row["low"]), "close": float(row["close"]), "volume": int(row["tick_volume"]),
        } for row in rows]
        gaps[name] = missing_gaps(rows, seconds)
    return {
        "provider": "fundingpips-mt5", "symbol": SYMBOL, "accountServer": str(account.server), "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "timeframes": candle_sets, "tick": {"time": utc_iso(price_time), "bid": float(tick.bid), "ask": float(tick.ask), "last": float(tick.last or 0)},
        "symbolInfo": {
            "name": info.name, "digits": int(info.digits), "point": float(info.point),
            "tradeTickSize": float(info.trade_tick_size or 0), "tradeTickValue": float(info.trade_tick_value or 0),
            "contractSize": float(info.trade_contract_size or 0), "currencyBase": info.currency_base,
            "currencyProfit": info.currency_profit, "currencyMargin": info.currency_margin,
            "volumeMin": float(info.volume_min or 0), "volumeMax": float(info.volume_max or 0),
            "volumeStep": float(info.volume_step or 0),
            "accountCurrency": str(account.currency) if account is not None and account.currency else None,
        },
        "terminalConnected": bool(terminal.connected), "missingCandleGaps": gaps,
    }


def main():
    if not API_URL.startswith("https://") and "localhost" not in API_URL and "127.0.0.1" not in API_URL:
        raise SystemExit("COLLECTOR_API_URL must use HTTPS unless it points to localhost")
    if len(TOKEN) < 32:
        raise SystemExit("Set COLLECTOR_TOKEN to a random secret of at least 32 characters")
    backoff = POLL_SECONDS
    while True:
        try:
            if mt5.terminal_info() is None or not mt5.terminal_info().connected:
                logging.warning("MT5 disconnected; reconnecting")
                mt5.shutdown()
                info = initialize()
            else:
                info = mt5.symbol_info(SYMBOL)
                if info is None:
                    info = initialize()
            result = post(collect(info))
            logging.info("Ingest accepted; candles=%s, tickTime=%s", result.get("candlesAccepted"), result.get("tickTime"))
            backoff = POLL_SECONDS
            time.sleep(POLL_SECONDS)
        except (urllib.error.URLError, TimeoutError, ConnectionError, RuntimeError) as exc:
            logging.warning("Read-only collection cycle failed: %s; retry in %ss", exc, backoff)
            mt5.shutdown()
            time.sleep(backoff)
            backoff = min(max(POLL_SECONDS, backoff * 2), 120)


if __name__ == "__main__":
    try:
        if "--check" in sys.argv:
            compatibility_check()
        else:
            initialize()
            main()
    except KeyboardInterrupt:
        logging.info("Collector stopped")
    except Exception as exc:
        logging.error("Collector startup failed: %s", exc)
        sys.exit(1)
    finally:
        mt5.shutdown()
