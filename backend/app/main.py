import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .candles import INTERVAL_MS, CandleService
from .store import Store

logging.basicConfig(level=logging.INFO)

store = Store()
service = CandleService(store)
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await service.close()


app = FastAPI(title="Paper Trader", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"],
                   allow_headers=["*"])


@app.get("/api/intervals")
async def intervals():
    return INTERVAL_MS


@app.get("/api/coins")
async def coins():
    try:
        return await service.hl.coins()
    except Exception as exc:
        raise HTTPException(502, f"Hyperliquid unavailable: {exc}")


@app.get("/api/candles")
async def candles(
    coin: str,
    interval: str,
    start: int = Query(..., description="ms epoch, inclusive"),
    end: int = Query(..., description="ms epoch, exclusive"),
    source: str = Query("auto", pattern="^(auto|hyperliquid|binance)$"),
):
    try:
        return await service.get(coin, interval, start, end, source)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        logging.exception("candle fetch failed")
        raise HTTPException(502, f"Upstream data error: {exc}")


@app.get("/api/state/{name}")
async def get_state(name: str):
    return store.get_json(f"state:{name}")


@app.put("/api/state/{name}")
async def put_state(name: str, value: Any = Body(...)):
    store.put_json(f"state:{name}", value)
    return {"ok": True}


# Serve the built frontend (npm run build) so a single process runs everything.
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
