// Shared helpers for the AI paper-trading bot (paper/market.js, paper/trade.js).
// A copy lives in yinghui02/t-monitor for the dashboard API; keep the two in step.
// State lives in $STATE_DIR (the `paper` branch in CI): state.json = cash + positions,
// log.jsonl = one line per trade or hold decision. Prices come from Bitget's public spot API.
const fs = require('fs');
const path = require('path');

const DIR = process.env.STATE_DIR || path.join(__dirname, 'state');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log.jsonl');
const START_CASH = 1000;      // virtual USDT
const FEE = 0.001;            // Bitget spot taker fee
const MIN_VOLUME = 1e6;       // only coins with ≥1M USDT traded in 24h (≈40 coins)
const MAX_WEIGHT = 0.3;       // one coin ≤30% of portfolio value
const MAX_TRADES_PER_RUN = 3;
const GOLD = 'XAUTUSDT';      // Tether Gold, 1 token = 1 troy oz; the owner wants gold watched every run

function loadState() {
  if (!fs.existsSync(STATE)) return {cash: START_CASH, positions: {}, started: new Date().toISOString()};
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
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

// BTC price at a past moment (the close of that minute), for the buy-and-hold benchmark.
async function btcAt(time) {
  const t = Date.parse(time);
  const c = await bitget(`/api/v2/spot/market/history-candles?symbol=BTCUSDT&granularity=1min&endTime=${t + 60000}&limit=2`);
  const k = c.filter(k => +k[0] <= t).pop() || c[0];
  return +k[4];
}

function value(state, tk) {
  const positions = Object.entries(state.positions).map(([sym, p]) => {
    const price = +(tk[sym]?.bidPr || tk[sym]?.lastPr || 0);
    return {symbol: sym, qty: p.qty, cost: p.cost, price, value: p.qty * price, pnlPct: p.cost ? (p.qty * price / p.cost - 1) * 100 : 0};
  });
  return {cash: state.cash, positions, total: state.cash + positions.reduce((a, p) => a + p.value, 0)};
}

module.exports = {GOLD, START_CASH, FEE, MIN_VOLUME, MAX_WEIGHT, MAX_TRADES_PER_RUN, loadState, saveState, readLog, appendLog, bitget, tickers, recentChanges, btcAt, value};
