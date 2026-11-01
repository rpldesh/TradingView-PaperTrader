"""Persistent Hyperliquid WebSocket client.

Historical candles are requested over the socket with `post` messages
(`{"method": "post", "request": {"type": "info", "payload": {...}}}`), which is
Hyperliquid's request/response channel on the same connection used for live
subscriptions. Hyperliquid only retains the most recent ~5000 candles per
interval, so callers must handle older ranges elsewhere (see binance.py).
"""

import asyncio
import itertools
import json
import logging

import websockets

log = logging.getLogger(__name__)

WS_URL = "wss://api.hyperliquid.xyz/ws"
MAX_CANDLES_PER_REQUEST = 5000  # Hyperliquid caps each snapshot at 5000 bars
REQUEST_TIMEOUT = 20
PING_INTERVAL = 30  # server drops idle connections after 60s


class HyperliquidWS:
    def __init__(self) -> None:
        self._ws = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._connect_lock = asyncio.Lock()
        self._reader_task: asyncio.Task | None = None
        self._ping_task: asyncio.Task | None = None

    async def _ensure_connected(self):
        if self._ws is not None:
            return self._ws
        async with self._connect_lock:
            if self._ws is None:
                log.info("connecting to %s", WS_URL)
                self._ws = await websockets.connect(WS_URL, max_size=None, ping_interval=None)
                self._reader_task = asyncio.create_task(self._reader(self._ws))
                self._ping_task = asyncio.create_task(self._pinger(self._ws))
        return self._ws

    async def _reader(self, ws) -> None:
        try:
            async for raw in ws:
                msg = json.loads(raw)
                if msg.get("channel") != "post":
                    continue
                data = msg["data"]
                fut = self._pending.pop(data.get("id"), None)
                if fut is None or fut.done():
                    continue
                response = data.get("response", {})
                if response.get("type") == "error":
                    fut.set_exception(RuntimeError(f"Hyperliquid error: {response.get('payload')}"))
                else:
                    fut.set_result(response.get("payload", {}).get("data"))
        except Exception as exc:  # connection dropped
            log.warning("hyperliquid ws reader stopped: %s", exc)
        finally:
            self._reset(ws, ConnectionError("Hyperliquid websocket closed"))

    async def _pinger(self, ws) -> None:
        try:
            while True:
                await asyncio.sleep(PING_INTERVAL)
                await ws.send(json.dumps({"method": "ping"}))
        except Exception:
            pass

    def _reset(self, ws, exc: Exception) -> None:
        if self._ws is not ws:
            return
        self._ws = None
        if self._ping_task:
            self._ping_task.cancel()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    async def info(self, payload: dict, retries: int = 2):
        """Send an `info` request over the socket and await its response."""
        for attempt in range(retries + 1):
            req_id = next(self._ids)
            try:
                ws = await self._ensure_connected()
                fut = asyncio.get_running_loop().create_future()
                self._pending[req_id] = fut
                await ws.send(json.dumps({
                    "method": "post",
                    "id": req_id,
                    "request": {"type": "info", "payload": payload},
                }))
                return await asyncio.wait_for(fut, REQUEST_TIMEOUT)
            except (ConnectionError, websockets.ConnectionClosed, asyncio.TimeoutError) as exc:
                self._pending.pop(req_id, None)
                if self._ws is not None and isinstance(exc, asyncio.TimeoutError):
                    await self._ws.close()
                if attempt == retries:
                    raise
                log.warning("retrying hyperliquid request after %r", exc)
                await asyncio.sleep(0.5 * (attempt + 1))

    async def candles(self, coin: str, interval: str, start: int, end: int) -> list[dict]:
        """Candles with open time in [start, end), paginated past the 5000 cap."""
        out: list[dict] = []
        cursor = start
        while cursor < end:
            batch = await self.info({
                "type": "candleSnapshot",
                "req": {"coin": coin, "interval": interval, "startTime": cursor, "endTime": end - 1},
            }) or []
            batch = [c for c in batch if cursor <= c["t"] < end]
            if not batch:
                break
            out.extend(batch)
            if len(batch) < MAX_CANDLES_PER_REQUEST:
                break
            cursor = batch[-1]["t"] + 1
        return [
            {
                "time": c["t"],
                "open": float(c["o"]),
                "high": float(c["h"]),
                "low": float(c["l"]),
                "close": float(c["c"]),
                "volume": float(c["v"]),
            }
            for c in out
        ]

    async def coins(self) -> list[dict]:
        meta = await self.info({"type": "meta"})
        return [
            {"name": u["name"], "szDecimals": u["szDecimals"], "maxLeverage": u["maxLeverage"]}
            for u in meta["universe"]
            if not u.get("isDelisted")
        ]

    async def close(self) -> None:
        if self._ws is not None:
            await self._ws.close()
