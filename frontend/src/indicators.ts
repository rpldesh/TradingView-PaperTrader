import type { Candle } from './types';

export type Series = (number | undefined)[];

export interface ParamDef {
  key: string;
  label: string;
  default: number;
  step?: number;
}

export interface OutputDef {
  key: string;
  kind: 'line' | 'histogram';
  color: string;
  /** Per-bar colour: by the value's sign, or by the candle's direction. */
  colorBy?: 'sign' | 'candle';
}

export interface IndicatorDef {
  type: string;
  name: string;
  overlay: boolean; // drawn on the price pane, otherwise in its own pane
  ownScale?: boolean; // overlay on a separate scale squeezed to the bottom (volume)
  params: ParamDef[];
  outputs: OutputDef[];
  levels?: number[]; // horizontal guide lines (e.g. RSI 70/30)
  compute(bars: Candle[], p: Record<string, number>): Record<string, Series>;
}

export interface IndicatorInstance {
  id: string;
  type: string;
  params: Record<string, number>;
  colors: Record<string, string>;
  hidden?: boolean;
}

// ---- math helpers ----------------------------------------------------------

function sma(values: number[], len: number): Series {
  const out: Series = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

/** SMA over a series whose leading values may be undefined. */
function smaDefined(values: Series, len: number): Series {
  const first = values.findIndex((v) => v !== undefined);
  if (first < 0) return values.map(() => undefined);
  return [...new Array(first).fill(undefined), ...sma(values.slice(first) as number[], len)];
}

function ema(values: Series, len: number): Series {
  const out: Series = new Array(values.length).fill(undefined);
  const k = 2 / (len + 1);
  let prev: number | undefined;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === undefined) continue;
    if (prev === undefined) {
      // Seed with an SMA of the first `len` defined values.
      seed += v;
      count++;
      if (count === len) out[i] = prev = seed / len;
    } else {
      out[i] = prev = v * k + prev * (1 - k);
    }
  }
  return out;
}

/** Wilder's smoothing (RMA), used by RSI and ATR. */
function rma(values: number[], len: number): Series {
  const out: Series = new Array(values.length).fill(undefined);
  let prev: number | undefined;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    if (prev === undefined) {
      seed += values[i];
      if (i === len - 1) out[i] = prev = seed / len;
    } else {
      out[i] = prev = (prev * (len - 1) + values[i]) / len;
    }
  }
  return out;
}

function stdev(values: number[], mean: Series, len: number): Series {
  return mean.map((m, i) => {
    if (m === undefined) return undefined;
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) s += (values[j] - m) ** 2;
    return Math.sqrt(s / len);
  });
}

const closes = (bars: Candle[]) => bars.map((b) => b.close);

function trueRange(bars: Candle[]): number[] {
  return bars.map((b, i) =>
    i === 0
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)),
  );
}

// ---- indicator catalogue ---------------------------------------------------

export const INDICATORS: IndicatorDef[] = [
  {
    type: 'volume', name: 'Volume', overlay: true, ownScale: true,
    params: [],
    outputs: [{ key: 'volume', kind: 'histogram', color: '#26a69a', colorBy: 'candle' }],
    compute: (bars) => ({ volume: bars.map((b) => b.volume) }),
  },
  {
    type: 'sma', name: 'SMA', overlay: true,
    params: [{ key: 'length', label: 'Length', default: 20 }],
    outputs: [{ key: 'sma', kind: 'line', color: '#f5a623' }],
    compute: (bars, p) => ({ sma: sma(closes(bars), p.length) }),
  },
  {
    type: 'ema', name: 'EMA', overlay: true,
    params: [{ key: 'length', label: 'Length', default: 50 }],
    outputs: [{ key: 'ema', kind: 'line', color: '#2fa8ff' }],
    compute: (bars, p) => ({ ema: ema(closes(bars), p.length) }),
  },
  {
    type: 'bb', name: 'Bollinger Bands', overlay: true,
    params: [
      { key: 'length', label: 'Length', default: 20 },
      { key: 'mult', label: 'StdDev', default: 2, step: 0.1 },
    ],
    outputs: [
      { key: 'upper', kind: 'line', color: '#8e7cc3' },
      { key: 'basis', kind: 'line', color: '#e06666' },
      { key: 'lower', kind: 'line', color: '#8e7cc3' },
    ],
    compute: (bars, p) => {
      const c = closes(bars);
      const basis = sma(c, p.length);
      const sd = stdev(c, basis, p.length);
      return {
        basis,
        upper: basis.map((m, i) => (m === undefined ? undefined : m + p.mult * sd[i]!)),
        lower: basis.map((m, i) => (m === undefined ? undefined : m - p.mult * sd[i]!)),
      };
    },
  },
  {
    type: 'vwap', name: 'VWAP (daily)', overlay: true,
    params: [],
    outputs: [{ key: 'vwap', kind: 'line', color: '#e91e63' }],
    compute: (bars) => {
      let day = -1;
      let pv = 0;
      let vol = 0;
      return {
        vwap: bars.map((b) => {
          const d = Math.floor(b.time / 86_400_000);
          if (d !== day) {
            day = d;
            pv = 0;
            vol = 0;
          }
          const typical = (b.high + b.low + b.close) / 3;
          pv += typical * b.volume;
          vol += b.volume;
          return vol > 0 ? pv / vol : typical;
        }),
      };
    },
  },
  {
    type: 'rsi', name: 'RSI', overlay: false,
    params: [{ key: 'length', label: 'Length', default: 14 }],
    outputs: [{ key: 'rsi', kind: 'line', color: '#7e57c2' }],
    levels: [70, 30],
    compute: (bars, p) => {
      const c = closes(bars);
      const gains = c.map((v, i) => (i === 0 ? 0 : Math.max(v - c[i - 1], 0)));
      const losses = c.map((v, i) => (i === 0 ? 0 : Math.max(c[i - 1] - v, 0)));
      const ag = rma(gains.slice(1), p.length);
      const al = rma(losses.slice(1), p.length);
      const rsi: Series = [undefined];
      for (let i = 0; i < ag.length; i++) {
        const g = ag[i];
        const l = al[i];
        rsi.push(g === undefined || l === undefined ? undefined : l === 0 ? 100 : 100 - 100 / (1 + g / l));
      }
      return { rsi };
    },
  },
  {
    type: 'macd', name: 'MACD', overlay: false,
    params: [
      { key: 'fast', label: 'Fast', default: 12 },
      { key: 'slow', label: 'Slow', default: 26 },
      { key: 'signal', label: 'Signal', default: 9 },
    ],
    outputs: [
      { key: 'hist', kind: 'histogram', color: '#26a69a', colorBy: 'sign' },
      { key: 'macd', kind: 'line', color: '#2962ff' },
      { key: 'signal', kind: 'line', color: '#ff6d00' },
    ],
    compute: (bars, p) => {
      const c = closes(bars);
      const fast = ema(c, p.fast);
      const slow = ema(c, p.slow);
      const macd = fast.map((f, i) => (f === undefined || slow[i] === undefined ? undefined : f - slow[i]!));
      const signal = ema(macd, p.signal);
      const hist = macd.map((m, i) => (m === undefined || signal[i] === undefined ? undefined : m - signal[i]!));
      return { macd, signal, hist };
    },
  },
  {
    type: 'stoch', name: 'Stochastic', overlay: false,
    params: [
      { key: 'k', label: '%K', default: 14 },
      { key: 'smooth', label: '%K smooth', default: 3 },
      { key: 'd', label: '%D', default: 3 },
    ],
    outputs: [
      { key: 'k', kind: 'line', color: '#2962ff' },
      { key: 'd', kind: 'line', color: '#ff6d00' },
    ],
    levels: [80, 20],
    compute: (bars, p) => {
      const raw: Series = bars.map((b, i) => {
        if (i < p.k - 1) return undefined;
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - p.k + 1; j <= i; j++) {
          hh = Math.max(hh, bars[j].high);
          ll = Math.min(ll, bars[j].low);
        }
        return hh === ll ? 50 : ((b.close - ll) / (hh - ll)) * 100;
      });
      const k = smaDefined(raw, p.smooth);
      return { k, d: smaDefined(k, p.d) };
    },
  },
  {
    type: 'atr', name: 'ATR', overlay: false,
    params: [{ key: 'length', label: 'Length', default: 14 }],
    outputs: [{ key: 'atr', kind: 'line', color: '#ef5350' }],
    compute: (bars, p) => ({ atr: rma(trueRange(bars), p.length) }),
  },
];

export const indicatorDef = (type: string) => INDICATORS.find((d) => d.type === type)!;

let seq = 0;
export function newIndicator(type: string): IndicatorInstance {
  const def = indicatorDef(type);
  return {
    id: `${type}-${Date.now().toString(36)}-${seq++}`,
    type,
    params: Object.fromEntries(def.params.map((p) => [p.key, p.default])),
    colors: Object.fromEntries(def.outputs.map((o) => [o.key, o.color])),
  };
}

export const indicatorLabel = (ind: IndicatorInstance) => {
  const def = indicatorDef(ind.type);
  const args = def.params.map((p) => ind.params[p.key]).join(', ');
  return args ? `${def.name} (${args})` : def.name;
};

export const DEFAULT_INDICATORS: IndicatorInstance[] = [
  newIndicator('volume'), newIndicator('ema'), newIndicator('rsi'),
];
