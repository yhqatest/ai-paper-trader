// What the AI trader looks at each run.
//   node paper/market.js           → settles futures (funding, stops, liquidation), then portfolio, recent decisions,
//                                    BTC/ETH/gold, top movers (1h, 4h, 24h) and volume among liquid coins, futures funding
//   node paper/market.js SOLUSDT   → that coin's 24h stats, its perpetual (mark, funding), last 48 hourly and 30 daily candles
const {GOLD, MIN_VOLUME, MIN_FUT_VOLUME, START_CASH, loadState, saveState, readLog, bitget, tickers, futuresTickers, recentChanges, settleFutures, value} = require('./lib');

const pct = (v, d = 2) => `${(+v * 100).toFixed(d)}%`;
let ch = {};
const row = t => `${t.symbol.padEnd(14)} last ${t.lastPr}  1h ${ch[t.symbol] ? pct(ch[t.symbol].h1).padStart(7) : '      ?'}  4h ${ch[t.symbol] ? pct(ch[t.symbol].h4).padStart(7) : '      ?'}  24h ${pct(t.change24h).padStart(8)}  vol ${(+t.usdtVolume / 1e6).toFixed(1)}M USDT`;

(async () => {
  const sym = process.argv[2];
  const [tk, ftk] = await Promise.all([tickers(), futuresTickers()]);
  if (sym) {
    const t = tk[sym], f = ftk[sym];
    if (!t && !f) throw new Error(`${sym} 不是 USDT 现货交易对，也不是永续合约`);
    if (t) {
      ch = await recentChanges([sym]);
      console.log(row(t), `\nhigh24 ${t.high24h} low24 ${t.low24h} bid ${t.bidPr} ask ${t.askPr}`);
    } else console.log(`${sym}: no spot pair, perpetual only`);
    console.log(f ? `perpetual: last ${f.lastPr} mark ${f.markPrice} bid ${f.bidPr} ask ${f.askPr} funding ${pct(f.fundingRate, 4)}/period vol ${(+f.usdtVolume / 1e6).toFixed(1)}M USDT${+f.usdtVolume < MIN_FUT_VOLUME ? ' (too thin to trade)' : ''}` : 'perpetual: none');
    if (!t) return;
    const candles = await bitget(`/api/v2/spot/market/candles?symbol=${sym}&granularity=1h&limit=48`);
    console.log('hourly candles (time, open, high, low, close, base volume):');
    candles.forEach(c => console.log(new Date(+c[0]).toISOString().slice(5, 16), c[1], c[2], c[3], c[4], c[5]));
    const daily = await bitget(`/api/v2/spot/market/candles?symbol=${sym}&granularity=1day&limit=30`);
    console.log('daily candles, UTC+8 days (date, open, high, low, close, base volume):');
    daily.forEach(c => console.log(new Date(+c[0] + 8 * 3600000).toISOString().slice(0, 10), c[1], c[2], c[3], c[4], c[5]));
    return;
  }
  const state = loadState(), settled = await settleFutures(state);
  saveState(state);
  if (settled.length) console.log(`== Since your last run\n${settled.map(l => '  ' + l).join('\n')}\n`);
  const v = value(state, tk, ftk);
  console.log(`== Portfolio (${new Date().toISOString()})\ntotal ${v.total.toFixed(2)} USDT (start ${START_CASH}, ${((v.total / START_CASH - 1) * 100).toFixed(2)}%), cash ${v.cash.toFixed(2)}`);
  v.positions.forEach(p => console.log(`  spot ${p.symbol} qty ${p.qty} value ${p.value.toFixed(2)} cost ${p.cost.toFixed(2)} pnl ${p.pnlPct.toFixed(2)}%`));
  v.futures.forEach(f => console.log(`  ${f.side.toUpperCase()} ${f.symbol} ${f.leverage}x qty ${f.qty} entry ${f.entry} now ${f.price} equity ${f.value.toFixed(2)} cost ${f.cost.toFixed(2)} pnl ${f.pnlPct.toFixed(2)}% stop ${f.stop} take ${f.take} liquidation ${f.liq.toPrecision(6)} funding paid ${f.funding.toFixed(4)}`));
  console.log('\n== Your last 10 decisions');
  readLog().filter(e => e.action !== 'gold').slice(-10).forEach(e => console.log(`  ${e.time.slice(0, 16)} ${e.action} ${e.symbol || ''}${e.leverage ? ' ' + e.leverage + 'x' : ''} ${e.usdt ? e.usdt.toFixed(2) + ' USDT' : ''}${e.pnl != null ? ' pnl ' + e.pnl.toFixed(2) : ''} — ${e.reason}`));
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
  const perps = Object.values(ftk).filter(f => +f.usdtVolume >= MIN_FUT_VOLUME), fr = f => `${f.symbol.padEnd(14)} funding ${pct(f.fundingRate, 4).padStart(9)}  24h ${pct(f.change24h).padStart(8)}  vol ${(+f.usdtVolume / 1e6).toFixed(0)}M`;
  const byRate = dir => perps.slice().sort((a, b) => dir * (b.fundingRate - a.fundingRate)).slice(0, 5).map(fr).join('\n');
  console.log(`\n== Perpetual futures (${perps.length} contracts ≥${MIN_FUT_VOLUME / 1e6}M volume)\n${['BTCUSDT', 'ETHUSDT'].filter(s => ftk[s]).map(s => fr(ftk[s])).join('\n')}`);
  console.log(`highest funding (crowded longs):\n${byRate(1)}\nlowest funding (crowded shorts):\n${byRate(-1)}`);
})().catch(e => { console.error(e.message); process.exit(1); });
