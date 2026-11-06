import {
  CandlestickSeries,
  type CandlestickData,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  LineSeries,
  LineStyle,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import { DrawingManager } from 'lightweight-charts-drawing';
import { type IndicatorInstance, indicatorDef, indicatorLabel, type Series } from './indicators';
import type { ChangeKind } from './feed';
import type { Candle } from './types';

const UP = '#26a69a';
const DOWN = '#ef5350';
const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export interface PriceLineSpec {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

export interface MarkerSpec {
  time: number; // ms, already floored to the chart interval
  side: 'buy' | 'sell';
  text: string;
}

interface IndicatorSeries {
  instance: IndicatorInstance;
  series: Record<string, ISeriesApi<'Line' | 'Histogram'>>;
}

export interface ChartCallbacks {
  /** Plain click on the chart with the clicked bar's time (ms) and price. */
  onClick(time: number | null, price: number | null, alt: boolean): void;
  onNeedOlder(): void;
}

export class ChartController {
  private chart: IChartApi;
  private candles: ISeriesApi<'Candlestick'>;
  private indicators: IndicatorSeries[] = [];
  private priceLines: IPriceLine[] = [];
  private markers: ISeriesMarkersPluginApi<Time>;
  private bars: Candle[] = [];
  private altDown = false;
  private onDrawing = false; // the mouse went down while drawing or on a drawing
  readonly drawings: DrawingManager;

  constructor(container: HTMLElement, private legend: HTMLElement, private cb: ChartCallbacks) {
    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#b2b5be',
        fontSize: 12,
        panes: { separatorColor: '#2a2e39', enableResize: true },
      },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 8 },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
    });
    this.markers = createSeriesMarkers(this.candles, []);
    this.drawings = new DrawingManager(this.chart, this.candles);

    this.chart.subscribeCrosshairMove((p) => this.updateLegend(p));
    this.chart.subscribeClick((p) => {
      if (this.onDrawing) return; // placing / selecting a drawing is not a chart click
      const time = p.time !== undefined ? (p.time as number) * 1000 : null;
      const price = p.point ? this.candles.coordinateToPrice(p.point.y) : null;
      this.cb.onClick(time, price, this.altDown);
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && range.from < 20 && this.bars.length) this.cb.onNeedOlder();
    });
    // Capture on the container runs before the drawing manager's own pointerdown (on the chart element).
    container.addEventListener('pointerdown', (e) => {
      this.altDown = e.altKey;
      this.onDrawing = this.drawings.tool() !== null || this.drawings.hoveredId() !== null;
    }, true);
  }

  setPrecision(decimals: number) {
    this.candles.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals },
    });
  }

  // ---- data -------------------------------------------------------------------

  setBars(bars: Candle[], kind: ChangeKind) {
    const prevLen = this.bars.length;
    this.bars = bars;
    if (kind === 'reset' || kind === 'reload' || kind === 'prepend' || !bars.length || bars.length < prevLen) {
      this.candles.setData(bars.map(toCandle));
      for (const ind of this.indicators) this.fillIndicator(ind);
      // New symbol/date/interval: frame the new data instead of keeping the old view.
      if (kind === 'reset') this.resetView();
    } else {
      const last = bars[bars.length - 1];
      if (kind === 'append' && bars.length >= 2 && bars.length > prevLen) {
        // The previous bar may have been finalised (live) — push it too.
        this.candles.update(toCandle(bars[bars.length - 2]));
      }
      this.candles.update(toCandle(last));
      for (const ind of this.indicators) this.updateIndicatorTail(ind, kind === 'append' ? 2 : 1);
    }
    this.updateLegend();
  }

  /**
   * TradingView-style "reset chart view": re-enable auto-scale on every price
   * scale (dragging an axis turns it off) and scroll back to the latest bars.
   */
  resetView() {
    this.candles.priceScale().applyOptions({ autoScale: true });
    for (const ind of this.indicators) {
      for (const s of Object.values(ind.series)) s.priceScale().applyOptions({ autoScale: true });
    }
    const n = this.bars.length;
    if (n) this.chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 8 });
  }

  // ---- indicators -------------------------------------------------------------

  setIndicators(instances: IndicatorInstance[]) {
    for (const ind of this.indicators) {
      for (const s of Object.values(ind.series)) this.chart.removeSeries(s);
    }
    this.indicators = [];
    let nextPane = 1;
    for (const instance of instances) {
      if (instance.hidden) continue;
      const def = indicatorDef(instance.type);
      const pane = def.overlay ? 0 : nextPane++;
      const label = indicatorLabel(instance);
      const series: IndicatorSeries['series'] = {};
      for (const out of def.outputs) {
        const common = {
          color: instance.colors[out.key] ?? out.color,
          priceLineVisible: false,
          lastValueVisible: !def.ownScale,
          title: def.overlay ? '' : out === def.outputs[0] ? label : '',
          priceScaleId: def.ownScale ? `scale-${instance.id}` : undefined,
        };
        series[out.key] = out.kind === 'line'
          ? this.chart.addSeries(LineSeries, { ...common, lineWidth: 2, crosshairMarkerVisible: false }, pane)
          : this.chart.addSeries(HistogramSeries, { ...common, priceFormat: { type: 'volume' } }, pane);
        if (def.ownScale) {
          series[out.key].priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        }
      }
      const first = series[def.outputs[0].key];
      for (const level of def.levels ?? []) {
        first.createPriceLine({
          price: level, color: '#555a66', lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: false, title: '',
        });
      }
      const ind = { instance, series };
      this.indicators.push(ind);
      this.fillIndicator(ind);
    }
    this.chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));
    this.updateLegend();
  }

  private points(ind: IndicatorSeries, key: string, values: Series, from: number) {
    const out = indicatorDef(ind.instance.type).outputs.find((o) => o.key === key)!;
    const pts: (WhitespaceData | { time: UTCTimestamp; value: number; color?: string })[] = [];
    for (let i = from; i < this.bars.length; i++) {
      const v = values[i];
      const time = sec(this.bars[i].time);
      if (v === undefined || !Number.isFinite(v)) {
        pts.push({ time });
        continue;
      }
      let color: string | undefined;
      if (out.colorBy === 'sign') color = v >= 0 ? `${UP}cc` : `${DOWN}cc`;
      if (out.colorBy === 'candle') color = this.bars[i].close >= this.bars[i].open ? `${UP}66` : `${DOWN}66`;
      pts.push(color ? { time, value: v, color } : { time, value: v });
    }
    return pts;
  }

  private compute(ind: IndicatorSeries) {
    return indicatorDef(ind.instance.type).compute(this.bars, ind.instance.params);
  }

  private fillIndicator(ind: IndicatorSeries) {
    const values = this.compute(ind);
    for (const [key, s] of Object.entries(ind.series)) s.setData(this.points(ind, key, values[key], 0));
  }

  private updateIndicatorTail(ind: IndicatorSeries, n: number) {
    const values = this.compute(ind);
    const from = Math.max(0, this.bars.length - n);
    for (const [key, s] of Object.entries(ind.series)) {
      for (const p of this.points(ind, key, values[key], from)) s.update(p);
    }
  }

  // ---- trading overlays -------------------------------------------------------

  setPriceLines(lines: PriceLineSpec[]) {
    for (const l of this.priceLines) this.candles.removePriceLine(l);
    this.priceLines = lines.map((l) => this.candles.createPriceLine({
      price: l.price, color: l.color, title: l.title, lineWidth: 1,
      lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true,
    }));
  }

  setMarkers(markers: MarkerSpec[]) {
    const list: SeriesMarker<Time>[] = markers
      .sort((a, b) => a.time - b.time)
      .map((m) => ({
        time: sec(m.time),
        position: m.side === 'buy' ? 'belowBar' : 'aboveBar',
        shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown',
        color: m.side === 'buy' ? '#2196f3' : '#e91e63',
        text: m.text,
      }));
    this.markers.setMarkers(list);
  }

  // ---- legend -----------------------------------------------------------------

  private updateLegend(p?: MouseEventParams) {
    const bar = p?.time !== undefined
      ? this.bars.find((b) => sec(b.time) === p.time)
      : this.bars[this.bars.length - 1];
    if (!bar) {
      this.legend.innerHTML = '';
      return;
    }
    const prec = this.candles.options().priceFormat.type === 'price'
      ? (this.candles.options().priceFormat as { precision: number }).precision : 2;
    const f = (v: number) => v.toFixed(prec);
    const cls = bar.close >= bar.open ? 'up' : 'down';
    const chg = ((bar.close - bar.open) / bar.open) * 100;
    const overlays = this.indicators
      .filter((i) => indicatorDef(i.instance.type).overlay && !indicatorDef(i.instance.type).ownScale)
      .map((i) => `<div class="legend-ind" style="color:${Object.values(i.instance.colors)[0]}">${indicatorLabel(i.instance)}</div>`)
      .join('');
    this.legend.innerHTML = `<div class="legend-ohlc ${cls}">
      O <b>${f(bar.open)}</b> H <b>${f(bar.high)}</b> L <b>${f(bar.low)}</b> C <b>${f(bar.close)}</b>
      <span>${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span> V <b>${formatVolume(bar.volume)}</b></div>${overlays}`;
  }

  setSelectMode(on: boolean) {
    this.chart.applyOptions({
      crosshair: { vertLine: { color: on ? '#2962ff' : '#758696', width: on ? 2 : 1 } },
    });
  }

  dispose() {
    this.drawings.destroy();
    this.chart.remove();
  }
}

const toCandle = (b: Candle): CandlestickData<UTCTimestamp> => ({
  time: sec(b.time), open: b.open, high: b.high, low: b.low, close: b.close,
});

function formatVolume(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(2);
}
