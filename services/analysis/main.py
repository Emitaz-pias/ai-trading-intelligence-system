"""Small internal JSON service for the deterministic analysis engine."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from engine import analyze, build_report, run_backtest


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        self._json(200, {"status": "ok", "service": "deterministic-analysis", "engineVersion": "0.1.0"})

    def do_POST(self):
        if self.path == "/backtest":
            self._backtest()
            return
        if self.path != "/analyze":
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 5_000_000:
                raise ValueError("Request body is empty or exceeds 5 MB")
            body = json.loads(self.rfile.read(size))
            candles = body.get("candles", {})
            results = {tf: analyze(rows, timeframe=tf, symbol=body.get("symbol", "XAUUSD")) for tf, rows in candles.items()}
            self._json(200, {"results": results, "report": build_report(results)})
        except (ValueError, KeyError, TypeError) as exc:
            self._json(400, {"error": str(exc)})

    def _backtest(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 5_000_000:
                raise ValueError("Request body is empty or exceeds 5 MB")
            body = json.loads(self.rfile.read(size))
            result = run_backtest(
                body.get("candles", []),
                strategy=body.get("strategy", "breakout"),
                train_fraction=float(body.get("trainFraction", 0.7)),
                stop_atr=float(body.get("stopAtr", 1.0)),
                reward_risk=float(body.get("rewardRisk", 2.0)),
                spread_price=float(body.get("spreadPrice", 0)),
                slippage_price=float(body.get("slippagePrice", 0)),
                commission_price=float(body.get("commissionPrice", 0)),
            )
            self._json(200, result)
        except (ValueError, KeyError, TypeError, OverflowError) as exc:
            self._json(400, {"error": str(exc)})

    def _json(self, status, value):
        output = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        self.wfile.write(output)

    def log_message(self, *_):
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("ANALYSIS_PORT", "8001"))), Handler)
    print("Deterministic analysis service listening on port", server.server_port)
    server.serve_forever()
