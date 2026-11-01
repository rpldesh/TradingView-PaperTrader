import type { CandleResponse, CoinInfo, Interval, Source } from './types';

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      detail = (await resp.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(detail);
  }
  return resp.json();
}

export function fetchCandles(
  coin: string, interval: Interval, start: number, end: number, source: Source = 'auto',
): Promise<CandleResponse> {
  const q = new URLSearchParams({
    coin, interval, start: String(Math.floor(start)), end: String(Math.floor(end)), source,
  });
  return fetch(`/api/candles?${q}`).then((r) => json<CandleResponse>(r));
}

export const fetchCoins = () => fetch('/api/coins').then((r) => json<CoinInfo[]>(r));

export const loadState = <T>(name: string) =>
  fetch(`/api/state/${name}`).then((r) => json<T | null>(r)).catch(() => null);

export const saveState = (name: string, value: unknown) =>
  fetch(`/api/state/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    keepalive: true, // lets saves triggered on page close complete
  }).catch(() => undefined);
