/**
 * Paper-trading engine (perp-style, cross margin, one net position per coin).
 *
 * All functions are pure: they take a state and return a new one. Fills are
 * simulated from OHLC bars: pending orders trigger when a bar trades through
 * their price (filled at the bar open if it gaps through), and when a bar hits
 * both a position's TP and SL the SL is assumed to fill first.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';

export interface Position {
  coin: string;
  size: number; // signed: > 0 long, < 0 short
  entry: number;
  leverage: number;
  tp?: number;
  sl?: number;
  openedAt: number;
}

export interface Order {
  id: string;
  coin: string;
  side: Side;
  type: 'limit' | 'stop';
  price: number;
  size: number; // coin quantity, always positive
  leverage: number;
  reduceOnly: boolean;
  tp?: number;
  sl?: number;
  createdAt: number;
}

export type FillReason = 'market' | 'limit' | 'stop' | 'tp' | 'sl' | 'liquidation' | 'close';

export interface Fill {
  id: string;
  coin: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  pnl: number; // realized PnL from the closed portion, before fees
  time: number;
  reason: FillReason;
}

export interface PaperState {
  startBalance: number;
  balance: number; // cash: deposits + realized PnL - fees
  takerFee: number; // fraction, e.g. 0.00045
  makerFee: number;
  positions: Record<string, Position>;
  orders: Order[];
  fills: Fill[];
  marks: Record<string, number>; // last seen price per coin
  processedUntil: Record<string, number>; // ms; bars before this are already simulated
}

export interface OrderRequest {
  coin: string;
  side: Side;
  type: OrderType;
  size: number;
  price?: number;
  leverage: number;
  reduceOnly?: boolean;
  tp?: number;
  sl?: number;
}

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const MAINTENANCE = 0.5; // maintenance margin = 50% of initial margin (Hyperliquid's convention)

let idSeq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function newPaperState(balance = 10_000): PaperState {
  return {
    startBalance: balance, balance, takerFee: 0.00045, makerFee: 0.00015,
    positions: {}, orders: [], fills: [], marks: {}, processedUntil: {},
  };
}

const clone = (s: PaperState): PaperState => structuredClone(s);

// ---- account metrics ---------------------------------------------------------

export const unrealized = (p: Position, mark: number) => p.size * (mark - p.entry);

export function equity(s: PaperState): number {
  return Object.values(s.positions).reduce(
    (eq, p) => eq + unrealized(p, s.marks[p.coin] ?? p.entry), s.balance);
}

const positionMargin = (p: Position, mark: number) => (Math.abs(p.size) * mark) / p.leverage;

export function usedMargin(s: PaperState, exclude?: string): number {
  return Object.values(s.positions)
    .filter((p) => p.coin !== exclude)
    .reduce((m, p) => m + positionMargin(p, s.marks[p.coin] ?? p.entry), 0);
}

/** Price at which `coin`'s position gets liquidated, holding other positions at their marks. */
export function liquidationPrice(s: PaperState, coin: string): number | null {
  const pos = s.positions[coin];
  if (!pos) return null;
  const others = Object.values(s.positions).filter((p) => p.coin !== coin);
  const cushion = others.reduce((b, p) => {
    const mark = s.marks[p.coin] ?? p.entry;
    return b + unrealized(p, mark) - positionMargin(p, mark) * MAINTENANCE;
  }, s.balance);
  const mm = MAINTENANCE / pos.leverage;
  const q = Math.abs(pos.size);
  const price = pos.size > 0
    ? (q * pos.entry - cushion) / (q * (1 - mm))
    : (cushion + q * pos.entry) / (q * (1 + mm));
  return price > 0 && Number.isFinite(price) ? price : null;
}

// ---- execution -------------------------------------------------------------

interface FillArgs {
  coin: string;
  side: Side;
  size: number;
  price: number;
  time: number;
  reason: FillReason;
  feeRate: number;
  leverage?: number;
  tp?: number;
  sl?: number;
}

/** Applies a fill to the (mutable) state: updates the position, balance and fill log. */
function applyFill(s: PaperState, f: FillArgs): void {
  const pos = s.positions[f.coin];
  const qty = f.side === 'buy' ? f.size : -f.size;
  let pnl = 0;

  if (!pos) {
    s.positions[f.coin] = {
      coin: f.coin, size: qty, entry: f.price, leverage: f.leverage ?? 1,
      tp: f.tp, sl: f.sl, openedAt: f.time,
    };
  } else if (Math.sign(pos.size) === Math.sign(qty)) {
    const newSize = pos.size + qty;
    pos.entry = (Math.abs(pos.size) * pos.entry + Math.abs(qty) * f.price) / Math.abs(newSize);
    pos.size = newSize;
    if (f.leverage) pos.leverage = f.leverage;
    if (f.tp !== undefined) pos.tp = f.tp;
    if (f.sl !== undefined) pos.sl = f.sl;
  } else {
    const closing = Math.min(Math.abs(pos.size), Math.abs(qty));
    pnl = closing * (f.price - pos.entry) * Math.sign(pos.size);
    const remaining = pos.size + qty;
    if (Math.abs(remaining) < 1e-12) {
      delete s.positions[f.coin];
    } else if (Math.sign(remaining) === Math.sign(pos.size)) {
      pos.size = remaining;
    } else {
      // Flipped through zero: the excess opens a fresh position.
      s.positions[f.coin] = {
        coin: f.coin, size: remaining, entry: f.price, leverage: f.leverage ?? pos.leverage,
        tp: f.tp, sl: f.sl, openedAt: f.time,
      };
    }
  }

  const fee = f.size * f.price * f.feeRate;
  s.balance += pnl - fee;
  s.marks[f.coin] ??= f.price;
  s.fills.push({
    id: uid('f'), coin: f.coin, side: f.side, price: f.price, size: f.size,
    fee, pnl, time: f.time, reason: f.reason,
  });
  if (!s.positions[f.coin]) {
    // Flat: reduce-only orders for this coin no longer have anything to reduce.
    s.orders = s.orders.filter((o) => !(o.coin === f.coin && o.reduceOnly));
  }
}

/** Clamp a reduce-only size to the open position; 0 means it would not reduce anything. */
function reduceOnlySize(s: PaperState, coin: string, side: Side, size: number): number {
  const pos = s.positions[coin];
  if (!pos || (side === 'buy') === pos.size > 0) return 0;
  return Math.min(size, Math.abs(pos.size));
}

/** Margin check for a prospective fill. Returns an error message or null. */
function marginError(s: PaperState, coin: string, side: Side, size: number, price: number,
                     leverage: number, feeRate: number): string | null {
  const pos = s.positions[coin];
  const current = pos?.size ?? 0;
  const next = current + (side === 'buy' ? size : -size);
  const reducing = Math.abs(next) <= Math.abs(current) && Math.sign(next) !== -Math.sign(current);
  if (reducing) return null;
  // Margin for the resulting position, against equity excluding margin locked by other coins.
  const required = (Math.abs(next) * price) / leverage + size * price * feeRate;
  const ownPnl = pos ? unrealized(pos, price) : 0;
  const available = s.balance + ownPnl + othersUnrealized(s, coin) - usedMargin(s, coin);
  return required > available
    ? `Insufficient margin: need ${required.toFixed(2)}, available ${Math.max(available, 0).toFixed(2)}`
    : null;
}

function othersUnrealized(s: PaperState, coin: string): number {
  return Object.values(s.positions)
    .filter((p) => p.coin !== coin)
    .reduce((u, p) => u + unrealized(p, s.marks[p.coin] ?? p.entry), 0);
}

function validateBrackets(side: Side, ref: number, tp?: number, sl?: number): string | null {
  if (side === 'buy') {
    if (tp !== undefined && tp <= ref) return 'Take-profit for a long must be above the entry price';
    if (sl !== undefined && sl >= ref) return 'Stop-loss for a long must be below the entry price';
  } else {
    if (tp !== undefined && tp >= ref) return 'Take-profit for a short must be below the entry price';
    if (sl !== undefined && sl <= ref) return 'Stop-loss for a short must be above the entry price';
  }
  return null;
}

export function placeOrder(
  state: PaperState, req: OrderRequest, mark: number, time: number,
): { state: PaperState; error?: string } {
  if (!(req.size > 0)) return { state, error: 'Size must be positive' };
  if (req.type !== 'market' && !(req.price! > 0)) return { state, error: 'Enter a price' };

  const s = clone(state);
  s.marks[req.coin] = mark;
  let size = req.size;
  if (req.reduceOnly) {
    size = reduceOnlySize(s, req.coin, req.side, size);
    if (!size) return { state, error: 'Reduce-only order would not reduce a position' };
  }

  // Marketable limits and already-triggered stops execute immediately at the mark.
  const immediate = req.type === 'market'
    || (req.type === 'limit' && (req.side === 'buy' ? req.price! >= mark : req.price! <= mark))
    || (req.type === 'stop' && (req.side === 'buy' ? mark >= req.price! : mark <= req.price!));
  const refPrice = immediate ? mark : req.price!;

  const bracketError = validateBrackets(req.side, refPrice, req.tp, req.sl);
  if (bracketError) return { state, error: bracketError };

  if (immediate) {
    const err = marginError(s, req.coin, req.side, size, mark, req.leverage, s.takerFee);
    if (err) return { state, error: err };
    applyFill(s, {
      coin: req.coin, side: req.side, size, price: mark, time, reason: req.type,
      feeRate: s.takerFee, leverage: req.leverage, tp: req.tp, sl: req.sl,
    });
    return { state: s };
  }

  if (!req.reduceOnly) {
    const err = marginError(s, req.coin, req.side, size, req.price!, req.leverage, s.makerFee);
    if (err) return { state, error: err };
  }
  s.orders.push({
    id: uid('o'), coin: req.coin, side: req.side, type: req.type as 'limit' | 'stop',
    price: req.price!, size, leverage: req.leverage, reduceOnly: !!req.reduceOnly,
    tp: req.tp, sl: req.sl, createdAt: time,
  });
  return { state: s };
}

export function cancelOrder(state: PaperState, id: string): PaperState {
  return { ...state, orders: state.orders.filter((o) => o.id !== id) };
}

export function closePosition(state: PaperState, coin: string, mark: number, time: number,
                              fraction = 1): PaperState {
  const pos = state.positions[coin];
  if (!pos) return state;
  const s = clone(state);
  s.marks[coin] = mark;
  applyFill(s, {
    coin, side: pos.size > 0 ? 'sell' : 'buy', size: Math.abs(pos.size) * fraction,
    price: mark, time, reason: 'close', feeRate: s.takerFee,
  });
  return s;
}

export function setBrackets(state: PaperState, coin: string, tp?: number, sl?: number):
  { state: PaperState; error?: string } {
  const pos = state.positions[coin];
  if (!pos) return { state };
  const mark = state.marks[coin] ?? pos.entry;
  const err = validateBrackets(pos.size > 0 ? 'buy' : 'sell', mark, tp, sl);
  if (err) return { state, error: err.replace('the entry price', 'the current price') };
  return { state: { ...state, positions: { ...state.positions, [coin]: { ...pos, tp, sl } } } };
}

/**
 * Simulates one bar for `coin`. `end` is the bar's close time; it is recorded so
 * the same period is never simulated twice.
 */
export function processBar(state: PaperState, coin: string, bar: Bar, end: number): PaperState {
  const hasWork = state.positions[coin] || state.orders.some((o) => o.coin === coin);
  if (!hasWork) {
    return {
      ...state,
      marks: { ...state.marks, [coin]: bar.close },
      processedUntil: { ...state.processedUntil, [coin]: end },
    };
  }
  const s = clone(state);

  // 1) Brackets on the position that existed before this bar.
  const pos = s.positions[coin];
  if (pos && (pos.tp !== undefined || pos.sl !== undefined)) {
    const long = pos.size > 0;
    const exitSide: Side = long ? 'sell' : 'buy';
    const slHit = pos.sl !== undefined && (long ? bar.low <= pos.sl : bar.high >= pos.sl);
    const tpHit = pos.tp !== undefined && (long ? bar.high >= pos.tp : bar.low <= pos.tp);
    const gapSl = pos.sl !== undefined && (long ? bar.open <= pos.sl : bar.open >= pos.sl);
    const gapTp = pos.tp !== undefined && (long ? bar.open >= pos.tp : bar.open <= pos.tp);
    let exit: { price: number; reason: FillReason } | null = null;
    if (gapSl) exit = { price: bar.open, reason: 'sl' };
    else if (gapTp) exit = { price: bar.open, reason: 'tp' };
    else if (slHit) exit = { price: pos.sl!, reason: 'sl' };
    else if (tpHit) exit = { price: pos.tp!, reason: 'tp' };
    if (exit) {
      applyFill(s, {
        coin, side: exitSide, size: Math.abs(pos.size), price: exit.price, time: bar.time,
        reason: exit.reason, feeRate: s.takerFee,
      });
    }
  }

  // 2) Pending orders, oldest first.
  for (const order of [...s.orders]) {
    if (order.coin !== coin || !s.orders.includes(order)) continue;
    const buy = order.side === 'buy';
    let price: number | null = null;
    if (order.type === 'limit') {
      if (buy ? bar.low <= order.price : bar.high >= order.price) {
        price = buy ? Math.min(order.price, bar.open) : Math.max(order.price, bar.open);
      }
    } else if (buy ? bar.high >= order.price : bar.low <= order.price) {
      price = buy ? Math.max(order.price, bar.open) : Math.min(order.price, bar.open);
    }
    if (price === null) continue;
    s.orders = s.orders.filter((o) => o.id !== order.id);
    let size = order.size;
    if (order.reduceOnly) {
      size = reduceOnlySize(s, coin, order.side, size);
      if (!size) continue;
    }
    const feeRate = order.type === 'limit' ? s.makerFee : s.takerFee;
    if (!order.reduceOnly && marginError(s, coin, order.side, size, price, order.leverage, feeRate)) continue;
    applyFill(s, {
      coin, side: order.side, size, price, time: bar.time, reason: order.type, feeRate,
      leverage: order.leverage, tp: order.tp, sl: order.sl,
    });
  }

  // 3) Liquidation at the bar's worst price for the position.
  const liq = liquidationPrice(s, coin);
  const live = s.positions[coin];
  if (live && liq !== null && (live.size > 0 ? bar.low <= liq : bar.high >= liq)) {
    const gapped = live.size > 0 ? bar.open <= liq : bar.open >= liq;
    applyFill(s, {
      coin, side: live.size > 0 ? 'sell' : 'buy', size: Math.abs(live.size),
      price: gapped ? bar.open : liq, time: bar.time, reason: 'liquidation', feeRate: s.takerFee,
    });
  }

  s.marks[coin] = bar.close;
  s.processedUntil[coin] = end;
  return s;
}

export interface TradeStats {
  trades: number;
  wins: number;
  realized: number;
  fees: number;
}

export function stats(s: PaperState): TradeStats {
  const closing = s.fills.filter((f) => f.pnl !== 0);
  return {
    trades: closing.length,
    wins: closing.filter((f) => f.pnl > 0).length,
    realized: s.fills.reduce((a, f) => a + f.pnl, 0),
    fees: s.fills.reduce((a, f) => a + f.fee, 0),
  };
}
