// Deterministic (seeded) trade generator for the mock BSE API.

const SYMBOLS = [
  ['RELIANCE', 2950], ['TCS', 4100], ['HDFCBANK', 1650], ['INFY', 1850], ['ICICIBANK', 1250],
  ['SBIN', 820], ['BHARTIARTL', 1600], ['ITC', 470], ['LT', 3650], ['HINDUNILVR', 2450],
  ['KOTAKBANK', 1780], ['AXISBANK', 1150], ['BAJFINANCE', 7100], ['MARUTI', 12400], ['ASIANPAINT', 2900],
  ['SUNPHARMA', 1800], ['TITAN', 3400], ['ULTRACEMCO', 11300], ['WIPRO', 520], ['TATAMOTORS', 950],
  ['NTPC', 400], ['POWERGRID', 330], ['ADANIPORTS', 1400], ['M&M', 2900], ['TATASTEEL', 160],
];

const CLIENTS = Array.from({ length: 60 }, (_, i) => `CL${String(10001 + i * 7)}`);

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

export function createTradeGenerator({ seed = 42, baseCount = 3000, now = Date.now() } = {}) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const trades = [];
  let counter = 0;

  function makeTrade(ts) {
    counter += 1;
    const [symbol, ref] = pick(SYMBOLS);
    const price = round2(ref * (1 + (rand() - 0.5) * 0.04)); // +/- 2% around reference
    const quantity = (1 + Math.floor(rand() * 40)) * pick([1, 5, 10, 25]);
    return {
      tradeId: `BSE${String(counter).padStart(9, '0')}`,
      client: pick(CLIENTS),
      symbol,
      side: rand() < 0.5 ? 'BUY' : 'SELL',
      quantity,
      price,
      timestamp: new Date(Math.floor(ts)).toISOString(),
    };
  }

  // Seed history: spread across the 6 hours before startup.
  const start = now - 6 * 60 * 60 * 1000;
  const step = (now - start) / Math.max(baseCount, 1);
  for (let i = 0; i < baseCount; i++) trades.push(makeTrade(start + i * step));
  let lastTs = now;

  return {
    /** All trades known to the exchange so far. */
    all: () => trades,
    /** Simulate market activity: append `count` new trades between the last pull and `until`. */
    append(count, until = Date.now()) {
      const from = lastTs;
      const span = Math.max(until - from, 1);
      const added = [];
      for (let i = 0; i < count; i++) added.push(makeTrade(from + ((i + 1) / count) * span));
      trades.push(...added);
      lastTs = until;
      return added;
    },
    randInt: (min, max) => min + Math.floor(rand() * (max - min + 1)),
  };
}
