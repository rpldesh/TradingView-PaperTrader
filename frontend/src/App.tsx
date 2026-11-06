import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DrawingKind, MagnetMode } from 'lightweight-charts-drawing';
import { fetchCoins, loadState, saveState } from './api';
import { ChartController, type MarkerSpec, type PriceLineSpec } from './chart';
import {
  AccountPanel, BottomPanel, DrawingToolbar, fmtTime, IndicatorMenu, OrderTicket, priceDecimals, QuickTrade, type QuickTradePos, type OrderSize, orderQty,
} from './components';
import { DrawingSync } from './drawings';
import { type ClosedBar, MarketFeed, type Mode } from './feed';
import { DEFAULT_INDICATORS, type IndicatorInstance } from './indicators';
import {
  cancelOrder, closePosition, liquidationPrice, newPaperState, type OrderRequest, placeOrder,
  processBar, setBrackets, type Side,
} from './paper';
import { type CoinInfo, floorTo, type Interval, INTERVALS, INTERVAL_MS } from './types';
import { usePaper } from './usePaper';

interface Settings {
  coin: string;
  interval: Interval;
  mode: Mode;
  cursorEnd: number;
  speed: number;
  indicators: IndicatorInstance[];
  leverage: number;
  orderSize: OrderSize; // shared by the order ticket and the one-click buttons
  oneClick: boolean;
  quickTradePos?: QuickTradePos; // undefined = default top-right spot
  magnet: MagnetMode;
  keepDrawing: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  coin: 'BTC', interval: '1d', mode: 'live', cursorEnd: Date.UTC(2024, 0, 1),
  speed: 2, indicators: DEFAULT_INDICATORS, leverage: 10,
  orderSize: { unit: 'usd', usd: '1000', coin: '0.01' }, oneClick: true,
  magnet: 'off', keepDrawing: false,
};
const SPEEDS = [0.5, 1, 2, 5, 10, 20];

const toInputValue = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const fromInputValue = (v: string) => Date.parse(`${v}:00Z`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [coins, setCoins] = useState<CoinInfo[]>([]);
  const [, setFeedVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [showIndicators, setShowIndicators] = useState(false);
  const [dateInput, setDateInput] = useState('');
  const [pickedPrice, setPickedPrice] = useState<{ price: number; nonce: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [drawTool, setDrawTool] = useState<DrawingKind | null>(null);
  const [drawingsVisible, setDrawingsVisible] = useState(true);

  const replayPaper = usePaper('replay');
  const livePaper = usePaper('live');

  const chartBox = useRef<HTMLDivElement>(null);
  const legendBox = useRef<HTMLDivElement>(null);
  const chart = useRef<ChartController | null>(null);
  const drawingSync = useRef<DrawingSync | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;

  // ---- market feed -> chart + paper engine -----------------------------------------------

  const feed = useMemo(() => new MarketFeed({
    onChange(kind) {
      chart.current?.setBars(feed.bars(), kind);
      setFeedVersion((v) => v + 1);
      if (kind === 'reset' && !feed.loading && feed.mode === 'replay') {
        // Catch up on bars that elapsed while another coin was on screen.
        const since = replayPaper.ref.current.processedUntil[feed.coin];
        if (since !== undefined) simulate(feed.coin, feed.unprocessedBars(since));
      }
    },
    onBars: (coin, bars) => simulate(coin, bars),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  function simulate(coin: string, bars: ClosedBar[]) {
    const paper = feed.mode === 'replay' ? replayPaper : livePaper;
    paper.update((s) => bars.reduce((acc, { bar, end }) => {
      if (feed.mode === 'replay' && end <= (acc.processedUntil[coin] ?? -Infinity)) return acc;
      return processBar(acc, coin, bar, end);
    }, s));
  }

  const paper = settings?.mode === 'replay' ? replayPaper : livePaper;

  // ---- startup ---------------------------------------------------------------------------

  useEffect(() => {
    const ctl = new ChartController(chartBox.current!, legendBox.current!, {
      onClick(time, price, alt) {
        if (alt && price !== null) {
          setPickedPrice({ price, nonce: Date.now() });
        } else if (selectModeRef.current && time !== null && settingsRef.current) {
          // "Select bar": the clicked bar becomes the last visible bar.
          setSelectMode(false);
          startReplay(time + INTERVAL_MS[settingsRef.current.interval]);
        }
      },
      onNeedOlder: () => feed.loadOlder(),
    });
    chart.current = ctl;
    const sync = new DrawingSync(ctl.drawings);
    drawingSync.current = sync;
    ctl.drawings.on('tool', setDrawTool);
    ctl.drawings.on('visibility', setDrawingsVisible);
    ctl.drawings.on('textEdit', (d) => {
      const text = prompt('Text', d.text ?? '');
      if (text === null) return;
      if (text.trim()) ctl.drawings.update({ ...d, text });
      else ctl.drawings.remove(d.id);
    });
    Promise.all([loadState<Partial<Settings>>('settings'), fetchCoins().catch(() => [])]).then(
      ([saved, coinList]) => {
        setCoins(coinList);
        const s = { ...DEFAULT_SETTINGS, ...saved };
        setSettings(s);
        setDateInput(toInputValue(s.cursorEnd));
        ctl.setIndicators(s.indicators);
        ctl.drawings.setMagnet(s.magnet);
        ctl.drawings.setStayInDrawingMode(s.keepDrawing);
        sync.load(s.coin);
        feed.load(s.coin, s.interval, s.mode, s.cursorEnd);
      },
    );
    return () => {
      feed.dispose();
      sync.dispose();
      ctl.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist settings (including the replay clock) a moment after they change.
  const cursorEnd = feed.cursorEnd;
  useEffect(() => {
    if (!settings) return;
    const save = () => saveState('settings', { ...settings, cursorEnd: feed.cursorEnd || settings.cursorEnd });
    const t = setTimeout(save, 500);
    window.addEventListener('pagehide', save);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pagehide', save);
    };
  }, [settings, cursorEnd, feed]);

  const coinInfo = coins.find((c) => c.name === settings?.coin);
  useEffect(() => chart.current?.setPrecision(priceDecimals(coinInfo)), [coinInfo]);

  const patchSettings = (patch: Partial<Settings>) => setSettings((s) => (s ? { ...s, ...patch } : s));

  // ---- navigation ---------------------------------------------------------------------------

  const changeMarket = (coin: string, interval: Interval) => {
    if (!settings) return;
    patchSettings({ coin, interval });
    drawingSync.current?.load(coin);
    feed.load(coin, interval, settings.mode, feed.cursorEnd);
  };

  function startReplay(cursor: number) {
    const s = settingsRef.current;
    if (!s) return;
    const rp = replayPaper.ref.current;
    const open = Object.keys(rp.positions).length + rp.orders.length;
    if (open && !confirm('Jumping in time closes your open replay positions at their last price and cancels open orders. Continue?')) {
      return;
    }
    setPlaying(false);
    replayPaper.update((st) => {
      let next = Object.keys(st.positions).reduce(
        (acc, coin) => closePosition(acc, coin, acc.marks[coin] ?? acc.positions[coin].entry,
          feed.cursorEnd || cursor), st);
      next = { ...next, orders: [], processedUntil: {} };
      return next;
    });
    patchSettings({ mode: 'replay', cursorEnd: cursor });
    setDateInput(toInputValue(cursor));
    feed.load(s.coin, s.interval, 'replay', cursor);
  }

  const goLive = () => {
    if (!settings) return;
    setPlaying(false);
    setSelectMode(false);
    patchSettings({ mode: 'live' });
    feed.load(settings.coin, settings.interval, 'live');
  };

  // ---- playback ------------------------------------------------------------------------------

  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const t0 = performance.now();
        const ok = await feed.step();
        if (!ok) {
          if (!cancelled) setPlaying(false);
          return;
        }
        const wait = 1000 / (settingsRef.current?.speed ?? 1) - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [playing, feed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.code === 'KeyR' && e.altKey) {
        e.preventDefault();
        chart.current?.resetView();
        return;
      }
      if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyB' || e.code === 'KeyS')) {
        if (!settingsRef.current?.oneClick) return;
        e.preventDefault();
        quickTradeRef.current(e.code === 'KeyB' ? 'buy' : 'sell');
        return;
      }
      if (feed.mode !== 'replay') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === 'ArrowRight' && e.shiftKey) {
        e.preventDefault();
        feed.step();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [feed]);

  useEffect(() => chart.current?.setSelectMode(selectMode), [selectMode]);

  // ---- trading actions ---------------------------------------------------------------------

  const lastBar = feed.lastBar();
  const mark = lastBar?.close;

  const submitOrder = useCallback((req: OrderRequest) => {
    const bar = feed.lastBar();
    if (!bar) return 'No price yet';
    let error: string | undefined;
    paper.update((s) => {
      const res = placeOrder(s, req, bar.close, bar.time);
      error = res.error;
      if (error || feed.mode !== 'replay') return res.state;
      // Bars before the clock are history for this order; don't simulate them later.
      const until = Math.max(res.state.processedUntil[req.coin] ?? 0, feed.cursorEnd);
      return { ...res.state, processedUntil: { ...res.state.processedUntil, [req.coin]: until } };
    });
    return error;
  }, [feed, paper]);

  const ticketCoin = coinInfo ?? (settings ? { name: settings.coin, szDecimals: 4, maxLeverage: 50 } : undefined);

  /** One-click market order using the shared size and leverage. */
  const quickTrade = (side: Side) => {
    if (!settings || !ticketCoin || feed.loading) return;
    const bar = feed.lastBar();
    const size = orderQty(settings.orderSize, bar?.close, ticketCoin);
    if (!bar || !size) return;
    const err = submitOrder({ coin: ticketCoin.name, side, type: 'market', size, leverage: settings.leverage });
    setToast(err ?? `${side === 'buy' ? 'Bought' : 'Sold'} ${size} ${ticketCoin.name} @ ${bar.close.toFixed(decimals(ticketCoin.name))}`);
  };
  const quickTradeRef = useRef(quickTrade);
  quickTradeRef.current = quickTrade;

  const closePos = (coin: string, fraction: number) => {
    const s = paper.ref.current;
    const price = coin === feed.coin && mark ? mark : s.marks[coin];
    const time = coin === feed.coin && lastBar ? lastBar.time : Date.now();
    paper.update((st) => closePosition(st, coin, price, time, fraction));
  };

  const editBrackets = (coin: string, tp?: number, sl?: number) => {
    let error: string | undefined;
    paper.update((s) => {
      const res = setBrackets(s, coin, tp, sl);
      error = res.error;
      return res.state;
    });
    return error;
  };

  // ---- chart overlays for the open position / orders ----------------------------------------

  const pstate = paper.state;
  useEffect(() => {
    if (!settings || !chart.current) return;
    const coin = settings.coin;
    const lines: PriceLineSpec[] = [];
    const pos = pstate.positions[coin];
    if (pos) {
      lines.push({ price: pos.entry, color: '#2962ff', title: `${pos.size > 0 ? 'Long' : 'Short'} ${Math.abs(pos.size)}` });
      if (pos.tp) lines.push({ price: pos.tp, color: '#26a69a', title: 'TP', dashed: true });
      if (pos.sl) lines.push({ price: pos.sl, color: '#ef5350', title: 'SL', dashed: true });
      const liq = liquidationPrice(pstate, coin);
      if (liq) lines.push({ price: liq, color: '#ff9800', title: 'Liq', dashed: true });
    }
    for (const o of pstate.orders.filter((o) => o.coin === coin)) {
      lines.push({ price: o.price, color: '#9598a1', title: `${o.side} ${o.type} ${o.size}`, dashed: true });
    }
    chart.current.setPriceLines(lines);

    const bars = feed.bars();
    const first = bars[0]?.time ?? Infinity;
    const last = bars[bars.length - 1]?.time ?? -Infinity;
    const markers: MarkerSpec[] = pstate.fills
      .filter((f) => f.coin === coin)
      .map((f) => ({ ...f, time: floorTo(f.time, settings.interval) }))
      .filter((f) => f.time >= first && f.time <= last)
      .map((f) => ({
        time: f.time, side: f.side,
        text: f.reason === 'market' || f.reason === 'limit' || f.reason === 'stop'
          ? `${f.side === 'buy' ? 'B' : 'S'} ${f.size}` : f.reason.toUpperCase(),
      }));
    chart.current.setMarkers(markers);
  }, [pstate, settings, feed, feed.loading, lastBar?.time]);

  useEffect(() => {
    if (feed.note) setToast(feed.note);
  }, [feed.note]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const decimals = (coin: string) => priceDecimals(coins.find((c) => c.name === coin));
  const replay = settings?.mode === 'replay';

  return (
    <div className="app">
      <header className="toolbar">
        <span className="logo">📈 PaperView</span>
        <select value={settings?.coin ?? ''} onChange={(e) => changeMarket(e.target.value, settings!.interval)}>
          {(coins.length ? coins : [{ name: settings?.coin ?? 'BTC' }]).map((c) => (
            <option key={c.name} value={c.name}>{c.name}-USD</option>
          ))}
        </select>
        <div className="intervals">
          {INTERVALS.map((iv) => (
            <button key={iv} className={settings?.interval === iv ? 'active' : ''}
                    onClick={() => changeMarket(settings!.coin, iv)}>{iv}</button>
          ))}
        </div>
        <div className="anchor">
          <button onClick={() => setShowIndicators((v) => !v)}>ƒx Indicators</button>
          {showIndicators && settings && (
            <IndicatorMenu
              indicators={settings.indicators}
              onClose={() => setShowIndicators(false)}
              onChange={(next) => {
                patchSettings({ indicators: next });
                chart.current?.setIndicators(next);
              }}
            />
          )}
        </div>
        <button className={replay ? 'active' : ''} onClick={() => (replay ? goLive() : startReplay(fromInputValue(dateInput)))}>
          ⏮ Replay
        </button>
        <button onClick={() => chart.current?.resetView()} title="Reset chart view (Alt+R)">⟲ Reset view</button>
        <button className={settings?.oneClick ? 'active' : ''} onClick={() => patchSettings({ oneClick: !settings?.oneClick })}
                title="Show buy/sell buttons on the chart; Shift+B / Shift+S place market orders">⚡ One-click</button>
        <div className="spacer" />
        <span className={`badge ${feed.source}`} title={feed.note ?? undefined}>
          {feed.mode === 'live' ? '● Live · ' : 'Replay · '}
          {feed.source === 'hyperliquid' ? 'Hyperliquid' : 'Binance (history fallback)'}
        </span>
      </header>

      {replay && (
        <div className="replaybar">
          <label>Start (UTC)
            <input type="datetime-local" value={dateInput} onChange={(e) => setDateInput(e.target.value)} />
          </label>
          <button onClick={() => dateInput && startReplay(fromInputValue(dateInput))}>Go to date</button>
          <button className={selectMode ? 'active' : ''} onClick={() => setSelectMode((v) => !v)}
                  title="Click a bar on the chart to restart the replay from it">✂ Select bar</button>
          <span className="sep" />
          <button className="play" onClick={() => setPlaying((p) => !p)} disabled={feed.atEnd}
                  title="Space">{playing ? '⏸ Pause' : '▶ Play'}</button>
          <button onClick={() => feed.step()} disabled={playing || feed.atEnd} title="Shift+→">⏭ Step</button>
          <select value={settings!.speed} onChange={(e) => patchSettings({ speed: Number(e.target.value) })}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s} bar/s</option>)}
          </select>
          <span className="sep" />
          <span className="clock">Replay time: <b>{fmtTime(feed.cursorEnd)}</b> UTC</span>
          {feed.atEnd && <span className="msg">Reached the present.</span>}
          <div className="spacer" />
          <button onClick={goLive}>Exit replay → Live</button>
        </div>
      )}

      <main className="main">
        <DrawingToolbar
          tool={drawTool}
          onTool={(kind) => chart.current?.drawings.setTool(kind)}
          magnet={settings?.magnet ?? 'off'}
          onMagnet={(magnet) => {
            chart.current?.drawings.setMagnet(magnet);
            patchSettings({ magnet });
          }}
          keep={settings?.keepDrawing ?? false}
          onKeep={(keepDrawing) => {
            chart.current?.drawings.setStayInDrawingMode(keepDrawing);
            patchSettings({ keepDrawing });
          }}
          visible={drawingsVisible}
          onVisible={(v) => chart.current?.drawings.setDrawingsVisible(v)}
          onClearAll={() => {
            const d = chart.current?.drawings;
            if (d?.drawings().length && confirm(`Remove all drawings on ${settings?.coin}?`)) d.clear();
          }}
        />
        <div className={`chart-wrap ${selectMode ? 'selecting' : ''}`}>
          <div ref={chartBox} className="chart" />
          <div ref={legendBox} className="legend" />
          {settings?.oneClick && (
            <QuickTrade coin={ticketCoin} mark={mark} size={settings.orderSize}
                        onSize={(orderSize) => patchSettings({ orderSize })} leverage={settings.leverage}
                        disabled={feed.loading || !!feed.error} onTrade={quickTrade}
                        pos={settings.quickTradePos} onMove={(quickTradePos) => patchSettings({ quickTradePos })} />
          )}
          {feed.loading && <div className="overlay">Loading {settings?.coin} {settings?.interval}…</div>}
          {feed.error && <div className="overlay error">{feed.error}</div>}
          {selectMode && <div className="overlay hint-top">Click a bar to start the replay from it</div>}
          {toast && <div className="toast">{toast}</div>}
          <button className="reset-view" onClick={() => chart.current?.resetView()}
                  title="Reset chart view (Alt+R)">⟲</button>
        </div>
        <aside className="sidebar">
          <AccountPanel
            state={paper.state}
            label={replay ? 'Replay' : 'Live paper'}
            onReset={(balance) => paper.update(() => newPaperState(balance))}
          />
          <OrderTicket coin={ticketCoin} mark={mark} pickedPrice={pickedPrice} onSubmit={submitOrder}
                       size={settings?.orderSize ?? DEFAULT_SETTINGS.orderSize} onSize={(orderSize) => patchSettings({ orderSize })}
                       leverage={settings?.leverage ?? DEFAULT_SETTINGS.leverage}
                       onLeverage={(leverage) => patchSettings({ leverage })} />
        </aside>
      </main>

      <BottomPanel
        state={paper.state}
        decimals={decimals}
        onClose={closePos}
        onCancel={(id) => paper.update((s) => cancelOrder(s, id))}
        onBrackets={editBrackets}
      />
    </div>
  );
}
