# btc-race-20261117 — dual-leg cbBTC scalper

Entry for make.fun `btc-race-24h-20261117-0603` ("Race a BTC trading bot
live for 24 hours"). The bot trades Coinbase Wrapped BTC (cbBTC) against
USDC, minute by minute, long-only, starting from $1,000 of paper money.

## Strategy

Two legs, one open position at a time, 40% of cash per entry. All
comparisons are exact bigint arithmetic (per-mille), so the bot is fully
deterministic: no clock, no randomness, no network, no files outside
the repo.

- **Bounce leg.** After a sharp 20-bar dip (return below -0.6%) has
  turned up (5-bar return above +0.1%), provided the 60-bar return is
  above -1.2% (waterfall filter). Exits: +1.2% take-profit on cost,
  -0.3% trailing stop off the peak close, -0.4% stop-loss on cost,
  120-bar max hold.
- **Rotation leg.** Every 120 batches, if the trailing 120-bar return
  is above +0.5%, ride the slow trend with a -0.7% trailing stop;
  exit early at a re-check if the trend has flipped below -0.5%.

## Backtest (exact-fill simulator: 4 bps fee + 2 bps slippage + pool impact)

| Window | Net PnL | Trades | Max drawdown |
| --- | --- | --- | --- |
| Dev 2026-11-16/17 | +$1.62 | 4 | 0.33% |
| Out-of-sample 2026-11-12/13 | +$1.64 | 6 | 0.60% |
| Out-of-sample 2026-11-11/12 | -$0.82 | 4 | 0.30% |

Local grade (`node cli/makefun.mjs grade-local --driver process`) on the
dev kit reproduces the simulator exactly: net PnL **+$1.622909**,
4 trades, max drawdown 0.33%, identical `result_sha256` across runs.

## Layout

- `main.ts` — the bot (Node 22, standard library only)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK

## License

MIT
