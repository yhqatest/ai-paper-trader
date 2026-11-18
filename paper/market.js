// What the AI trader looks at each hour.
//   node paper/market.js           → portfolio, recent decisions, BTC/ETH, top movers (24h and 4h) and volume among liquid coins
//   node paper/market.js SOLUSDT   → that coin's 24h stats, last 48 hourly candles and last 30 daily candles
const {GOLD, MIN_VOLUME, START_CASH, loadState, readLog, bitget, tickers, recentChanges, value} = require('./lib');

const pct = v => `${(+v * 100).toFixed(2)}%`;
let ch = {};
const row = t => `${t.symbol.padEnd(14)} last ${t.lastPr}  1h ${ch[t.symbol] ? pct(ch[t.symbol].h1).padStart(7) : '      ?'}  4h ${ch[t.symbol] ? pct(ch[t.symbol].h4).padStart(7) : '      ?'}  24h ${pct(t.change24h).padStart(8)}  vol ${(+t.usdtVolume / 1e6).toFixed(1)}M USDT`;

(async () => {
  const sym = process.argv[2];
  const tk = await tickers();
  if (sym) {
    const t = tk[sym];
    if (!t) throw new Error(`${sym} 不是 USDT 现货交易对`);
    ch = await recentChanges([sym]);
    console.log(row(t), `\nhigh24 ${t.high24h} low24 ${t.low24h} bid ${t.bidPr} ask ${t.askPr}`);
    const candles = await bitget(`/api/v2/spot/market/candles?symbol=${sym}&granularity=1h&limit=48`);
    console.log('hourly candles (time, open, high, low, close, base volume):');
    candles.forEach(c => console.log(new Date(+c[0]).toISOString().slice(5, 16), c[1], c[2], c[3], c[4], c[5]));
    const daily = await bitget(`/api/v2/spot/market/candles?symbol=${sym}&granularity=1day&limit=30`);
    console.log('daily candles, UTC+8 days (date, open, high, low, close, base volume):');
    daily.forEach(c => console.log(new Date(+c[0] + 8 * 3600000).toISOString().slice(0, 10), c[1], c[2], c[3], c[4], c[5]));
    return;
  }
  const state = loadState(), v = value(state, tk);
  console.log(`== Portfolio (${new Date().toISOString()})\ntotal ${v.total.toFixed(2)} USDT (start ${START_CASH}, ${((v.total / START_CASH - 1) * 100).toFixed(2)}%), cash ${v.cash.toFixed(2)}`);
  v.positions.forEach(p => console.log(`  ${p.symbol} qty ${p.qty} value ${p.value.toFixed(2)} cost ${p.cost.toFixed(2)} pnl ${p.pnlPct.toFixed(2)}%`));
  console.log('\n== Your last 10 decisions');
  readLog().slice(-10).forEach(e => console.log(`  ${e.time.slice(0, 16)} ${e.action} ${e.symbol || ''} ${e.usdt ? e.usdt.toFixed(2) + ' USDT' : ''} — ${e.reason}`));
  const liquid = Object.values(tk).filter(t => +t.usdtVolume >= MIN_VOLUME);
  ch = await recentChanges([...new Set([...liquid.map(t => t.symbol), ...Object.keys(state.positions), GOLD])]);
  const h4 = t => ch[t.symbol]?.h4 ?? 0;
  console.log(`\n== Majors and gold (${GOLD} = 1 oz of gold)\n${['BTCUSDT', 'ETHUSDT', GOLD].filter(s => tk[s]).map(s => row(tk[s])).join('\n')}`);
  const by = (key, dir) => liquid.slice().sort((a, b) => dir * (key(b) - key(a))).slice(0, 10).map(row).join('\n');
  console.log(`\n== Top gainers 24h (≥${MIN_VOLUME / 1e6}M volume, ${liquid.length} tradable coins)\n${by(t => +t.change24h, 1)}`);
  console.log(`\n== Top losers 24h\n${by(t => +t.change24h, -1)}`);
  console.log(`\n== Top gainers 4h\n${by(h4, 1)}`);
  console.log(`\n== Top losers 4h\n${by(h4, -1)}`);
  console.log(`\n== Top volume\n${by(t => +t.usdtVolume, 1)}`);
})().catch(e => { console.error(e.message); process.exit(1); });
