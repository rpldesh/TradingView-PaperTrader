/**
 * Market data for the chart, in either live or replay mode.
 *
 * Replay is driven by a clock, `cursorEnd`: every bar that closes at or before
 * it is visible, nothing after it is. Changing the interval keeps the clock, so
 * a replay at 2020-01-01 on the daily chart continues at 2020-01-01 on the
 * hourly chart. If the clock falls inside a higher-timeframe bar (e.g. 15:00 on
 * a daily chart), that bar is shown partially, built from lower-timeframe data.
 */

import { fetchCandles } from './api';
import { type Candle, type Interval, INTERVAL_MS, INTERVALS, type Source, floorTo } from './types';

export type Mode = 'live' | 'replay';
/** `reset`: new symbol/interval/date (view is re-framed); `reload`: same chart refreshed. */
export type ChangeKind = 'reset' | 'reload' | 'append' | 'update' | 'prepend';

/** A bar handed to the trading engine, with the time up to which it covers. */
export interface ClosedBar {
  bar: Candle;
  end: number;
}

export interface FeedListener {
  onChange(kind: ChangeKind): void;
  /** Newly elapsed market data (replay steps, live ticks) for fill simulation. */
  onBars(coin: string, bars: ClosedBar[]): void;
}

const HISTORY_BARS = 600;
const AHEAD_BARS = 800;
const PREFETCH_THRESHOLD = 200;
const HL_WS = 'wss://api.hyperliquid.xyz/ws';

/** Merge OHLCV bars (sorted) into one. */
function aggregate(bars: Candle[], time: number): Candle {
  return {
    time,
    open: bars[0].open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: bars[bars.length - 1].close,
    volume: bars.reduce((v, b) => v + b.volume, 0),
  };
}

/** Largest interval below `interval` whose grid contains both `a` and `b`. */
function finerInterval(interval: Interval, a: number, b: number): Interval {
  const dur = INTERVAL_MS[interval];
  const candidates = INTERVALS.filter((i) => INTERVAL_MS[i] < dur && a % INTERVAL_MS[i] === 0
    && b % INTERVAL_MS[i] === 0);
  return candidates[candidates.length - 1] ?? '1m';
}

export class MarketFeed {
  coin = 'BTC';
  interval: Interval = '1d';
  mode: Mode = 'live';
  source: Exclude<Source, 'auto'> = 'hyperliquid';
  note: string | null = null;
  loading = false;
  error: string | null = null;
  /** Replay clock (ms); see module docs. */
  cursorEnd = 0;
  /** Replay has caught up with the present. */
  atEnd = false;

  private all: Candle[] = []; // loaded bars, including not-yet-revealed ones in replay
  private visibleCount = 0;
  private partial: Candle | null = null;
  private aheadEnd = 0; // end of the loaded range
  private aheadPromise: Promise<void> | null = null;
  private hasOlder = true;
  private loadingOlder = false;
  private gen = 0; // bumps on every reload to discard stale async results
  private ws: WebSocket | null = null;
  private wsPing: number | undefined;
  private wsRetry: number | undefined;

  constructor(private listener: FeedListener) {}

  get dur() {
    return INTERVAL_MS[this.interval];
  }

  /** Bars to draw: revealed bars plus the partial bar, if any. */
  bars(): Candle[] {
    const visible = this.all.slice(0, this.visibleCount);
    return this.partial ? [...visible, this.partial] : visible;
  }

  lastBar(): Candle | undefined {
    return this.partial ?? this.all[this.visibleCount - 1];
  }

  private emit(kind: ChangeKind) {
    this.listener.onChange(kind);
  }

  // ---- loading --------------------------------------------------------------

  async load(coin: string, interval: Interval, mode: Mode, cursorEnd?: number,
             kind: 'reset' | 'reload' = 'reset'): Promise<void> {
    const gen = ++this.gen;
    this.closeSocket();
    Object.assign(this, {
      coin, interval, mode, loading: true, error: null, note: null, atEnd: false,
      partial: null, hasOlder: true, aheadPromise: null, loadingOlder: false,
    });
    this.emit('reset');
    try {
      if (mode === 'live') await this.loadLive(gen);
      else await this.loadReplay(gen, cursorEnd ?? Date.now());
    } catch (e) {
      if (gen !== this.gen) return;
      this.error = (e as Error).message;
      this.all = [];
      this.visibleCount = 0;
    }
    if (gen !== this.gen) return;
    this.loading = false;
    this.emit(kind);
  }

  private async loadLive(gen: number) {
    const now = Date.now();
    const res = await fetchCandles(this.coin, this.interval, now - 1000 * this.dur, now + this.dur, 'hyperliquid');
    if (gen !== this.gen) return;
    this.source = res.source;
    this.all = res.candles;
    this.visibleCount = this.all.length;
    this.aheadEnd = now;
    this.openSocket(gen);
  }

  private async loadReplay(gen: number, cursorEnd: number) {
    const now = Date.now();
    cursorEnd = Math.min(cursorEnd, floorTo(now, '1m'));
    const aligned = floorTo(cursorEnd, this.interval);
    const start = aligned - HISTORY_BARS * this.dur;
    const end = Math.min(aligned + AHEAD_BARS * this.dur, now + this.dur);
    const res = await fetchCandles(this.coin, this.interval, start, end, 'auto');
    if (gen !== this.gen) return;
    this.source = res.source; // keep one source for the whole session to avoid price seams
    this.note = res.note;
    this.all = res.candles;
    this.aheadEnd = end;
    this.cursorEnd = cursorEnd;
    this.visibleCount = this.all.filter((b) => b.time + this.dur <= cursorEnd).length;

    if (cursorEnd > aligned) {
      // Clock is inside a bar of this interval: build it from finer bars.
      const finer = finerInterval(this.interval, aligned, cursorEnd);
      const sub = await fetchCandles(this.coin, finer, aligned, cursorEnd, this.source);
      if (gen !== this.gen) return;
      if (sub.candles.length) this.partial = aggregate(sub.candles, aligned);
    }
    if (!this.all.length) this.error = `No ${this.coin} data available around this date`;
  }

  /** Fetch bars older than the loaded range (triggered by scrolling left). */
  async loadOlder(): Promise<void> {
    if (this.loadingOlder || !this.hasOlder || !this.all.length || this.loading) return;
    const gen = this.gen;
    this.loadingOlder = true;
    try {
      const first = this.all[0].time;
      const res = await fetchCandles(this.coin, this.interval, first - HISTORY_BARS * this.dur, first,
        this.source);
      if (gen !== this.gen) return;
      const older = res.candles.filter((b) => b.time < first);
      if (!older.length) {
        this.hasOlder = false;
        return;
      }
      this.all = [...older, ...this.all];
      this.visibleCount += older.length;
      this.emit('prepend');
    } catch {
      /* try again on the next scroll */
    } finally {
      if (gen === this.gen) this.loadingOlder = false;
    }
  }

  private fetchAhead(): Promise<void> {
    if (this.aheadPromise) return this.aheadPromise;
    const now = Date.now();
    if (this.aheadEnd >= now) return Promise.resolve();
    const gen = this.gen;
    const from = this.aheadEnd;
    const to = Math.min(from + AHEAD_BARS * this.dur, now + this.dur);
    this.aheadPromise = fetchCandles(this.coin, this.interval, from, to, this.source)
      .then((res) => {
        if (gen !== this.gen) return;
        const last = this.all[this.all.length - 1]?.time ?? -Infinity;
        this.all.push(...res.candles.filter((b) => b.time > last));
        this.aheadEnd = to;
      })
      .finally(() => {
        if (gen === this.gen) this.aheadPromise = null;
      });
    return this.aheadPromise;
  }

  // ---- replay -----------------------------------------------------------------

  private stepping: Promise<boolean> | null = null;

  /** Reveal the next bar. Returns false when there is nothing more to show. */
  step(): Promise<boolean> {
    // Serialise: autoplay and manual steps must never interleave.
    this.stepping ??= this.stepOnce().finally(() => {
      this.stepping = null;
    });
    return this.stepping;
  }

  private async stepOnce(): Promise<boolean> {
    if (this.mode !== 'replay' || this.loading || this.error) return false;
    const gen = this.gen;
    const now = Date.now();

    if (this.partial) {
      const barEnd = this.partial.time + this.dur;
      if (barEnd > now) return this.reachEnd();
      if (this.all.length <= this.visibleCount) await this.fetchAhead();
      if (gen !== this.gen) return false;
      const full = this.all[this.visibleCount];
      if (!full || full.time !== this.partial.time) return this.reachEnd();
      // Simulate the rest of the bar with finer data so fills see the real path.
      let rest: ClosedBar[] = [{ bar: full, end: barEnd }];
      try {
        const finer = finerInterval(this.interval, this.cursorEnd, barEnd);
        const sub = await fetchCandles(this.coin, finer, this.cursorEnd, barEnd, this.source);
        if (sub.candles.length) {
          rest = sub.candles.map((b) => ({ bar: b, end: b.time + INTERVAL_MS[finer] }));
        }
      } catch {
        /* fall back to the whole bar */
      }
      if (gen !== this.gen) return false;
      this.partial = null;
      this.visibleCount++;
      this.cursorEnd = barEnd;
      this.listener.onBars(this.coin, rest);
      this.emit('update');
      return true;
    }

    if (this.all.length - this.visibleCount < PREFETCH_THRESHOLD) {
      const pending = this.fetchAhead().catch(() => undefined);
      if (this.visibleCount >= this.all.length) await pending;
      if (gen !== this.gen) return false;
    }
    const bar = this.all[this.visibleCount];
    if (!bar || bar.time + this.dur > now) return this.reachEnd();
    this.visibleCount++;
    this.cursorEnd = bar.time + this.dur;
    this.listener.onBars(this.coin, [{ bar, end: this.cursorEnd }]);
    this.emit('append');
    return true;
  }

  private reachEnd(): boolean {
    this.atEnd = true;
    this.emit('update');
    return false;
  }

  /** Bars already revealed but not yet simulated (after switching back to a coin). */
  unprocessedBars(since: number): ClosedBar[] {
    return this.all
      .slice(0, this.visibleCount)
      .filter((b) => b.time >= since)
      .map((b) => ({ bar: b, end: b.time + this.dur }));
  }

  // ---- live -------------------------------------------------------------------

  private openSocket(gen: number) {
    const ws = new WebSocket(HL_WS);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'candle', coin: this.coin, interval: this.interval },
      }));
      this.wsPing = window.setInterval(() => ws.send(JSON.stringify({ method: 'ping' })), 30_000);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.gen) return;
      const msg = JSON.parse(ev.data);
      if (msg.channel !== 'candle') return;
      const c = msg.data;
      if (c.s !== this.coin || c.i !== this.interval) return;
      const bar: Candle = {
        time: c.t, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v,
      };
      const last = this.all[this.all.length - 1];
      let kind: ChangeKind;
      if (last && last.time === bar.time) {
        this.all[this.all.length - 1] = bar;
        kind = 'update';
      } else if (!last || bar.time > last.time) {
        this.all.push(bar);
        this.visibleCount = this.all.length;
        kind = 'append';
      } else {
        return;
      }
      const tick = { time: bar.time, open: bar.close, high: bar.close, low: bar.close, close: bar.close, volume: 0 };
      this.listener.onBars(this.coin, [{ bar: tick, end: Date.now() }]);
      this.emit(kind);
    };
    ws.onclose = () => {
      window.clearInterval(this.wsPing);
      if (gen !== this.gen || this.ws !== ws) return;
      // Reconnect and backfill anything missed while disconnected.
      this.wsRetry = window.setTimeout(() => {
        if (gen === this.gen) this.load(this.coin, this.interval, 'live', undefined, 'reload');
      }, 3000);
    };
  }

  private closeSocket() {
    window.clearInterval(this.wsPing);
    window.clearTimeout(this.wsRetry);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  dispose() {
    this.gen++;
    this.closeSocket();
  }
}
