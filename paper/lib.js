// Shared helpers for the AI paper-trading bot (paper/market.js, paper/trade.js).
// A copy lives in yinghui02/t-monitor for the dashboard API; keep the two in step.
// State lives in $STATE_DIR (the `paper` branch in CI): state.json = cash + spot positions + futures
// positions, log.jsonl = one line per trade or hold decision. Prices come from Bitget's public spot and
// USDT-M perpetual futures APIs.
const fs = require('fs');
const path = require('path');

const DIR = process.env.STATE_DIR || path.join(__dirname, 'state');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log.jsonl');
const START_CASH = 1000;      // virtual USDT
const FEE = 0.001;            // Bitget spot taker fee
const MIN_VOLUME = 1e7;       // only coins with ≥10M USDT traded in 24h, which keeps out thin small caps
const MAX_WEIGHT = 0.3;       // one coin ≤30% of portfolio value
const MAX_TRADES_PER_RUN = 3;
// Futures: USDT-M perpetuals, isolated margin, one position per coin.
const FUT_FEE = 0.0006;       // Bitget futures taker fee
const MIN_FUT_VOLUME = 1e7;   // futures contracts with ≥10M USDT traded in 24h (≈50 contracts)
const MAX_LEVERAGE = 5;
const MAX_FUT_MARGIN = 0.5;   // all futures margin together ≤50% of portfolio value
const MMR = 0.005;            // maintenance margin rate used for the liquidation price
// Risk rules, partly from JakeNesler/Claude_Prophet's TRADING_RULES.md (the owner asked to learn from it).
const RISK_PER_TRADE = 0.015; // a stopped-out entry loses ≤1.5% of the portfolio (half that after a losing streak)
const LOSS_STREAK = 3;        // this many losing exits in a row halves the risk until a win
const MIN_REWARD_RISK = 1.5;  // take-profit distance ≥1.5× the stop distance
const ATR_STOP = 1.5;         // stop ≥1.5× the coin's average hourly range away, so normal swings don't hit it
const DAILY_LOSS_STOP = 0.05; // no new entries once the portfolio is 5% below where it started the day (UTC+8)
const SIDE_RISK = 0.025;      // all crypto positions on one side together lose ≤2.5% if every stop is hit (BTC and alts move together)
const BOUNCE_NO_SHORT = 0.05; // no new crypto shorts while BTC is ≥5% above its 3-day low: shorts into the rebound after a crash kept failing
const GOLD = 'XAUTUSDT';      // Tether Gold, 1 token = 1 troy oz; the owner wants gold watched every run

function loadState() {
  const s = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {cash: START_CASH, positions: {}, started: new Date().toISOString()};
  s.futures ||= {};
  return s;
}
function saveState(s) {
  fs.mkdirSync(DIR, {recursive: true});
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
}
function readLog() {
  return fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function appendLog(entry) {
  fs.mkdirSync(DIR, {recursive: true});
  fs.appendFileSync(LOG, JSON.stringify({time: new Date().toISOString(), run: process.env.RUN_ID || 'local', ...entry}) + '\n');
}

async function bitget(pathAndQuery) {
  const r = await fetch('https://api.bitget.com' + pathAndQuery, {signal: AbortSignal.timeout(15000)});
  const j = await r.json();
  if (j.code !== '00000') throw new Error(`Bitget ${j.code}: ${j.msg}`);
  return j.data;
}
// symbol → ticker, online crypto/USDT pairs only (Bitget's tokenized stocks have base coins like `rNVDA`).
async function tickers() {
  const [all, symbols] = await Promise.all([bitget('/api/v2/spot/market/tickers'), bitget('/api/v2/spot/public/symbols')]);
  const crypto = new Set(symbols.filter(s => s.quoteCoin === 'USDT' && s.status === 'online' && !/^r[A-Z0-9]/.test(s.baseCoin)).map(s => s.symbol));
  return Object.fromEntries(all.filter(t => crypto.has(t.symbol) && +t.lastPr > 0).map(t => [t.symbol, t]));
}

// symbol → USDT-M perpetual ticker (lastPr, bidPr, askPr, markPrice, fundingRate, usdtVolume, …), crypto only
// (contracts on stocks and other real-world assets are marked isRwa).
async function futuresTickers() {
  const [all, contracts] = await Promise.all([bitget('/api/v2/mix/market/tickers?productType=USDT-FUTURES'), bitget('/api/v2/mix/market/contracts?productType=USDT-FUTURES')]);
  const crypto = new Set(contracts.filter(c => c.isRwa !== 'YES' && c.symbolStatus === 'normal' && c.symbolType === 'perpetual').map(c => c.symbol));
  return Object.fromEntries(all.filter(t => crypto.has(t.symbol) && +t.lastPr > 0).map(t => [t.symbol, t]));
}

// symbol → {h1, h4}: price change over the last 1 and 4 hours, from hourly closes.
// 10 requests per second keeps under Bitget's public rate limit (it answers 429 at ~20/s).
async function recentChanges(symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 10) {
    if (i) await new Promise(r => setTimeout(r, 1000));
    await Promise.all(symbols.slice(i, i + 10).map(async sym => {
      const c = (await bitget(`/api/v2/spot/market/candles?symbol=${sym}&granularity=1h&limit=5`).catch(() => [])).map(k => +k[4]);
      if (c.length === 5) out[sym] = {h1: c[4] / c[3] - 1, h4: c[4] / c[0] - 1};
    }));
  }
  return out;
}

// Average hourly true range over the last 24 hours, spot or perpetual candles.
async function hourlyAtr(symbol, futures) {
  const k = await bitget(futures ? `/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&limit=25`
    : `/api/v2/spot/market/candles?symbol=${symbol}&granularity=1h&limit=25`);
  const c = k.sort((a, b) => a[0] - b[0]).map(x => x.slice(1, 5).map(Number));
  const tr = c.slice(1).map(([, h, l], i) => Math.max(h - l, Math.abs(h - c[i][3]), Math.abs(l - c[i][3])));
  return tr.reduce((a, b) => a + b, 0) / tr.length;
}

// BTC's daily trend: down = below a falling 20-day average, up = above a rising one, otherwise sideways.
// bounce = how far BTC is above the lowest low of the last 3 daily candles (today included).
async function btcTrend() {
  const k = (await bitget('/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=1day&limit=30')).sort((a, b) => a[0] - b[0]), c = k.map(x => +x[4]);
  const sma = end => c.slice(end - 20, end).reduce((a, b) => a + b, 0) / 20;
  const close = c.at(-1), now = sma(c.length), before = sma(c.length - 5);
  const trend = close < now && now < before ? 'down' : close > now && now > before ? 'up' : 'sideways';
  const low3 = Math.min(...k.slice(-3).map(x => +x[3]));
  return {trend, close, sma20: now, sma20Before: before, low3, bounce: close / low3 - 1};
}

// The bot's record from its exits (spot sells, futures closes, liquidations): win rate, average win and loss,
// and how many losses in a row it ended on.
function record(log) {
  const exits = log.filter(e => ['sell', 'close', 'liquidated'].includes(e.action) && e.pnl != null);
  const wins = exits.filter(e => e.pnl > 0), losses = exits.filter(e => e.pnl <= 0), avg = a => a.length ? a.reduce((t, e) => t + e.pnl, 0) / a.length : 0;
  let streak = 0;
  for (let i = exits.length - 1; i >= 0 && exits[i].pnl <= 0; i--) streak++;
  return {exits, wins: wins.length, losses: losses.length, avgWin: avg(wins), avgLoss: avg(losses), total: exits.reduce((t, e) => t + e.pnl, 0), streak};
}

// Where the portfolio stood when today (UTC+8) began, recorded the first time it's asked for each day.
function dayStart(state, total) {
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (state.day?.date !== date) state.day = {date, total};
  return state.day;
}

// BTC price at a past moment (the close of that minute), for the buy-and-hold benchmark.
async function btcAt(time) {
  const t = Date.parse(time);
  const c = await bitget(`/api/v2/spot/market/history-candles?symbol=BTCUSDT&granularity=1min&endTime=${t + 60000}&limit=2`);
  const k = c.filter(k => +k[0] <= t).pop() || c[0];
  return +k[4];
}

// A spot position: {qty, cost, stop, take, checked}. Positions bought before stops existed have none.
// Sells `frac` of a spot position at `price` and logs it; extra = {reason, trigger?}.
function sellSpot(state, symbol, frac, price, extra) {
  const p = state.positions[symbol], qty = p.qty * frac, gross = qty * price, cost = p.cost * frac, back = gross * (1 - FEE);
  state.cash += back;
  if (frac >= 1) delete state.positions[symbol];
  else Object.assign(p, {qty: p.qty - qty, cost: p.cost - cost});
  appendLog({action: 'sell', symbol, price, qty, usdt: back, fee: gross * FEE, pnl: back - cost, ...extra});
  return {qty, back, pnl: back - cost};
}

// A futures position: {side: 'long'|'short', qty, entry, margin, cost (margin + opening fee), leverage, stop, take,
// funding (paid so far, negative = received), opened, checked}. Margin shrinks as funding is paid.
const dir = p => p.side === 'long' ? 1 : -1;
// Isolated liquidation: margin + unrealised pnl falls to the maintenance margin.
function liqPrice(p) {
  return p.side === 'long' ? (p.entry * p.qty - p.margin) / (p.qty * (1 - MMR)) : (p.entry * p.qty + p.margin) / (p.qty * (1 + MMR));
}
const equity = (p, price) => Math.max(0, p.margin + dir(p) * (price - p.entry) * p.qty);

// What the open crypto positions would lose if every stop were hit, by side; gold is left out since it doesn't move
// with BTC. A stop already past the entry has locked in a gain and counts as 0.
function openRisk(state) {
  const r = {long: 0, short: 0};
  for (const [sym, p] of Object.entries(state.positions)) if (sym !== GOLD && p.stop) r.long += Math.max(0, p.cost - p.qty * p.stop * (1 - FEE));
  for (const [sym, p] of Object.entries(state.futures || {})) if (sym !== GOLD && p.stop) r[p.side] += Math.max(0, dir(p) * (p.entry - p.stop) * p.qty + p.qty * p.stop * FUT_FEE);
  return r;
}

// Closes `frac` of a futures position at `price` and logs it; extra = {reason, trigger?}.
function closeFutures(state, symbol, frac, price, extra) {
  const p = state.futures[symbol], qty = p.qty * frac, margin = p.margin * frac, cost = p.cost * frac;
  const fee = qty * price * FUT_FEE, back = Math.max(0, margin + dir(p) * (price - p.entry) * qty - fee);
  state.cash += back;
  if (frac >= 1) delete state.futures[symbol];
  else Object.assign(p, {qty: p.qty - qty, margin: p.margin - margin, cost: p.cost - cost});
  appendLog({action: 'close', symbol, side: p.side, leverage: p.leverage, price, qty, usdt: back, fee, pnl: back - cost, ...extra});
  return {back, pnl: back - cost};
}

// Catches positions up with what happened since they were last checked, against 1-minute candles (15-minute
// when the gap is over 1000 minutes), in time order: spot stop-loss / take-profit, and for futures funding
// settlements, stop-loss / take-profit and liquidation. Within one candle the stop counts before the take-profit.
// Times in log reasons are UTC+8. Returns lines describing what happened.
const utc8 = ms => new Date(ms + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
async function settle(state) {
  const out = [], now = Date.now();
  for (const [symbol, p] of Object.entries(state.positions)) {
    if (!p.stop || !p.checked) continue;
    const from = Date.parse(p.checked);
    const candles = await bitget(`/api/v2/spot/market/candles?symbol=${symbol}&granularity=${now - from > 1000 * 60000 ? '15min' : '1min'}&startTime=${from}&endTime=${now}&limit=1000`);
    p.checked = new Date(now).toISOString();
    for (const k of candles.sort((a, b) => a[0] - b[0])) {
      const [high, low] = [+k[2], +k[3]];
      const hit = low <= p.stop ? ['stop', p.stop, '止损'] : p.take && high >= p.take ? ['take', p.take, '止盈'] : null;
      if (!hit) continue;
      const r = sellSpot(state, symbol, 1, hit[1], {trigger: hit[0], reason: `${utc8(+k[0])} 触发${hit[2]} ${hit[1]}`});
      out.push(`${symbol} spot ${hit[0] === 'stop' ? 'stop-loss' : 'take-profit'} hit at ${hit[1]} (${utc8(+k[0])}), pnl ${r.pnl.toFixed(2)} USDT`);
      break;
    }
  }
  for (const [symbol, p] of Object.entries(state.futures)) {
    const from = Date.parse(p.checked);
    const [rates, candles] = await Promise.all([
      bitget(`/api/v2/mix/market/history-fund-rate?symbol=${symbol}&productType=USDT-FUTURES&pageSize=50`),
      bitget(`/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${now - from > 1000 * 60000 ? '15m' : '1m'}&startTime=${from}&endTime=${now}&limit=1000`)]);
    const due = rates.filter(r => +r.fundingTime > from && +r.fundingTime <= now).sort((a, b) => a.fundingTime - b.fundingTime);
    let price = p.entry;
    const fund = until => {
      while (due.length && +due[0].fundingTime <= until) {
        const r = due.shift(), paid = dir(p) * +r.fundingRate * p.qty * price;
        p.margin -= paid; p.funding = (p.funding || 0) + paid;
        out.push(`${symbol} funding ${(+r.fundingRate * 100).toFixed(4)}% → ${paid >= 0 ? 'paid' : 'received'} ${Math.abs(paid).toFixed(4)} USDT`);
      }
    };
    p.checked = new Date(now).toISOString();
    for (const k of candles.sort((a, b) => a[0] - b[0])) {
      fund(+k[0]);
      const [high, low] = [+k[2], +k[3]], liq = liqPrice(p), long = p.side === 'long';
      const hit = level => long ? low <= level : high >= level, nearer = (a, b) => long ? Math.max(a, b) : Math.min(a, b);
      const at = utc8(+k[0]);
      if (hit(nearer(p.stop, liq))) {
        if (nearer(p.stop, liq) === p.stop) {
          const r = closeFutures(state, symbol, 1, p.stop, {trigger: 'stop', reason: `${at} 触发止损 ${p.stop}`});
          out.push(`${symbol} ${p.side} stop-loss hit at ${p.stop} (${at}), pnl ${r.pnl.toFixed(2)} USDT`);
        } else {
          delete state.futures[symbol];
          appendLog({action: 'liquidated', symbol, side: p.side, leverage: p.leverage, price: liq, qty: p.qty, usdt: 0, pnl: -p.cost, reason: `${at} 价格触及强平价 ${liq.toPrecision(6)}，保证金全部亏损`});
          out.push(`${symbol} ${p.side} LIQUIDATED at ${liq.toPrecision(6)} (${at}), lost ${p.cost.toFixed(2)} USDT`);
        }
        break;
      }
      if (long ? high >= p.take : low <= p.take) {
        const r = closeFutures(state, symbol, 1, p.take, {trigger: 'take', reason: `${at} 触发止盈 ${p.take}`});
        out.push(`${symbol} ${p.side} take-profit hit at ${p.take} (${at}), pnl ${r.pnl.toFixed(2)} USDT`);
        break;
      }
      price = +k[4];
    }
    if (state.futures[symbol]) fund(now);
  }
  return out;
}

function value(state, tk, ftk = {}) {
  const positions = Object.entries(state.positions).map(([sym, p]) => {
    const price = +(tk[sym]?.bidPr || tk[sym]?.lastPr || 0);
    return {symbol: sym, qty: p.qty, cost: p.cost, price, value: p.qty * price, pnlPct: p.cost ? (p.qty * price / p.cost - 1) * 100 : 0, stop: p.stop, take: p.take};
  });
  const futures = Object.entries(state.futures || {}).map(([sym, p]) => {
    const price = +(ftk[sym]?.lastPr || p.entry), value = equity(p, price);
    return {symbol: sym, side: p.side, leverage: p.leverage, qty: p.qty, entry: p.entry, price, margin: p.margin, cost: p.cost,
      stop: p.stop, take: p.take, liq: liqPrice(p), funding: p.funding || 0, value, pnlPct: (value / p.cost - 1) * 100};
  });
  const sum = a => a.reduce((t, p) => t + p.value, 0);
  return {cash: state.cash, positions, futures, total: state.cash + sum(positions) + sum(futures)};
}

module.exports = {GOLD, START_CASH, FEE, MIN_VOLUME, MAX_WEIGHT, MAX_TRADES_PER_RUN, FUT_FEE, MIN_FUT_VOLUME, MAX_LEVERAGE, MAX_FUT_MARGIN,
  RISK_PER_TRADE, LOSS_STREAK, MIN_REWARD_RISK, ATR_STOP, DAILY_LOSS_STOP, SIDE_RISK, BOUNCE_NO_SHORT,
  loadState, saveState, readLog, appendLog, bitget, tickers, futuresTickers, recentChanges, hourlyAtr, btcTrend, record, dayStart, btcAt,
  liqPrice, openRisk, sellSpot, closeFutures, settle, value};
