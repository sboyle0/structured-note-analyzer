// api/analyze-cusip.js
//
// Phase 1: stable, safe function that:
// - Accepts ?cusip=XXXX
// - Uses sec-api.io to find the most recent 424B2 (or similar) filing
// - Returns filing metadata + a placeholder "note" object
//
// This should NOT crash, even if:
// - CUSIP has no filings
// - SEC-API key is missing
// - SEC-API returns an error

const SEC_API_BASE = "https://api.sec-api.io";

module.exports = async (req, res) => {
  // Always return JSON
  res.setHeader("Content-Type", "application/json");

  try {
    const { cusip } = req.query || {};

    if (!cusip) {
      res.status(400).json({ error: "Missing ?cusip= query parameter" });
      return;
    }

    const token = process.env.SEC_API_KEY;
    if (!token) {
      // Don’t crash if env var missing – just report clearly
      res.status(500).json({
        error: "SEC_API_KEY environment variable is not set on Vercel",
      });
      return;
    }

    // --- 1) Call SEC-API Query API to find the most recent structured note filing ---

    // We prefer prospectus / structured note forms like: 424B2, 424B3, FWP etc.
    // This is a simple starting query: you can refine later.
    const queryBody = {
      query: `cusip:"${cusip}" AND (formType:"424B2" OR formType:"424B3" OR formType:"FWP")`,
      from: 0,
      size: 1,
      sort: [{ filedAt: { order: "desc" } }],
    };

    const searchResponse = await fetch(`${SEC_API_BASE}?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(queryBody),
    });

    if (!searchResponse.ok) {
      const text = await searchResponse.text().catch(() => "");
      throw new Error(
        `SEC-API search failed with status ${searchResponse.status}: ${text}`
      );
    }

    const searchJson = await searchResponse.json();

    const filing = searchJson && searchJson.filings && searchJson.filings[0];

    if (!filing) {
      // No matching filing – return a clear JSON message (don’t crash)
      res.status(404).json({
        source: "sec-api.io",
        cusip,
        filingMeta: null,
        note: null,
        message: "No 424B2 / FWP filings found for this CUSIP.",
      });
      return;
    }

    const filingMeta = {
      accessionNo: filing.accessionNo,
      formType: filing.formType,
      filedAt: filing.filedAt,
      companyName: filing.companyName,
      cik: filing.cik,
      linkToFilingDetails: filing.linkToFilingDetails,
    };

    // --- 2) PHASE 1: placeholder note object ---
    //
    // In the next phase, we’ll:
    // - Download the full filing text (via sec-api Filing Download API)
    // - Send it to OpenAI (ChatGPT) to extract trade date, coupon, barriers, etc.
    //
    // For now, we just return a stub note so your app.html has a consistent shape
    // and the function does NOT crash.

    const placeholderNote = {
      issuer: "Issuer from filing",
      issuer_sub: "Parsed issuer description will go here.",
      trade_date: "To be parsed",
      maturity_date: "To be parsed",
      product_type: "To be parsed (e.g. Autocallable Contingent Income Note)",
      profile_key: "To be parsed (e.g. autocallable_single_underlier_barrier)",
      coupon: {
        label:
          "To be parsed (e.g. 8.50% p.a. contingent quarterly coupon)",
        structure: "To be parsed from document.",
        barrier: "To be parsed from document.",
      },
      protection: {
        label: "To be parsed (e.g. 70% European barrier)",
        principal: "To be parsed.",
        downside: "To be parsed.",
      },
      underliers: [],
      payoff_today: {
        amount_per_1000: null,
        pct_of_par: null,
        status: "Not yet calculated",
        status_variant: "upside",
        explanation:
          "Payoff logic not yet implemented for live data.",
        subtitle: "Phase 1 – only filing lookup is live.",
      },
    };

    // --- 3) Respond with combined object ---

    res.status(200).json({
      source: "sec-api.io",
      cusip,
      filingMeta,
      rawTextPreview: null, // future: short excerpt of the filing once we download it
      note: placeholderNote,
    });
  } catch (err) {
    // Don't let the function crash without a clean JSON error
    console.error("analyze-cusip error:", err);
    res.status(500).json({
      error: "Internal server error in /api/analyze-cusip",
      message: err.message || String(err),
    });
  }
};

