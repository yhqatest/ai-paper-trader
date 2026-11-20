# AI paper trader

Claude trades a simulated 1,000 USDT portfolio on Bitget spot and USDT-M perpetual futures prices every 30 minutes. No real money and no exchange keys are involved: prices come from Bitget's public API and orders are only recorded.

- `paper/market.js`: what the bot looks at (portfolio, recent decisions, BTC/ETH/gold, 1h/4h/24h movers, funding rates, candles for one coin). It first settles futures: funding, stop-loss, take-profit and liquidation against 1-minute candles since the last run.
- `paper/trade.js`: records spot buys and sells at the live ask or bid with a 0.1% fee; futures longs, shorts and closes (isolated margin, up to 5x, 0.06% fee, stop-loss and take-profit required); hold decisions and a gold view. It enforces the rules: only coins with at least 1M USDT of 24h volume (futures 10M, crypto contracts only), at most 30% of the portfolio in one coin (futures: margin), futures margin at most 50% in total, at most 3 trades per run.
- `paper/prompt.md`: the instructions Claude follows each run.
- `.github/workflows/paper-trade.yml`: runs it. State (`state.json`) and every decision with its reason (`log.jsonl`) are committed to the `paper` branch.

Try it locally: `node paper/market.js`, `node paper/market.js XAUTUSDT` (state goes to `paper/state/`).
