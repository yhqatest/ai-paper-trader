// Executes the AI trader's paper orders at Bitget's live prices and logs them with the reason.
// Spot:
//   node paper/trade.js buy  SYMBOL USDT_AMOUNT "reason"   (fills at the ask, 0.1% fee)
//   node paper/trade.js sell SYMBOL PERCENT     "reason"   (sells that % of the position at the bid)
// USDT-M perpetual futures (isolated margin, 0.06% fee, one position per coin):
//   node paper/trade.js long  SYMBOL MARGIN_USDT LEVERAGE STOP TAKE "reason"   (opens at the ask)
//   node paper/trade.js short SYMBOL MARGIN_USDT LEVERAGE STOP TAKE "reason"   (opens at the bid)
//   node paper/trade.js close SYMBOL PERCENT "reason"                          (closes that % of the position)
//   node paper/trade.js stops SYMBOL STOP TAKE "reason"                        (moves stop-loss / take-profit)
// Decisions:
//   node paper/trade.js hold "reason"                      (records a no-trade decision)
//   node paper/trade.js gold "view"                        (records this hour's view on gold, shown on paper.html)
// Enforces the rules: liquid coins only, ≤30% of portfolio per coin (futures: by margin), futures margin ≤50% in
// total, leverage ≤5x, a stop-loss on every futures position that sits before the liquidation price, ≤3 trades
// per run. Futures stops, take-profits, funding and liquidation are applied by settleFutures (lib.js) every run.
const {FEE, MIN_VOLUME, MAX_WEIGHT, MAX_TRADES_PER_RUN, FUT_FEE, MIN_FUT_VOLUME, MAX_LEVERAGE, MAX_FUT_MARGIN,
  loadState, saveState, readLog, appendLog, tickers, futuresTickers, liqPrice, closeFutures, settleFutures, value} = require('./lib');

const fail = msg => { console.error('REJECTED: ' + msg); process.exit(1); };
const TRADES = ['buy', 'sell', 'long', 'short', 'close'];
const USAGE = '用法: buy SYMBOL USDT "reason" | sell SYMBOL PERCENT "reason" | long/short SYMBOL MARGIN LEVERAGE STOP TAKE "reason" | close SYMBOL PERCENT "reason" | stops SYMBOL STOP TAKE "reason" | hold "reason" | gold "view"';

(async () => {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'hold' || action === 'gold') {
    if (!args[0]) fail('需要理由');
    appendLog({action, reason: args[0]});
    return console.log(`OK ${action} recorded`);
  }
  const symbol = args[0];
  if (![...TRADES, 'stops'].includes(action) || !/^[A-Z0-9]+USDT$/.test(symbol || '')) fail(USAGE);
  const run = process.env.RUN_ID || 'local';
  if (action !== 'stops' && readLog().filter(e => e.run === run && TRADES.includes(e.action) && !e.trigger).length >= MAX_TRADES_PER_RUN) fail(`每次最多 ${MAX_TRADES_PER_RUN} 笔交易`);

  const state = loadState();
  // Settle first so a stop or liquidation since the last check can't be traded around.
  (await settleFutures(state)).forEach(l => console.log('SETTLED ' + l));
  saveState(state);
  const [tk, ftk] = await Promise.all([tickers(), futuresTickers()]);

  if (['long', 'short', 'close', 'stops'].includes(action)) return futures(action, symbol, args.slice(1), state, tk, ftk);

  const [, amountStr, reason] = args, amount = +amountStr, t = tk[symbol];
  if (!(amount > 0) || !reason) fail(USAGE);
  if (!t) fail(`${symbol} 不是 USDT 现货交易对`);
  if (action === 'buy') {
    if (+t.usdtVolume < MIN_VOLUME) fail(`${symbol} 24h 成交额 ${(+t.usdtVolume / 1e6).toFixed(1)}M < ${MIN_VOLUME / 1e6}M USDT`);
    if (amount > state.cash) fail(`现金只有 ${state.cash.toFixed(2)} USDT`);
    const v = value(state, tk, ftk), held = v.positions.find(p => p.symbol === symbol)?.value || 0;
    if (held + amount > v.total * MAX_WEIGHT) fail(`${symbol} 会超过组合的 ${MAX_WEIGHT * 100}%（最多再买 ${(v.total * MAX_WEIGHT - held).toFixed(2)} USDT）`);
    const price = +t.askPr, qty = amount * (1 - FEE) / price;
    const p = state.positions[symbol] || {qty: 0, cost: 0};
    state.positions[symbol] = {qty: p.qty + qty, cost: p.cost + amount};
    state.cash -= amount;
    saveState(state);
    appendLog({action, symbol, price, qty, usdt: amount, fee: amount * FEE, reason});
    return console.log(`OK bought ${qty} ${symbol} @ ${price} for ${amount} USDT`);
  }
  const p = state.positions[symbol];
  if (!p) fail(`没有持有 ${symbol}`);
  const frac = Math.min(amount, 100) / 100, qty = p.qty * frac, price = +t.bidPr, gross = qty * price, cost = p.cost * frac;
  state.cash += gross * (1 - FEE);
  if (frac >= 1) delete state.positions[symbol];
  else state.positions[symbol] = {qty: p.qty - qty, cost: p.cost - cost};
  saveState(state);
  appendLog({action, symbol, price, qty, usdt: gross * (1 - FEE), fee: gross * FEE, pnl: gross * (1 - FEE) - cost, reason});
  console.log(`OK sold ${qty} ${symbol} @ ${price} for ${(gross * (1 - FEE)).toFixed(2)} USDT (pnl ${(gross * (1 - FEE) - cost).toFixed(2)})`);
})().catch(e => fail(e.message));

function futures(action, symbol, args, state, tk, ftk) {
  const t = ftk[symbol], p = state.futures[symbol];
  if (!t) fail(`${symbol} 不是 USDT 永续合约`);
  // Stop must sit between the entry side and the liquidation price; take-profit on the other side of the price.
  const checkStops = (pos, price, stop, take) => {
    const long = pos.side === 'long', liq = liqPrice(pos);
    if (!(stop > 0) || !(take > 0)) fail('需要止损价和止盈价');
    if (long ? !(stop < price && take > price) : !(stop > price && take < price)) fail(`${pos.side} 的止损要在现价 ${price} ${long ? '下方' : '上方'}，止盈在${long ? '上方' : '下方'}`);
    if (long ? stop <= liq : stop >= liq) fail(`止损 ${stop} 在强平价 ${liq.toPrecision(6)} 之外，降低杠杆或把止损挪近`);
  };

  if (action === 'close') {
    const [pctStr, reason] = args, pct = +pctStr;
    if (!(pct > 0) || !reason) fail(USAGE);
    if (!p) fail(`没有 ${symbol} 合约仓位`);
    const price = p.side === 'long' ? +t.bidPr : +t.askPr;
    const r = closeFutures(state, symbol, Math.min(pct, 100) / 100, price, {reason});
    saveState(state);
    return console.log(`OK closed ${Math.min(pct, 100)}% of ${symbol} ${p.side} @ ${price}, got back ${r.back.toFixed(2)} USDT (pnl ${r.pnl.toFixed(2)})`);
  }
  if (action === 'stops') {
    const [stop, take, reason] = [+args[0], +args[1], args[2]];
    if (!p) fail(`没有 ${symbol} 合约仓位`);
    if (!reason) fail(USAGE);
    checkStops(p, +t.lastPr, stop, take);
    Object.assign(p, {stop, take});
    saveState(state);
    appendLog({action, symbol, side: p.side, stop, take, reason});
    return console.log(`OK ${symbol} stop ${stop} take ${take}`);
  }

  const [margin, leverage, stop, take, reason] = [+args[0], +args[1], +args[2], +args[3], args[4]];
  if (!(margin > 0) || !reason) fail(USAGE);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) fail(`杠杆要是 1 到 ${MAX_LEVERAGE} 的整数`);
  if (p) fail(`已经有 ${symbol} ${p.side} 仓位，先 close 再开`);
  if (+t.usdtVolume < MIN_FUT_VOLUME) fail(`${symbol} 合约 24h 成交额 ${(+t.usdtVolume / 1e6).toFixed(1)}M < ${MIN_FUT_VOLUME / 1e6}M USDT`);
  const price = action === 'long' ? +t.askPr : +t.bidPr, notional = margin * leverage, fee = notional * FUT_FEE;
  if (notional < 5) fail('仓位价值至少 5 USDT');
  if (margin + fee > state.cash) fail(`现金只有 ${state.cash.toFixed(2)} USDT（保证金 + 手续费 ${(margin + fee).toFixed(2)}）`);
  const v = value(state, tk, ftk), used = v.futures.reduce((a, f) => a + f.margin, 0);
  if (margin > v.total * MAX_WEIGHT) fail(`保证金会超过组合的 ${MAX_WEIGHT * 100}%（最多 ${(v.total * MAX_WEIGHT).toFixed(2)} USDT）`);
  if (used + margin > v.total * MAX_FUT_MARGIN) fail(`合约保证金合计会超过组合的 ${MAX_FUT_MARGIN * 100}%（还能用 ${(v.total * MAX_FUT_MARGIN - used).toFixed(2)} USDT）`);
  const now = new Date().toISOString();
  const pos = {side: action, qty: notional / price, entry: price, margin, cost: margin + fee, leverage, stop, take, funding: 0, opened: now, checked: now};
  checkStops(pos, price, stop, take);
  state.futures[symbol] = pos;
  state.cash -= margin + fee;
  saveState(state);
  const liq = liqPrice(pos);
  appendLog({action, symbol, price, qty: pos.qty, leverage, margin, usdt: notional, fee, stop, take, liq, reason});
  console.log(`OK ${action} ${pos.qty} ${symbol} @ ${price}, ${leverage}x, margin ${margin} USDT, liquidation ${liq.toPrecision(6)}`);
}
