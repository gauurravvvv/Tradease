import { RSI, MACD, BollingerBands, ATR, SMA, EMA } from 'technicalindicators';

/**
 * Compute ATR (Average True Range) for OHLCV data.
 * @param {Array} ohlcvData - Array of { date, open, high, low, close, volume }
 * @param {number} period - ATR period (default 14)
 * @returns {number|null} Latest ATR value
 */
export function computeATR(ohlcvData, period = 14) {
  if (!ohlcvData || ohlcvData.length < period + 1) return null;

  const atrValues = ATR.calculate({
    high: ohlcvData.map(d => d.high),
    low: ohlcvData.map(d => d.low),
    close: ohlcvData.map(d => d.close),
    period,
  });

  return atrValues.length > 0 ? atrValues[atrValues.length - 1] : null;
}

/**
 * Find support and resistance levels from pivot points in last 90 days.
 * Uses swing highs/lows with a lookback window of 5 bars on each side.
 * @param {Array} ohlcvData - OHLCV array (ideally 90+ days)
 * @returns {{ supports: number[], resistances: number[] }}
 */
export function findSupportResistance(ohlcvData) {
  const supports = [];
  const resistances = [];

  if (!ohlcvData || ohlcvData.length < 11) {
    return { supports, resistances };
  }

  // Use last 90 bars max
  const data = ohlcvData.slice(-90);
  const lookback = 5;

  for (let i = lookback; i < data.length - lookback; i++) {
    const currentHigh = data[i].high;
    const currentLow = data[i].low;

    // Check swing high (resistance candidate)
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (data[i - j].high >= currentHigh || data[i + j].high >= currentHigh) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      resistances.push(currentHigh);
    }

    // Check swing low (support candidate)
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (data[i - j].low <= currentLow || data[i + j].low <= currentLow) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      supports.push(currentLow);
    }
  }

  // Cluster nearby levels (within 1% of each other) and keep strongest
  const clusterLevels = (levels) => {
    if (levels.length === 0) return [];
    const sorted = [...levels].sort((a, b) => a - b);
    const clusters = [];
    let cluster = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const clusterAvg = cluster.reduce((s, v) => s + v, 0) / cluster.length;
      if ((sorted[i] - clusterAvg) / clusterAvg < 0.01) {
        cluster.push(sorted[i]);
      } else {
        clusters.push(cluster);
        cluster = [sorted[i]];
      }
    }
    clusters.push(cluster);

    // Return average of each cluster, sorted, keep top 5
    return clusters
      .map(c => ({
        level: Math.round((c.reduce((s, v) => s + v, 0) / c.length) * 100) / 100,
        strength: c.length,
      }))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5)
      .map(c => c.level)
      .sort((a, b) => a - b);
  };

  return {
    supports: clusterLevels(supports),
    resistances: clusterLevels(resistances),
  };
}

/**
 * Full technical analysis on OHLCV data.
 * @param {Array} ohlcvData - Array of { date, open, high, low, close, volume }
 * @returns {Object} Complete technical analysis output
 */
export function analyzeTechnicals(ohlcvData) {
  if (!ohlcvData || ohlcvData.length === 0) {
    return buildEmptyResult();
  }

  const closes = ohlcvData.map(d => d.close);
  const highs = ohlcvData.map(d => d.high);
  const lows = ohlcvData.map(d => d.low);
  const volumes = ohlcvData.map(d => d.volume);
  const latestClose = closes[closes.length - 1];

  // --- RSI ---
  const rsiResult = computeRSI(closes);

  // --- MACD ---
  const macdResult = computeMACD(closes);

  // --- Bollinger Bands ---
  const bbResult = computeBollingerBands(closes, latestClose);

  // --- ATR ---
  const atrResult = computeATRAnalysis(highs, lows, closes, latestClose);

  // --- SMA ---
  const smaResult = computeSMAAnalysis(closes);

  // --- EMA ---
  const emaResult = computeEMAAnalysis(closes);

  // --- Volume ---
  const volumeResult = computeVolumeAnalysis(volumes);

  // --- Support/Resistance ---
  const supportResistance = findSupportResistance(ohlcvData);

  // --- Overall signal & score ---
  const { overallSignal, score } = computeOverallSignal({
    rsi: rsiResult,
    macd: macdResult,
    bollingerBands: bbResult,
    sma: smaResult,
    ema: emaResult,
    volume: volumeResult,
    supportResistance,
    latestClose,
  });

  return {
    rsi: rsiResult,
    macd: macdResult,
    bollingerBands: bbResult,
    atr: atrResult,
    sma: smaResult,
    ema: emaResult,
    volume: volumeResult,
    supportResistance,
    overallSignal,
    score,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────

function computeRSI(closes) {
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  if (rsiValues.length === 0) {
    return { value: null, signal: 'neutral' };
  }
  const value = Math.round(rsiValues[rsiValues.length - 1] * 100) / 100;
  let signal = 'neutral';
  if (value < 30) signal = 'oversold';
  else if (value > 70) signal = 'overbought';
  return { value, signal };
}

function computeMACD(closes) {
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  if (macdValues.length < 2) {
    return { macd: null, signal: null, histogram: null, trend: 'neutral' };
  }

  const latest = macdValues[macdValues.length - 1];
  const prev = macdValues[macdValues.length - 2];

  let trend = 'neutral';
  if (latest.MACD != null && latest.signal != null && prev.MACD != null && prev.signal != null) {
    const crossedAbove = prev.MACD <= prev.signal && latest.MACD > latest.signal;
    const crossedBelow = prev.MACD >= prev.signal && latest.MACD < latest.signal;

    if (crossedAbove) trend = 'bullish_crossover';
    else if (crossedBelow) trend = 'bearish_crossover';
    else if (latest.MACD > latest.signal) trend = 'bullish';
    else trend = 'bearish';
  }

  return {
    macd: latest.MACD != null ? Math.round(latest.MACD * 100) / 100 : null,
    signal: latest.signal != null ? Math.round(latest.signal * 100) / 100 : null,
    histogram: latest.histogram != null ? Math.round(latest.histogram * 100) / 100 : null,
    trend,
  };
}

function computeBollingerBands(closes, latestClose) {
  const bbValues = BollingerBands.calculate({
    period: 20,
    values: closes,
    stdDev: 2,
  });

  if (bbValues.length === 0) {
    return { upper: null, middle: null, lower: null, bandwidth: null, percentB: null };
  }

  const latest = bbValues[bbValues.length - 1];
  const bandwidth = latest.upper - latest.lower;
  const percentB = bandwidth !== 0 ? (latestClose - latest.lower) / bandwidth : 0.5;

  return {
    upper: Math.round(latest.upper * 100) / 100,
    middle: Math.round(latest.middle * 100) / 100,
    lower: Math.round(latest.lower * 100) / 100,
    bandwidth: Math.round(bandwidth * 100) / 100,
    percentB: Math.round(percentB * 10000) / 10000,
  };
}

function computeATRAnalysis(highs, lows, closes, latestClose) {
  const atrValues = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
  });

  if (atrValues.length === 0) {
    return { value: null, percentage: null };
  }

  const value = Math.round(atrValues[atrValues.length - 1] * 100) / 100;
  const percentage = latestClose > 0
    ? Math.round((value / latestClose) * 10000) / 100
    : null;

  return { value, percentage };
}

function computeSMAAnalysis(closes) {
  const sma20Values = SMA.calculate({ period: 20, values: closes });
  const sma50Values = SMA.calculate({ period: 50, values: closes });
  const sma200Values = SMA.calculate({ period: 200, values: closes });

  const sma20 = sma20Values.length > 0
    ? Math.round(sma20Values[sma20Values.length - 1] * 100) / 100
    : null;
  const sma50 = sma50Values.length > 0
    ? Math.round(sma50Values[sma50Values.length - 1] * 100) / 100
    : null;
  const sma200 = sma200Values.length > 0
    ? Math.round(sma200Values[sma200Values.length - 1] * 100) / 100
    : null;

  let trend = 'neutral';
  if (sma20 != null && sma50 != null && sma200 != null) {
    if (sma20 > sma50 && sma50 > sma200) trend = 'strong_uptrend';
    else if (sma20 > sma50) trend = 'uptrend';
    else if (sma20 < sma50 && sma50 < sma200) trend = 'strong_downtrend';
    else if (sma20 < sma50) trend = 'downtrend';
  } else if (sma20 != null && sma50 != null) {
    trend = sma20 > sma50 ? 'uptrend' : 'downtrend';
  }

  return { sma20, sma50, sma200, trend };
}

function computeEMAAnalysis(closes) {
  const ema9Values = EMA.calculate({ period: 9, values: closes });
  const ema21Values = EMA.calculate({ period: 21, values: closes });

  const ema9 = ema9Values.length > 0
    ? Math.round(ema9Values[ema9Values.length - 1] * 100) / 100
    : null;
  const ema21 = ema21Values.length > 0
    ? Math.round(ema21Values[ema21Values.length - 1] * 100) / 100
    : null;

  let trend = 'neutral';
  if (ema9 != null && ema21 != null) {
    trend = ema9 > ema21 ? 'bullish' : 'bearish';
  }

  return { ema9, ema21, trend };
}

function computeVolumeAnalysis(volumes) {
  const current = volumes[volumes.length - 1] || 0;

  // 20-day average volume (excluding current)
  const recentVolumes = volumes.slice(-21, -1);
  const average20 = recentVolumes.length > 0
    ? Math.round(recentVolumes.reduce((s, v) => s + v, 0) / recentVolumes.length)
    : 0;

  const ratio = average20 > 0 ? Math.round((current / average20) * 100) / 100 : 0;

  let signal = 'normal';
  if (ratio >= 2) signal = 'surge';
  else if (ratio >= 1.5) signal = 'high';
  else if (ratio < 0.5) signal = 'low';

  return { current, average20, ratio, signal };
}

function computeOverallSignal({ rsi, macd, bollingerBands, sma, ema, volume, supportResistance, latestClose }) {
  let score = 50; // Start neutral

  // RSI contribution (max +/- 15)
  if (rsi.value != null) {
    if (rsi.signal === 'oversold') score += 12;
    else if (rsi.signal === 'overbought') score -= 12;
    else if (rsi.value < 45) score += 5;
    else if (rsi.value > 55) score -= 5;
  }

  // MACD contribution (max +/- 15)
  if (macd.trend === 'bullish_crossover') score += 15;
  else if (macd.trend === 'bearish_crossover') score -= 15;
  else if (macd.trend === 'bullish') score += 8;
  else if (macd.trend === 'bearish') score -= 8;

  // Bollinger Bands contribution (max +/- 10)
  if (bollingerBands.percentB != null) {
    if (bollingerBands.percentB < 0.1) score += 10;     // Near lower band — bullish reversal
    else if (bollingerBands.percentB < 0.3) score += 5;
    else if (bollingerBands.percentB > 0.9) score -= 10; // Near upper band — bearish reversal
    else if (bollingerBands.percentB > 0.7) score -= 5;
  }

  // SMA trend contribution (max +/- 10)
  if (sma.trend === 'strong_uptrend') score += 10;
  else if (sma.trend === 'uptrend') score += 5;
  else if (sma.trend === 'strong_downtrend') score -= 10;
  else if (sma.trend === 'downtrend') score -= 5;

  // EMA trend contribution (max +/- 8)
  if (ema.trend === 'bullish') score += 8;
  else if (ema.trend === 'bearish') score -= 8;

  // Volume contribution (max +/- 5, amplifier)
  if (volume.signal === 'surge') score += 5;
  else if (volume.signal === 'high') score += 3;
  else if (volume.signal === 'low') score -= 3;

  // Support/resistance proximity (max +/- 7)
  if (latestClose != null && supportResistance.supports.length > 0) {
    const nearestSupport = supportResistance.supports.reduce((best, s) =>
      Math.abs(s - latestClose) < Math.abs(best - latestClose) ? s : best
    );
    const distPct = Math.abs(latestClose - nearestSupport) / latestClose;
    if (distPct < 0.02 && latestClose >= nearestSupport) score += 7; // Bouncing off support
  }
  if (latestClose != null && supportResistance.resistances.length > 0) {
    const nearestResistance = supportResistance.resistances.reduce((best, r) =>
      Math.abs(r - latestClose) < Math.abs(best - latestClose) ? r : best
    );
    const distPct = Math.abs(latestClose - nearestResistance) / latestClose;
    if (distPct < 0.02 && latestClose <= nearestResistance) score -= 7; // Bumping against resistance
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, Math.round(score)));

  let overallSignal;
  if (score >= 80) overallSignal = 'STRONG_BUY';
  else if (score >= 60) overallSignal = 'BUY';
  else if (score >= 40) overallSignal = 'NEUTRAL';
  else if (score >= 20) overallSignal = 'SELL';
  else overallSignal = 'STRONG_SELL';

  return { overallSignal, score };
}

function buildEmptyResult() {
  return {
    rsi: { value: null, signal: 'neutral' },
    macd: { macd: null, signal: null, histogram: null, trend: 'neutral' },
    bollingerBands: { upper: null, middle: null, lower: null, bandwidth: null, percentB: null },
    atr: { value: null, percentage: null },
    sma: { sma20: null, sma50: null, sma200: null, trend: 'neutral' },
    ema: { ema9: null, ema21: null, trend: 'neutral' },
    volume: { current: 0, average20: 0, ratio: 0, signal: 'normal' },
    supportResistance: { supports: [], resistances: [] },
    overallSignal: 'NEUTRAL',
    score: 50,
  };
}
