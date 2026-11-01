"""Chooses a data source for a candle range and caches closed bars."""

import asyncio
import time

from .binance import BinanceSource
from .hyperliquid import HyperliquidWS
from .store import Store

INTERVAL_MS = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000,
    "12h": 43_200_000, "1d": 86_400_000,
}
EARLIEST_TTL = 3600  # seconds; Hyperliquid's retention window slides forward over time


def now_ms() -> int:
    return int(time.time() * 1000)


class CandleService:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.hl = HyperliquidWS()
        self.binance = BinanceSource()
        self._earliest: dict[tuple[str, str], tuple[float, int | None]] = {}
        self._earliest_lock = asyncio.Lock()

    async def hl_earliest(self, coin: str, interval: str) -> int | None:
        """Open time of the oldest bar Hyperliquid still serves for this coin/interval."""
        key = (coin, interval)
        cached = self._earliest.get(key)
        if cached and time.time() - cached[0] < EARLIEST_TTL:
            return cached[1]
        async with self._earliest_lock:
            cached = self._earliest.get(key)
            if cached and time.time() - cached[0] < EARLIEST_TTL:
                return cached[1]
            # A snapshot from t=0 returns the oldest retained bars first.
            bars = await self.hl.info({
                "type": "candleSnapshot",
                "req": {"coin": coin, "interval": interval, "startTime": 0, "endTime": now_ms()},
            }) or []
            earliest = bars[0]["t"] if bars else None
            self._earliest[key] = (time.time(), earliest)
            return earliest

    async def _fetch(self, source: str, coin: str, interval: str, start: int, end: int) -> list[dict]:
        if self.store.is_covered(source, coin, interval, start, end):
            return self.store.get_candles(source, coin, interval, start, end)
        fetch = self.hl.candles if source == "hyperliquid" else self.binance.candles
        candles = await fetch(coin, interval, start, end)
        # Only cache bars that are closed; the forming bar keeps changing.
        closed_end = min(end, (now_ms() // INTERVAL_MS[interval]) * INTERVAL_MS[interval])
        if source == "hyperliquid":
            # Don't mark the region before Hyperliquid's retention as covered (it is just empty).
            earliest = await self.hl_earliest(coin, interval)
            start = max(start, earliest) if earliest else closed_end
        self.store.put_candles(source, coin, interval, start, closed_end, candles)
        return candles

    async def get(self, coin: str, interval: str, start: int, end: int, source: str = "auto") -> dict:
        if interval not in INTERVAL_MS:
            raise ValueError(f"Unsupported interval {interval}")
        dur = INTERVAL_MS[interval]
        start = (start // dur) * dur
        end = min(end, now_ms() + dur)
        earliest = await self.hl_earliest(coin, interval)

        if source == "auto":
            source = "hyperliquid" if earliest is not None and start >= earliest else "binance"

        note = None
        if source == "binance":
            try:
                candles = await self._fetch("binance", coin, interval, start, end)
            except ValueError as exc:
                # No Binance market for this coin: serve whatever Hyperliquid has.
                note = str(exc)
                source = "hyperliquid"
        if source == "hyperliquid":
            candles = await self._fetch("hyperliquid", coin, interval, start, end) if end > start else []

        return {
            "coin": coin, "interval": interval, "source": source,
            "hyperliquidEarliest": earliest, "note": note, "candles": candles,
        }

    async def close(self) -> None:
        await self.hl.close()
        await self.binance.close()
