import { useEffect, useRef, useState } from 'react';
import type { DrawingKind, MagnetMode } from 'lightweight-charts-drawing';
import { DRAWING_TOOLS } from './drawings';
import {
  type IndicatorInstance, INDICATORS, indicatorDef, indicatorLabel, newIndicator,
} from './indicators';
import {
  equity, liquidationPrice, type OrderRequest, type OrderType, type PaperState, type Side, stats,
  unrealized, usedMargin,
} from './paper';
import type { CoinInfo } from './types';

export const fmtTime = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
export const fmtUsd = (v: number) =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (v: number) => `${v >= 0 ? '+' : ''}${fmtUsd(v)}`;
const pnlClass = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

export const priceDecimals = (coin?: CoinInfo) => Math.max(0, 6 - (coin?.szDecimals ?? 2));

/** Order size shared by the ticket and the one-click buttons, entered in USD or in coin. */
export type SizeUnit = 'usd' | 'coin';
export interface OrderSize { unit: SizeUnit; usd: string; coin: string }

const floorSize = (qty: number, coin?: CoinInfo) => {
  const step = 10 ** (coin?.szDecimals ?? 4);
  return Math.floor(qty * step + 1e-9) / step;
};

/** Coin quantity to trade, rounded down to the coin's size step. A USD size needs `price`. */
export function orderQty(size: OrderSize, price: number | undefined, coin?: CoinInfo): number {
  if (size.unit === 'coin') return Math.max(floorSize(num(size.coin) ?? 0, coin), 0);
  const notional = num(size.usd);
  return price && notional ? Math.max(floorSize(notional / price, coin), 0) : 0;
}

/** Switch unit, carrying the current amount over at `price`. */
export function toggleSizeUnit(size: OrderSize, price: number | undefined, coin?: CoinInfo): OrderSize {
  const qty = orderQty(size, price, coin);
  if (size.unit === 'usd') return { ...size, unit: 'coin', coin: qty ? String(qty) : size.coin };
  return { ...size, unit: 'usd', usd: qty && price ? (qty * price).toFixed(2) : size.usd };
}

const unitLabel = (size: OrderSize, coin?: CoinInfo) => (size.unit === 'usd' ? 'USD' : coin?.name ?? 'Coin');

// ---- one-click trading (TradingView-style buy/sell buttons on the chart) ----------

/** Offset of the one-click buttons from the chart's top-right corner, in px. */
export interface QuickTradePos { right: number; top: number }

export function QuickTrade({ coin, mark, size, onSize, leverage, disabled, onTrade, pos, onMove }: {
  coin: CoinInfo | undefined;
  mark: number | undefined;
  size: OrderSize;
  onSize(size: OrderSize): void;
  leverage: number;
  disabled: boolean;
  onTrade(side: Side): void;
  pos: QuickTradePos | undefined;
  onMove(pos: QuickTradePos | undefined): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const price = mark?.toFixed(priceDecimals(coin)) ?? '—';
  const qty = orderQty(size, mark, coin);
  const off = disabled || !qty;

  // Drag by the grip, kept inside the chart. Anchored to the top-right so it stays put on resize.
  const startDrag = (e: React.PointerEvent) => {
    const el = ref.current;
    const box = el?.offsetParent as HTMLElement | null;
    if (!el || !box || e.button !== 0) return;
    e.preventDefault();
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      const left = Math.min(Math.max(ev.clientX - dx - b.left, 0), b.width - r.width);
      const top = Math.min(Math.max(ev.clientY - dy - b.top, 0), b.height - r.height);
      onMove({ right: Math.round(b.width - r.width - left), top: Math.round(top) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.classList.remove('dragging');
    };
    el.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={ref} className="quick-trade" onMouseDown={(e) => e.stopPropagation()}
         style={pos && { right: Math.max(pos.right, 0), top: `min(${pos.top}px, calc(100% - 44px))` }}>
      <div className="qt-grip" onPointerDown={startDrag} onDoubleClick={() => onMove(undefined)}
           title="Drag to move · double-click to reset position">⋮⋮</div>
      <button className="qt-sell" disabled={off} onClick={() => onTrade('sell')} title="Sell market (Shift+S)">
        <span>{price}</span><small>SELL</small>
      </button>
      <div className="qt-size" title={size.unit === 'usd'
        ? `≈ ${qty} ${coin?.name ?? ''} at ${leverage}x`
        : `≈ ${fmtUsd(qty * (mark ?? 0))} notional at ${leverage}x`}>
        <button className="qt-unit" onClick={() => onSize(toggleSizeUnit(size, mark, coin))}
                title="Switch between USD and coin amount">{unitLabel(size, coin)} ⇄</button>
        <input value={size[size.unit]} onChange={(e) => onSize({ ...size, [size.unit]: e.target.value })}
               inputMode="decimal" />
      </div>
      <button className="qt-buy" disabled={off} onClick={() => onTrade('buy')} title="Buy market (Shift+B)">
        <span>{price}</span><small>BUY</small>
      </button>
    </div>
  );
}

// ---- order ticket ------------------------------------------------------------

interface TicketProps {
  coin: CoinInfo | undefined;
  mark: number | undefined;
  pickedPrice: { price: number; nonce: number } | null;
  size: OrderSize;
  onSize(size: OrderSize): void;
  leverage: number;
  onLeverage(leverage: number): void;
  onSubmit(req: OrderRequest): string | undefined;
}

export function OrderTicket({
  coin, mark, pickedPrice, size, onSize: setSize, leverage, onLeverage: setLeverage, onSubmit,
}: TicketProps) {
  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>('market');
  const [price, setPrice] = useState('');
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const dec = priceDecimals(coin);
  const maxLev = coin?.maxLeverage ?? 50;
  useEffect(() => {
    if (leverage > maxLev) setLeverage(maxLev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxLev]);
  useEffect(() => {
    if (!pickedPrice) return;
    setPrice(pickedPrice.price.toFixed(dec));
    if (type === 'market') setType('limit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedPrice]);

  const refPrice = type === 'market' ? mark : num(price);
  const qty = orderQty(size, refPrice, coin);

  const submit = () => {
    if (!coin || !mark) return;
    const err = onSubmit({
      coin: coin.name, side, type, size: qty, price: num(price), leverage, reduceOnly,
      tp: num(tp), sl: num(sl),
    });
    setMessage(err ? { text: err, error: true } : {
      text: `${type === 'market' ? 'Filled' : 'Placed'} ${side} ${qty} ${coin.name}`, error: false,
    });
    if (!err) {
      setTp('');
      setSl('');
    }
  };

  return (
    <div className="panel ticket">
      <div className="seg">
        <button className={side === 'buy' ? 'buy active' : ''} onClick={() => setSide('buy')}>Buy / Long</button>
        <button className={side === 'sell' ? 'sell active' : ''} onClick={() => setSide('sell')}>Sell / Short</button>
      </div>
      <div className="seg small">
        {(['market', 'limit', 'stop'] as const).map((t) => (
          <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {type !== 'market' && (
        <label>
          {type === 'limit' ? 'Limit price' : 'Trigger price'}
          <div className="row">
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
            <button className="ghost" onClick={() => mark && setPrice(mark.toFixed(dec))}>Last</button>
          </div>
          <small className="hint">Tip: Alt+click the chart to pick a price</small>
        </label>
      )}
      <label>
        Size ({size.unit === 'usd' ? 'USD notional' : `${coin?.name ?? 'coin'} amount`})
        <div className="row">
          <input value={size[size.unit]} onChange={(e) => setSize({ ...size, [size.unit]: e.target.value })}
                 inputMode="decimal" />
          <button className="unit-toggle" onClick={(e) => {
            e.preventDefault();
            setSize(toggleSizeUnit(size, refPrice, coin));
          }} title="Switch between USD and coin amount">{unitLabel(size, coin)} ⇄</button>
        </div>
        <small className="hint">
          {size.unit === 'usd' ? `≈ ${qty} ${coin?.name ?? ''}` : `≈ ${fmtUsd(qty * (refPrice ?? 0))} notional`}
          {' · '}margin {fmtUsd(((qty * (refPrice ?? 0)) / leverage) || 0)}
        </small>
      </label>
      <label>
        Leverage: <b>{leverage}x</b>
        <input type="range" min={1} max={maxLev} value={leverage}
               onChange={(e) => setLeverage(+e.target.value)} />
      </label>
      <div className="row two">
        <label>Take profit<input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="price" /></label>
        <label>Stop loss<input value={sl} onChange={(e) => setSl(e.target.value)} placeholder="price" /></label>
      </div>
      <label className="check">
        <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
        Reduce only
      </label>
      <button className={`submit ${side}`} disabled={!mark || !qty} onClick={submit}>
        {side === 'buy' ? 'Buy' : 'Sell'} {type !== 'market' ? type : ''} {qty || ''} {coin?.name}
      </button>
      {message && <div className={message.error ? 'msg error' : 'msg'}>{message.text}</div>}
    </div>
  );
}

// ---- account summary -------------------------------------------------------------

export function AccountPanel({ state, label, onReset }: {
  state: PaperState; label: string; onReset(balance: number): void;
}) {
  const eq = equity(state);
  const used = usedMargin(state);
  const st = stats(state);
  // realized only: moves when a fill closes size, not with the mark price
  const totalPnl = st.realized - st.fees;
  return (
    <div className="panel account">
      <div className="panel-title">
        {label} account
        <button className="ghost" onClick={() => {
          const v = prompt('Reset account. Starting balance (USD):', String(state.startBalance));
          if (v && Number(v) > 0) onReset(Number(v));
        }}>Reset</button>
      </div>
      <dl>
        <dt>Equity</dt><dd>{fmtUsd(eq)}</dd>
        <dt>Realized PnL</dt>
        <dd className={pnlClass(totalPnl)}>
          {signed(totalPnl)} ({((totalPnl / state.startBalance) * 100).toFixed(2)}%)
        </dd>
        <dt>Balance</dt><dd>{fmtUsd(state.balance)}</dd>
        <dt>Unrealized</dt><dd className={pnlClass(eq - state.balance)}>{signed(eq - state.balance)}</dd>
        <dt>Margin used</dt><dd>{fmtUsd(used)}</dd>
        <dt>Available</dt><dd>{fmtUsd(Math.max(eq - used, 0))}</dd>
        <dt>Fees paid</dt><dd>{fmtUsd(st.fees)}</dd>
        <dt>Win rate</dt>
        <dd>{st.trades ? `${((st.wins / st.trades) * 100).toFixed(0)}% (${st.wins}/${st.trades})` : '—'}</dd>
      </dl>
    </div>
  );
}

// ---- positions / orders / history ---------------------------------------------------

interface BottomProps {
  state: PaperState;
  decimals: (coin: string) => number;
  onClose(coin: string, fraction: number): void;
  onCancel(id: string): void;
  onBrackets(coin: string, tp?: number, sl?: number): string | undefined;
}

export function BottomPanel({ state, decimals, onClose, onCancel, onBrackets }: BottomProps) {
  const [tab, setTab] = useState<'positions' | 'orders' | 'history'>('positions');
  const positions = Object.values(state.positions);
  return (
    <div className="bottom">
      <div className="tabs">
        <button className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>
          Positions ({positions.length})</button>
        <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>
          Open orders ({state.orders.length})</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          Trade history ({state.fills.length})</button>
      </div>
      <div className="table-wrap">
        {tab === 'positions' && (
          <table>
            <thead><tr><th>Coin</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Liq.</th>
              <th>uPnL (ROE)</th><th>TP / SL</th><th /></tr></thead>
            <tbody>
              {positions.map((p) => {
                const mark = state.marks[p.coin] ?? p.entry;
                const u = unrealized(p, mark);
                const roe = (u / ((Math.abs(p.size) * p.entry) / p.leverage)) * 100;
                const d = decimals(p.coin);
                const liq = liquidationPrice(state, p.coin);
                return (
                  <tr key={p.coin}>
                    <td>{p.coin} <small>{p.leverage}x</small></td>
                    <td className={p.size > 0 ? 'up' : 'down'}>{p.size > 0 ? 'Long' : 'Short'}</td>
                    <td>{Math.abs(p.size)}</td>
                    <td>{p.entry.toFixed(d)}</td>
                    <td>{mark.toFixed(d)}</td>
                    <td>{liq ? liq.toFixed(d) : '—'}</td>
                    <td className={pnlClass(u)}>{signed(u)} ({roe.toFixed(1)}%)</td>
                    <td><BracketEditor key={`${p.tp}-${p.sl}`} tp={p.tp} sl={p.sl}
                                       onSave={(tp, sl) => onBrackets(p.coin, tp, sl)} /></td>
                    <td className="actions">
                      <button onClick={() => onClose(p.coin, 0.5)}>Close 50%</button>
                      <button onClick={() => onClose(p.coin, 1)}>Close</button>
                    </td>
                  </tr>
                );
              })}
              {!positions.length && <tr><td colSpan={9} className="empty">No open positions</td></tr>}
            </tbody>
          </table>
        )}
        {tab === 'orders' && (
          <table>
            <thead><tr><th>Placed</th><th>Coin</th><th>Type</th><th>Side</th><th>Price</th><th>Size</th>
              <th>TP / SL</th><th /></tr></thead>
            <tbody>
              {state.orders.map((o) => (
                <tr key={o.id}>
                  <td>{fmtTime(o.createdAt)}</td>
                  <td>{o.coin}</td>
                  <td>{o.type}{o.reduceOnly ? ' (reduce)' : ''}</td>
                  <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side}</td>
                  <td>{o.price.toFixed(decimals(o.coin))}</td>
                  <td>{o.size}</td>
                  <td>{o.tp ?? '—'} / {o.sl ?? '—'}</td>
                  <td className="actions"><button onClick={() => onCancel(o.id)}>Cancel</button></td>
                </tr>
              ))}
              {!state.orders.length && <tr><td colSpan={8} className="empty">No open orders</td></tr>}
            </tbody>
          </table>
        )}
        {tab === 'history' && (
          <table>
            <thead><tr><th>Time (UTC)</th><th>Coin</th><th>Side</th><th>Price</th><th>Size</th>
              <th>Realized PnL</th><th>Fee</th><th>Type</th></tr></thead>
            <tbody>
              {[...state.fills].reverse().map((f) => (
                <tr key={f.id}>
                  <td>{fmtTime(f.time)}</td>
                  <td>{f.coin}</td>
                  <td className={f.side === 'buy' ? 'up' : 'down'}>{f.side}</td>
                  <td>{f.price.toFixed(decimals(f.coin))}</td>
                  <td>{f.size}</td>
                  <td className={pnlClass(f.pnl)}>{f.pnl ? signed(f.pnl) : '—'}</td>
                  <td>{fmtUsd(f.fee)}</td>
                  <td>{f.reason}</td>
                </tr>
              ))}
              {!state.fills.length && <tr><td colSpan={8} className="empty">No trades yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function BracketEditor({ tp, sl, onSave }: {
  tp?: number; sl?: number; onSave(tp?: number, sl?: number): string | undefined;
}) {
  const [t, setT] = useState(tp?.toString() ?? '');
  const [s, setS] = useState(sl?.toString() ?? '');
  const [err, setErr] = useState<string>();
  const dirty = t !== (tp?.toString() ?? '') || s !== (sl?.toString() ?? '');
  return (
    <div className="brackets" title={err}>
      <input value={t} onChange={(e) => setT(e.target.value)} placeholder="TP" />
      <input value={s} onChange={(e) => setS(e.target.value)} placeholder="SL" />
      {dirty && <button onClick={() => setErr(onSave(num(t), num(s)))}>Set</button>}
      {err && <span className="down">!</span>}
    </div>
  );
}

// ---- indicators menu ----------------------------------------------------------------

export function IndicatorMenu({ indicators, onChange, onClose }: {
  indicators: IndicatorInstance[];
  onChange(next: IndicatorInstance[]): void;
  onClose(): void;
}) {
  const patch = (id: string, fn: (i: IndicatorInstance) => IndicatorInstance) =>
    onChange(indicators.map((i) => (i.id === id ? fn(i) : i)));
  return (
    <div className="popover" onMouseDown={(e) => e.stopPropagation()}>
      <div className="panel-title">Indicators <button className="ghost" onClick={onClose}>✕</button></div>
      <div className="ind-add">
        {INDICATORS.map((d) => (
          <button key={d.type} onClick={() => onChange([...indicators, newIndicator(d.type)])}>+ {d.name}</button>
        ))}
      </div>
      <div className="ind-list">
        {indicators.map((ind) => {
          const def = indicatorDef(ind.type);
          return (
            <div key={ind.id} className="ind-row">
              <input type="checkbox" checked={!ind.hidden} title="Show"
                     onChange={(e) => patch(ind.id, (i) => ({ ...i, hidden: !e.target.checked }))} />
              <span className="ind-name">{def.name}</span>
              {def.params.map((p) => (
                <label key={p.key} className="ind-param">{p.label}
                  <input type="number" step={p.step ?? 1} value={ind.params[p.key]}
                         onChange={(e) => {
                           const v = Number(e.target.value);
                           if (v > 0) patch(ind.id, (i) => ({ ...i, params: { ...i.params, [p.key]: v } }));
                         }} />
                </label>
              ))}
              {def.outputs.map((o) => (
                <input key={o.key} type="color" value={ind.colors[o.key]} title={`${indicatorLabel(ind)} ${o.key}`}
                       onChange={(e) => patch(ind.id, (i) => ({ ...i, colors: { ...i.colors, [o.key]: e.target.value } }))} />
              ))}
              <button className="ghost" onClick={() => onChange(indicators.filter((i) => i.id !== ind.id))}>🗑</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const MAGNET_NEXT: Record<MagnetMode, MagnetMode> = { off: 'weak', weak: 'strong', strong: 'off' };

/** TradingView-style vertical drawing bar on the left of the chart. */
export function DrawingToolbar({ tool, onTool, magnet, onMagnet, keep, onKeep, visible, onVisible, onClearAll }: {
  tool: DrawingKind | null;
  onTool(kind: DrawingKind | null): void;
  magnet: MagnetMode;
  onMagnet(mode: MagnetMode): void;
  keep: boolean;
  onKeep(on: boolean): void;
  visible: boolean;
  onVisible(on: boolean): void;
  onClearAll(): void;
}) {
  return (
    <nav className="drawbar">
      <button className={tool === null ? 'active' : ''} onClick={() => onTool(null)} title="Cursor (Esc)">⌖</button>
      {DRAWING_TOOLS.map((group, i) => (
        <div key={i} className="drawbar-group">
          {group.map((t) => (
            <button key={t.kind} className={tool === t.kind ? 'active' : ''} title={t.label}
                    onClick={() => onTool(tool === t.kind ? null : t.kind)}>{t.icon}</button>
          ))}
        </div>
      ))}
      <div className="drawbar-group">
        <button className={magnet !== 'off' ? 'active' : ''} onClick={() => onMagnet(MAGNET_NEXT[magnet])}
                title={`Magnet: ${magnet} (snap to OHLC; hold Ctrl to invert)`}>
          🧲{magnet === 'strong' && <sup>S</sup>}
        </button>
        <button className={keep ? 'active' : ''} onClick={() => onKeep(!keep)}
                title="Keep drawing (tool stays selected after placing)">🔒</button>
        <button className={!visible ? 'active' : ''} onClick={() => onVisible(!visible)}
                title={visible ? 'Hide all drawings' : 'Show all drawings'}>{visible ? '👁' : '🚫'}</button>
        <button onClick={onClearAll} title="Remove all drawings on this coin">🗑</button>
      </div>
    </nav>
  );
}
