export interface Candle {
  time: number; // open time, ms epoch (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Source = 'auto' | 'hyperliquid' | 'binance';

export interface CandleResponse {
  coin: string;
  interval: string;
  source: Exclude<Source, 'auto'>;
  hyperliquidEarliest: number | null;
  note: string | null;
  candles: Candle[];
}

export interface CoinInfo {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

export const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000,
  '12h': 43_200_000, '1d': 86_400_000,
};

export const floorTo = (t: number, interval: Interval) =>
  Math.floor(t / INTERVAL_MS[interval]) * INTERVAL_MS[interval];
