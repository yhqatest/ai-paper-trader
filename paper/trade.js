// Executes the AI trader's paper orders at Bitget's live prices and logs them with the reason.
// Spot:
//   node paper/trade.js buy  SYMBOL USDT_AMOUNT STOP TAKE "reason"   (fills at the ask, 0.1% fee)
//   node paper/trade.js sell SYMBOL PERCENT "reason"                 (sells that % of the position at the bid)
// USDT-M perpetual futures (isolated margin, 0.06% fee, one position per coin):
//   node paper/trade.js long  SYMBOL MARGIN_USDT LEVERAGE STOP TAKE "reason"   (opens at the ask)
//   node paper/trade.js short SYMBOL MARGIN_USDT LEVERAGE STOP TAKE "reason"   (opens at the bid)
//   node paper/trade.js close SYMBOL PERCENT "reason"                          (closes that % of the position)
// Both:
//   node paper/trade.js stops SYMBOL STOP TAKE "reason"    (moves a position's stop-loss / take-profit)
// Decisions:
//   node paper/trade.js hold "reason"                      (records a no-trade decision)
//   node paper/trade.js gold buy|watch|sell "view"         (records this run's view on gold, shown on paper.html;
//                                                           buy = a buy setup is here now, sell = bearish / would sell)
// Enforces the rules: liquid coins only, ≤30% of portfolio per coin (futures: by margin), futures margin ≤50% in
// total, leverage ≤5x, ≤3 trades per run. Every entry (buy, long, short) also needs:
//   - a stop at least 1.5× the coin's average hourly range away (and, for futures, before the liquidation price),
//   - a take-profit at least 1.5× as far as the stop,
//   - size such that hitting the stop loses ≤1.5% of the portfolio (half after 3 losing exits in a row),
//   - no buying or going long while BTC's daily trend is down (gold excepted),
//   - no new entries once the portfolio is 5% down on the day, and no adding to a losing spot position.
// Spot coins need ≥10M USDT of 24h volume (gold ≥1M).
// Stops, take-profits, funding and liquidation are applied by settle (lib.js) every run.
const {GOLD, FEE, MIN_VOLUME, MAX_WEIGHT, MAX_TRADES_PER_RUN, FUT_FEE, MIN_FUT_VOLUME, MAX_LEVERAGE, MAX_FUT_MARGIN,
  RISK_PER_TRADE, LOSS_STREAK, MIN_REWARD_RISK, ATR_STOP, DAILY_LOSS_STOP,
  loadState, saveState, readLog, appendLog, tickers, futuresTickers, hourlyAtr, btcTrend, record, dayStart,
  liqPrice, sellSpot, closeFutures, settle, value} = require('./lib');

const fail = msg => { console.error('REJECTED: ' + msg); process.exit(1); };
const TRADES = ['buy', 'sell', 'long', 'short', 'close'];
const USAGE = '用法: buy SYMBOL USDT STOP TAKE "reason" | sell SYMBOL PERCENT "reason" | long/short SYMBOL MARGIN LEVERAGE STOP TAKE "reason" | close SYMBOL PERCENT "reason" | stops SYMBOL STOP TAKE "reason" | hold "reason" | gold buy|watch|sell "view"';
const fmt = v => (+v).toPrecision(6);

(async () => {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'hold' || action === 'gold') {
    const stance = action === 'gold' ? args.shift() : undefined;
    if (action === 'gold' && !['buy', 'watch', 'sell'].includes(stance)) fail('用法: gold buy|watch|sell "view"');
    if (!args[0]) fail('需要理由');
    appendLog({action, stance, reason: args[0]});
    return console.log(`OK ${action} recorded`);
  }
  const symbol = args[0];
  if (![...TRADES, 'stops'].includes(action) || !/^[A-Z0-9]+USDT$/.test(symbol || '')) fail(USAGE);
  const run = process.env.RUN_ID || 'local';
  if (action !== 'stops' && readLog().filter(e => e.run === run && TRADES.includes(e.action) && !e.trigger).length >= MAX_TRADES_PER_RUN) fail(`每次最多 ${MAX_TRADES_PER_RUN} 笔交易`);

  const state = loadState();
  // Settle first so a stop or liquidation since the last check can't be traded around.
  (await settle(state)).forEach(l => console.log('SETTLED ' + l));
  saveState(state);
  const [tk, ftk] = await Promise.all([tickers(), futuresTickers()]);
  const v = value(state, tk, ftk);

  if (action === 'sell') {
    const [, pctStr, reason] = args, pct = +pctStr, t = tk[symbol];
    if (!(pct > 0) || !reason) fail(USAGE);
    if (!state.positions[symbol]) fail(`没有持有 ${symbol}`);
    const r = sellSpot(state, symbol, Math.min(pct, 100) / 100, +t.bidPr, {reason});
    saveState(state);
    return console.log(`OK sold ${r.qty} ${symbol} @ ${t.bidPr} for ${r.back.toFixed(2)} USDT (pnl ${r.pnl.toFixed(2)})`);
  }
  if (action === 'close') {
    const [, pctStr, reason] = args, pct = +pctStr, t = ftk[symbol], p = state.futures[symbol];
    if (!(pct > 0) || !reason) fail(USAGE);
    if (!p) fail(`没有 ${symbol} 合约仓位`);
    const price = p.side === 'long' ? +t.bidPr : +t.askPr;
    const r = closeFutures(state, symbol, Math.min(pct, 100) / 100, price, {reason});
    saveState(state);
    return console.log(`OK closed ${Math.min(pct, 100)}% of ${symbol} ${p.side} @ ${price}, got back ${r.back.toFixed(2)} USDT (pnl ${r.pnl.toFixed(2)})`);
  }
  if (action === 'stops') {
    const [stop, take, reason] = [+args[1], +args[2], args[3]], f = state.futures[symbol], p = f || state.positions[symbol];
    if (!p) fail(`没有 ${symbol} 仓位`);
    if (!reason || !(stop > 0) || !(take > 0)) fail(USAGE);
    const long = !f || f.side === 'long', price = +(f ? ftk : tk)[symbol].lastPr;
    if (long ? !(stop < price && take > price) : !(stop > price && take < price)) fail(`止损要在现价 ${price} ${long ? '下方' : '上方'}，止盈在${long ? '上方' : '下方'}`);
    if (f && (long ? stop <= liqPrice(f) : stop >= liqPrice(f))) fail(`止损 ${stop} 在强平价 ${fmt(liqPrice(f))} 之外`);
    Object.assign(p, {stop, take, checked: p.checked || new Date().toISOString()});
    saveState(state);
    appendLog({action, symbol, side: f?.side, stop, take, reason});
    return console.log(`OK ${symbol} stop ${stop} take ${take}`);
  }

  // Entries: buy, long, short.
  const futures = action !== 'buy', t = (futures ? ftk : tk)[symbol];
  if (!t) fail(`${symbol} 不是 USDT ${futures ? '永续合约' : '现货交易对'}`);
  const long = action !== 'short', price = long ? +t.askPr : +t.bidPr;
  let amount, leverage, stop, take, reason;
  if (futures) [amount, leverage, stop, take, reason] = [+args[1], +args[2], +args[3], +args[4], args[5]];
  else [amount, leverage, stop, take, reason] = [+args[1], 1, +args[2], +args[3], args[4]];
  if (!(amount > 0) || !(stop > 0) || !(take > 0) || !reason) fail(USAGE);
  const exposure = amount * leverage, fee = exposure * (futures ? FUT_FEE : FEE);

  const day = dayStart(state, v.total);
  saveState(state);
  if (v.total < day.total * (1 - DAILY_LOSS_STOP)) fail(`今天已经亏了 ${((1 - v.total / day.total) * 100).toFixed(1)}%（从 ${day.total.toFixed(2)} 到 ${v.total.toFixed(2)}），今天不再开新仓`);
  if (long && symbol !== GOLD) {
    const btc = await btcTrend();
    if (btc.trend === 'down') fail(`比特币日线是下跌趋势（${fmt(btc.close)} 低于正在下降的 20 日均线 ${fmt(btc.sma20)}），不做多；可以做空弱势币，或等比特币站回 20 日均线`);
  }
  // Gold tracks the metal, not a thin small cap, so it keeps the old 1M floor; XAUT often trades under 10M a day.
  const minVolume = futures ? MIN_FUT_VOLUME : symbol === GOLD ? 1e6 : MIN_VOLUME;
  if (+t.usdtVolume < minVolume) fail(`${symbol} 24h 成交额 ${(+t.usdtVolume / 1e6).toFixed(1)}M < ${minVolume / 1e6}M USDT`);
  if (long ? !(stop < price && take > price) : !(stop > price && take < price)) fail(`${action} 的止损要在现价 ${price} ${long ? '下方' : '上方'}，止盈在${long ? '上方' : '下方'}`);
  const risk = Math.abs(price - stop), atr = await hourlyAtr(symbol, futures);
  if (risk < ATR_STOP * atr) fail(`止损离现价只有 ${fmt(risk)}（${(risk / price * 100).toFixed(2)}%），小于 ${ATR_STOP} 倍小时平均波动 ${fmt(ATR_STOP * atr)}（${(ATR_STOP * atr / price * 100).toFixed(2)}%），正常波动就会打到；止损放远一点、仓位缩小`);
  if (Math.abs(take - price) < MIN_REWARD_RISK * risk) fail(`止盈距离 ${fmt(Math.abs(take - price))} 不到止损距离 ${fmt(risk)} 的 ${MIN_REWARD_RISK} 倍，赚亏比不够`);
  const {streak} = record(readLog()), budget = v.total * RISK_PER_TRADE * (streak >= LOSS_STREAK ? 0.5 : 1);
  const loss = exposure * risk / price + fee * 2;
  if (loss > budget) {
    const most = budget / (risk / price + (futures ? FUT_FEE : FEE) * 2) / leverage;
    fail(`打到止损会亏 ${loss.toFixed(2)} USDT，超过上限 ${budget.toFixed(2)}（组合的 ${(budget / v.total * 100).toFixed(2)}%${streak >= LOSS_STREAK ? `，已连亏 ${streak} 笔所以减半` : ''}）；${futures ? '保证金' : '金额'}最多 ${most.toFixed(2)} USDT`);
  }

  if (!futures) {
    if (amount > state.cash) fail(`现金只有 ${state.cash.toFixed(2)} USDT`);
    const held = v.positions.find(p => p.symbol === symbol);
    if (held && held.pnlPct < 0) fail(`${symbol} 现在亏 ${held.pnlPct.toFixed(2)}%，不在亏损的仓位上加码`);
    if ((held?.value || 0) + amount > v.total * MAX_WEIGHT) fail(`${symbol} 会超过组合的 ${MAX_WEIGHT * 100}%（最多再买 ${(v.total * MAX_WEIGHT - (held?.value || 0)).toFixed(2)} USDT）`);
    const qty = amount * (1 - FEE) / price, p = state.positions[symbol] || {qty: 0, cost: 0};
    state.positions[symbol] = {qty: p.qty + qty, cost: p.cost + amount, stop, take, checked: new Date().toISOString()};
    state.cash -= amount;
    saveState(state);
    appendLog({action, symbol, price, qty, usdt: amount, fee, stop, take, reason});
    return console.log(`OK bought ${qty} ${symbol} @ ${price} for ${amount} USDT, stop ${stop} take ${take}, risk ${loss.toFixed(2)} USDT`);
  }

  if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) fail(`杠杆要是 1 到 ${MAX_LEVERAGE} 的整数`);
  if (state.futures[symbol]) fail(`已经有 ${symbol} ${state.futures[symbol].side} 仓位，先 close 再开`);
  if (exposure < 5) fail('仓位价值至少 5 USDT');
  if (amount + fee > state.cash) fail(`现金只有 ${state.cash.toFixed(2)} USDT（保证金 + 手续费 ${(amount + fee).toFixed(2)}）`);
  const used = v.futures.reduce((a, f) => a + f.margin, 0);
  if (amount > v.total * MAX_WEIGHT) fail(`保证金会超过组合的 ${MAX_WEIGHT * 100}%（最多 ${(v.total * MAX_WEIGHT).toFixed(2)} USDT）`);
  if (used + amount > v.total * MAX_FUT_MARGIN) fail(`合约保证金合计会超过组合的 ${MAX_FUT_MARGIN * 100}%（还能用 ${(v.total * MAX_FUT_MARGIN - used).toFixed(2)} USDT）`);
  const now = new Date().toISOString();
  const pos = {side: action, qty: exposure / price, entry: price, margin: amount, cost: amount + fee, leverage, stop, take, funding: 0, opened: now, checked: now};
  const liq = liqPrice(pos);
  if (long ? stop <= liq : stop >= liq) fail(`止损 ${stop} 在强平价 ${fmt(liq)} 之外，降低杠杆或把止损挪近`);
  state.futures[symbol] = pos;
  state.cash -= amount + fee;
  saveState(state);
  appendLog({action, symbol, price, qty: pos.qty, leverage, margin: amount, usdt: exposure, fee, stop, take, liq, reason});
  console.log(`OK ${action} ${pos.qty} ${symbol} @ ${price}, ${leverage}x, margin ${amount} USDT, liquidation ${fmt(liq)}, risk ${loss.toFixed(2)} USDT`);
})().catch(e => fail(e.message));
