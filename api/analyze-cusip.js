// api/analyze-cusip.js
// Simple stub: returns mock data for now.
// Later we’ll plug in EDGAR + ChatGPT + market data here.

export default function handler(req, res) {
  const { cusip } = req.query || {};

  if (!cusip) {
    return res.status(400).json({ error: 'Missing "cusip" query parameter.' });
  }

  // Very simple example object – shape is similar to what app.html expects.
  const note = {
    cusip: String(cusip),
    issuer: 'Example Bank N.A.',
    issuer_sub: 'Senior unsecured obligations, distributed via Example Securities LLC.',
    trade_date: 'Jan 12, 2024',
    maturity_date: 'Jan 12, 2029',
    product_type: 'Autocallable Contingent Income Note',
    profile_key: 'Autocallable · single underlier · barrier',
    coupon: {
      label: '8.50% p.a. contingent, quarterly',
      structure:
        'Pays 8.50% per year, quarterly, if the underlier is at or above the coupon barrier on the observation date.',
      barrier:
        '70% of the initial underlier level on each coupon observation date.',
    },
    protection: {
      label: '70% European barrier',
      principal:
        'Principal is repaid at par if the final underlier level is at or above 70% of its initial level.',
      downside:
        'If the final underlier level is below 70% of its initial level, principal loss matches the underlier loss.',
    },
    underliers: [
      {
        name: 'SPDR® S&P 500® ETF Trust',
        ticker: 'SPY',
        role: 'Sole underlier',
        initial_level: 477.25,
      },
    ],
    payoff_today: {
      amount_per_1000: 1032.5,
      pct_of_par: 103.25,
      status: 'Above par (illustrative)',
      status_variant: 'upside',
      explanation:
        'In this example, the underlier is above its initial level and above the barrier. If today were the final valuation date, the note would repay principal at par plus the final coupon, or approximately $1,032.50 per $1,000 notional.',
      subtitle:
        'Sample only. In production this would use current market data.',
    },
  };

  res.status(200).json(note);
}
