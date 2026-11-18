# AI paper trader

Claude trades a simulated 1,000 USDT portfolio on Bitget spot prices every 30 minutes. No real money and no exchange keys are involved: prices come from Bitget's public API and orders are only recorded.

- `paper/market.js`: what the bot looks at (portfolio, recent decisions, BTC/ETH/gold, 1h/4h/24h movers, candles for one coin).
- `paper/trade.js`: records buys and sells at the live ask or bid with a 0.1% fee, plus hold decisions and a gold view. It enforces the rules: only coins with at least 1M USDT of 24h volume, at most 30% of the portfolio in one coin, at most 3 trades per run.
- `paper/prompt.md`: the instructions Claude follows each run.
- `.github/workflows/paper-trade.yml`: runs it. State (`state.json`) and every decision with its reason (`log.jsonl`) are committed to the `paper` branch.

Try it locally: `node paper/market.js`, `node paper/market.js XAUTUSDT` (state goes to `paper/state/`).
