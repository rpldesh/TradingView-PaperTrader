"""Fallback source for history older than Hyperliquid retains.

Uses Binance's public market-data mirror (no API key, not geo-restricted),
which has spot klines back to 2017 for the major pairs.
"""

import httpx

BASE_URL = "https://data-api.binance.vision/api/v3/klines"
MAX_PER_REQUEST = 1000

# Hyperliquid lists some low-priced coins as "k" (x1000) contracts.
_SYMBOL_OVERRIDES = {"kPEPE": "PEPE", "kSHIB": "SHIB", "kBONK": "BONK", "kFLOKI": "FLOKI"}


def binance_symbol(coin: str) -> str:
    return f"{_SYMBOL_OVERRIDES.get(coin, coin)}USDT"


class BinanceSource:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=20)

    async def candles(self, coin: str, interval: str, start: int, end: int) -> list[dict]:
        """Candles with open time in [start, end)."""
        symbol = binance_symbol(coin)
        scale = 1000.0 if coin in _SYMBOL_OVERRIDES else 1.0
        out: list[dict] = []
        cursor = start
        while cursor < end:
            resp = await self._client.get(BASE_URL, params={
                "symbol": symbol, "interval": interval,
                "startTime": cursor, "endTime": end - 1, "limit": MAX_PER_REQUEST,
            })
            if resp.status_code == 400:
                raise ValueError(f"Binance has no market {symbol} for historical fallback")
            resp.raise_for_status()
            batch = resp.json()
            if not batch:
                break
            out.extend(
                {
                    "time": k[0],
                    "open": float(k[1]) * scale,
                    "high": float(k[2]) * scale,
                    "low": float(k[3]) * scale,
                    "close": float(k[4]) * scale,
                    "volume": float(k[5]) / scale,
                }
                for k in batch
            )
            if len(batch) < MAX_PER_REQUEST:
                break
            cursor = batch[-1][0] + 1
        return out

    async def close(self) -> None:
        await self._client.aclose()
