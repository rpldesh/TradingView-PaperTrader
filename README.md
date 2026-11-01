# PaperView: bar replay and paper trading

A local, TradingView-style charting app built on
[Lightweight Charts](https://github.com/tradingview/lightweight-charts). You can replay
historical candles from any date and paper trade along the way, or paper trade live
Hyperliquid prices.

## Run

Requirements: Python 3.11+ and Node 18+.

```powershell
.\start.ps1          # installs deps on first run, builds the UI, opens http://localhost:8000
.\start.ps1 -Dev     # hot reload: FastAPI on :8000 + Vite on http://localhost:5173
```

On Windows you can also double-click `start.bat` (or run `start.bat -Dev`). It runs
`start.ps1` with the execution policy bypassed.

Manual equivalent:

```powershell
cd backend;  python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt
cd ..\frontend; npm install; npm run build
cd ..\backend; .\.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

## Market data

| Source | Used for | How |
|---|---|---|
| **Hyperliquid** | Live candles, plus any history Hyperliquid still keeps | WebSocket (`wss://api.hyperliquid.xyz/ws`). The backend sends `post` → `candleSnapshot`; the browser subscribes to `candle` for live updates |
| **Binance** spot (`data-api.binance.vision`) | History older than Hyperliquid keeps | Public REST, no key |

Hyperliquid **only keeps the most recent ~5000 candles per interval**: 1m covers about 3.5 days,
1h about 7 months, and 1d goes back to 2020-08. So a replay of, say, 2020-01-01 on 1h can't use
Hyperliquid. In `auto` mode the backend uses Hyperliquid when the whole requested range is
still kept there, and otherwise falls back to Binance `<COIN>USDT`. A replay session stays on
one source, so the chart has no price seams. The badge at the top right shows which source is
in use.

Closed candles are cached in `backend/data/paper_trader.db` (SQLite), so revisiting a period
is instant.

## Replay

- Click **Replay**, pick a start date/time (UTC) and click **Go to date**. Or click **Select bar**
  and then click a candle; that candle becomes the last visible one.
- **Play/Pause** (Space), **Step** (Shift+→), speed from 0.5 to 20 bars/s.
- **The replay clock is kept when you change interval.** If you start at 2020-01-01 on 1d and
  switch to 1h, you continue from 2020-01-01 00:00 on hourly candles. If you step through some
  hours and switch back to 1d, the current day is shown as a *partial* daily candle built from
  the hours you've seen. No future data leaks.
- Scroll left to load older history.

## Paper trading

- Market, limit and stop orders, with optional TP/SL, reduce-only, and leverage up to the
  coin's Hyperliquid max. Alt+click the chart to copy a price into the order ticket.
- Perp-style cross margin with one net position per coin. Fees default to Hyperliquid's base
  tier (taker 0.045%, maker 0.015%). Liquidation happens when equity falls to maintenance
  margin (50% of initial).
- Fills are simulated from each bar's OHLC. If a bar gaps through your price, you get filled at
  the open. If a bar hits both TP and SL, the SL is assumed to fill first.
- Replay and live have **separate accounts**. Jumping to a new replay date closes open replay
  positions at their last price. Account state and settings are saved in the backend database.

## Indicators

Volume, SMA, EMA, Bollinger Bands, daily VWAP, RSI, MACD, Stochastic and ATR. Each has
editable parameters, colours and visibility. You can add several of the same indicator, e.g.
EMA 20 and EMA 200.

## Layout

```
backend/app/
  main.py         FastAPI routes (/api/candles, /api/coins, /api/state) + serves frontend/dist
  hyperliquid.py  persistent WebSocket client (post requests, ping, reconnect)
  binance.py      historical fallback
  candles.py      source selection + caching
  store.py        SQLite candle cache and key/value state
frontend/src/
  feed.ts         replay clock, buffering, partial bars, live WebSocket
  chart.ts        Lightweight Charts wrapper (panes, indicators, price lines, markers)
  paper.ts        paper-trading engine (pure functions)
  indicators.ts   indicator maths
  App.tsx, components.tsx
```
