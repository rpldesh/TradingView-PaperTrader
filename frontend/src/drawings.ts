import type { DrawingKind, DrawingManager } from 'lightweight-charts-drawing';
import { loadState, saveState } from './api';

export interface DrawingTool {
  kind: DrawingKind;
  icon: string;
  label: string;
}

/** Tools on the left drawing bar, grouped like TradingView's (lines, shapes, fib, trading, notes). */
export const DRAWING_TOOLS: DrawingTool[][] = [
  [
    { kind: 'trend-line', icon: '╱', label: 'Trend line' },
    { kind: 'ray', icon: '↗', label: 'Ray' },
    { kind: 'horizontal-line', icon: '─', label: 'Horizontal line' },
    { kind: 'horizontal-ray', icon: '⟶', label: 'Horizontal ray' },
    { kind: 'vertical-line', icon: '│', label: 'Vertical line' },
    { kind: 'parallel-channel', icon: '⫽', label: 'Parallel channel' },
  ],
  [
    { kind: 'rectangle', icon: '▭', label: 'Rectangle' },
    { kind: 'circle', icon: '◯', label: 'Circle' },
    { kind: 'arrow', icon: '➚', label: 'Arrow' },
  ],
  [
    { kind: 'fib-retracement', icon: '𝐅', label: 'Fib retracement' },
    { kind: 'trend-based-fib-extension', icon: '𝐅⁺', label: 'Trend-based fib extension' },
  ],
  [
    { kind: 'long-position', icon: '▲', label: 'Long position' },
    { kind: 'short-position', icon: '▼', label: 'Short position' },
    { kind: 'price-range', icon: '↕', label: 'Price range' },
    { kind: 'date-and-price-range', icon: '⤡', label: 'Date and price range' },
  ],
  [
    { kind: 'text', icon: 'T', label: 'Text' },
    { kind: 'brush', icon: '✎', label: 'Brush' },
  ],
];

/**
 * Keeps the chart's drawings in the backend state store, one list per coin
 * (drawings are anchored to time/price, so they survive interval changes).
 * Saves are debounced; switching coin or closing the page flushes them.
 */
export class DrawingSync {
  private coin: string | null = null; // null while a coin's drawings are loading
  private loadToken = 0;
  private pending: { coin: string; data: unknown } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly off: () => void;

  constructor(private manager: DrawingManager) {
    this.off = manager.on('change', () => this.changed());
    window.addEventListener('pagehide', this.flush);
  }

  async load(coin: string) {
    if (coin === this.coin) return;
    this.flush();
    this.coin = null;
    const token = ++this.loadToken;
    this.manager.setTool(null);
    this.manager.clear();
    const saved = await loadState<unknown[]>(`drawings-${coin}`);
    if (token !== this.loadToken) return; // another coin was picked meanwhile
    if (saved) this.manager.importJSON(saved);
    this.coin = coin;
  }

  private changed() {
    if (!this.coin) return;
    this.pending = { coin: this.coin, data: JSON.parse(this.manager.exportJSON()) };
    clearTimeout(this.timer);
    this.timer = setTimeout(this.flush, 400);
  }

  flush = () => {
    clearTimeout(this.timer);
    if (!this.pending) return;
    saveState(`drawings-${this.pending.coin}`, this.pending.data);
    this.pending = null;
  };

  dispose() {
    this.flush();
    this.off();
    window.removeEventListener('pagehide', this.flush);
  }
}
