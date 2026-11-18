// Executes the AI trader's paper orders at Bitget's live prices and logs them with the reason.
//   node paper/trade.js buy  SYMBOL USDT_AMOUNT "reason"   (fills at the ask, 0.1% fee)
//   node paper/trade.js sell SYMBOL PERCENT     "reason"   (sells that % of the position at the bid)
//   node paper/trade.js hold "reason"                      (records a no-trade decision)
//   node paper/trade.js gold "view"                        (records this hour's view on gold, shown on paper.html)
// Enforces the rules: liquid coins only, ≤30% of portfolio per coin, ≤3 trades per run, no shorting or borrowing.
const {FEE, MIN_VOLUME, MAX_WEIGHT, MAX_TRADES_PER_RUN, loadState, saveState, readLog, appendLog, tickers, value} = require('./lib');

const fail = msg => { console.error('REJECTED: ' + msg); process.exit(1); };

(async () => {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'hold' || action === 'gold') {
    if (!args[0]) fail('需要理由');
    appendLog({action, reason: args[0]});
    return console.log(`OK ${action} recorded`);
  }
  const [symbol, amountStr, reason] = args;
  const amount = +amountStr;
  if (!['buy', 'sell'].includes(action) || !/^[A-Z0-9]+USDT$/.test(symbol || '') || !(amount > 0) || !reason) {
    fail('用法: buy SYMBOL USDT_AMOUNT "reason" | sell SYMBOL PERCENT "reason" | hold "reason" | gold "view"');
  }
  const run = process.env.RUN_ID || 'local';
  if (readLog().filter(e => e.run === run && ['buy', 'sell'].includes(e.action)).length >= MAX_TRADES_PER_RUN) fail(`每次最多 ${MAX_TRADES_PER_RUN} 笔交易`);

  const tk = await tickers(), t = tk[symbol], state = loadState();
  if (!t) fail(`${symbol} 不是 USDT 现货交易对`);
  if (action === 'buy') {
    if (+t.usdtVolume < MIN_VOLUME) fail(`${symbol} 24h 成交额 ${(+t.usdtVolume / 1e6).toFixed(1)}M < ${MIN_VOLUME / 1e6}M USDT`);
    if (amount > state.cash) fail(`现金只有 ${state.cash.toFixed(2)} USDT`);
    const v = value(state, tk), held = v.positions.find(p => p.symbol === symbol)?.value || 0;
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
