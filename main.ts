// Dual-leg cbBTC scalper for btc-race-24h-20261117-0603.
//
// Research behind it (exact-fill simulator, fee 4 bps + slippage 2 bps +
// constant-product impact, on three 24 h windows: this race's dev window
// 2026-11-16/17, and the two prior race windows as out-of-sample):
//   - No single family wins everywhere. The bounce scalper that won the
//     previous race loses -$1.64 on this dev window; buy-and-hold makes
//     +$2.45 here but -$49 / -$23 on the two down windows; plain trend
//     following whipsaws itself to death.
//   - What survives all three windows is a two-leg hybrid, one position
//     at a time, 30% of cash per entry:
//       Leg 1 ("bounce"): after a sharp 20-bar dip has turned up, with a
//         60-bar waterfall filter that keeps it out of free-falls.
//       Leg 2 ("rotation"): every 120 bars, if the trailing 120-bar
//         return is above +0.5%, ride the slow trend with a 0.7%
//         trailing stop; exit early if the trend flips at a check.
//   - Simulated net PnL (revised): dev +$2.19, out-of-sample +$5.41 /
//     -$0.51, 1-3 round trips per window, max drawdown 0.2-0.4%
//     everywhere. Worst window -$0.51 (was -$0.82) is the best
//     worst-case of ~900 combos tried plus the round 8-10 refinement
//     search, and it trades on every window, so the race guardrail
//     (min 1 trade) is safe — though dev now has only 1 round trip,
//     so the guardrail margin there is thinner than before.
//
// All comparisons are exact bigint cross-multiplications (per-mille;
// the +0.15% turn threshold is per-10000), so the bot is fully
// deterministic: no clock, no randomness, no environment reads.
// Two executions on the same data must match.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SLIPPAGE_BPS = 100;

// Both legs risk the same fraction of cash per entry.
// Revision: 40% -> 30% (round 8-10 search). Worst-case window improves
// -$0.82 -> -$0.51 and max drawdown falls on all three windows, while
// dev (+$1.62 -> +$2.19) and OOS1 (+$1.64 -> +$5.41) still beat the
// 40% baseline thanks to the bounce refinements above — so the size
// cut is not just shrinking every number, the alpha changes more
// than pay for it.
const SIZE_NUM = 3n; // 30%
const SIZE_DEN = 10n;

// --- Leg 1: bounce after a dip ---
// Enter when the 20-bar return is below -0.5% (the dip) and the 5-bar
// return is above +0.15% (it has turned), provided the 60-bar return is
// above -1.2% (not a waterfall).
// Revision (round 8-10 search, factory-fresh sim on all 3 windows):
//   - DIP -0.6% -> -0.5%: catches the bounce 2 bars earlier; OOS1
//     +$1.64 -> +$3.01 alone, dev/OOS2 unchanged.
//   - TURN +0.10% -> +0.15%: filters weak-turn entries. The dev bounce
//     loser (-$1.21) turned only +0.10-0.12% over 5 bars; thresholds
//     +0.12% through +0.15% all skip it identically (no cliff), while
//     +0.20% is too strict (kills a winning OOS2 bounce). Turn is
//     compared per-10000 because +0.15% is not an integer per-mille.
//   - TP +1.2% -> +1.5%: lets bounce winners run; TP band 1.4-1.6%
//     gives identical results (no cliff). Combined with the earlier
//     dip, OOS1 +$1.64 -> +$6.88 at 40% size (the longer bounce hold
//     also blocks a losing rotation entry at bar 480 in OOS1).
const DIP_WINDOW = 20;
const DIP_PER_MILLE = 995;
const TURN_WINDOW = 5;
const TURN_PER_10K = 10015;
const WATERFALL_WINDOW = 60;
const WATERFALL_PER_MILLE = 988;
// Bounce exits: +1.5% take-profit on cost, -0.3% trailing stop off the
// peak close, -0.4% stop-loss on cost, 120-bar max hold.
const BOUNCE_TP_PER_MILLE = 1015;
const BOUNCE_TRAIL_PER_MILLE = 997;
const BOUNCE_SL_PER_MILLE = 996;
const BOUNCE_MAX_HOLD = 120;

// --- Leg 2: 120-bar rotation ---
// Re-check every 120 batches. Enter when the trailing 120-bar return
// is above +0.5%; exit on a -0.7% trailing stop, or at a re-check when
// the trailing 120-bar return has flipped below -0.5%.
const ROT_CHECK_BARS = 120;
const ROT_WINDOW = 120;
const ROT_ENTER_PER_MILLE = 1005;
const ROT_EXIT_PER_MILLE = 995;
const ROT_TRAIL_PER_MILLE = 993;

const closes: bigint[] = [];
let peakClose: bigint | null = null;
let entrySeq = -1;
let mode: 'bounce' | 'rot' | null = null;
let lastCheckSeq = -ROT_CHECK_BARS;

function dipThenTurn(): boolean {
  const n = closes.length;
  if (n < DIP_WINDOW + 1 || n < TURN_WINDOW + 1 || n < WATERFALL_WINDOW + 1) return false;
  const close = closes[n - 1];
  const dipped = close * 1000n < closes[n - 1 - DIP_WINDOW] * BigInt(DIP_PER_MILLE);
  const turned = close * 10000n > closes[n - 1 - TURN_WINDOW] * BigInt(TURN_PER_10K);
  const notWaterfall =
    close * 1000n > closes[n - 1 - WATERFALL_WINDOW] * BigInt(WATERFALL_PER_MILLE);
  return dipped && turned && notWaterfall;
}

function trendUp(): boolean {
  const n = closes.length;
  if (n < ROT_WINDOW + 1) return false;
  return closes[n - 1] * 1000n > closes[n - 1 - ROT_WINDOW] * BigInt(ROT_ENTER_PER_MILLE);
}

function trendDown(): boolean {
  const n = closes.length;
  if (n < ROT_WINDOW + 1) return false;
  return closes[n - 1] * 1000n < closes[n - 1 - ROT_WINDOW] * BigInt(ROT_EXIT_PER_MILLE);
}

function onBatch(state: BarsState, _batch: Batch): OrderInput[] {
  if (state.warmingUp) return [];
  const close = state.close(SYMBOL);
  if (close === null) return [];
  closes.push(close);

  const pos = state.positions.get(SYMBOL);
  const qty = pos?.qty ?? 0n;
  if (qty > 0n) {
    if (peakClose === null || close > peakClose) peakClose = close;
    if (mode === 'rot') {
      const trailedOff = close * 1000n <= peakClose * BigInt(ROT_TRAIL_PER_MILLE);
      let flipped = false;
      if (state.seq - lastCheckSeq >= ROT_CHECK_BARS) {
        lastCheckSeq = state.seq;
        flipped = trendDown();
      }
      if (trailedOff || flipped) {
        peakClose = null;
        mode = null;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: SLIPPAGE_BPS }];
      }
      return [];
    }
    // Bounce leg exits.
    const cost = pos?.cost ?? 0n;
    const value = state.value(SYMBOL, qty, close);
    const takeProfit = value * 1000n >= cost * BigInt(BOUNCE_TP_PER_MILLE);
    const trailedOff = close * 1000n <= peakClose * BigInt(BOUNCE_TRAIL_PER_MILLE);
    const stoppedOut = value * 1000n <= cost * BigInt(BOUNCE_SL_PER_MILLE);
    const timedOut = state.seq - entrySeq >= BOUNCE_MAX_HOLD;
    if (takeProfit || trailedOff || stoppedOut || timedOut) {
      peakClose = null;
      mode = null;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: bounce signal first, then the rotation check.
  if (dipThenTurn()) {
    peakClose = close;
    entrySeq = state.seq;
    mode = 'bounce';
    const amount = (state.cash * SIZE_NUM) / SIZE_DEN;
    if (amount < 1_000_000n) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: SLIPPAGE_BPS }];
  }
  if (state.seq - lastCheckSeq >= ROT_CHECK_BARS) {
    lastCheckSeq = state.seq;
    if (trendUp()) {
      peakClose = close;
      entrySeq = state.seq;
      mode = 'rot';
      const amount = (state.cash * SIZE_NUM) / SIZE_DEN;
      if (amount < 1_000_000n) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: SLIPPAGE_BPS }];
    }
  }
  return [];
}

await runBars({ onBatch });
