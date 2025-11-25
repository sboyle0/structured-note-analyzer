// api/analyze-cusip.js
// Serverless function on Vercel: /api/analyze-cusip?cusip=48136H7D4

export default async function handler(req, res) {
  try {
    const { cusip } = req.query;

    if (!cusip) {
      return res.status(400).json({ message: "Missing ?cusip= parameter" });
    }

    const SEC_API_KEY = process.env.SEC_API_KEY;
    if (!SEC_API_KEY) {
      return res.status(500).json({
        message: "SEC_API_KEY is not set in Vercel environment variables."
      });
    }

    // 1) Use sec-api.io Query API to look for 424B2 / FWP filings
    //    where the CUSIP appears anywhere in the text.
    const queryPayload = {
      query: `formType:(\"424B2\" OR \"FWP\") AND fullText:\"${cusip}\"`,
      from: "0",
      size: "1",
      sort: [{ filedAt: { order: "desc" } }]
    };

    const filingsRes = await fetch("https://api.sec-api.io", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: SEC_API_KEY
      },
      body: JSON.stringify(queryPayload)
    });

    if (!filingsRes.ok) {
      const text = await filingsRes.text();
      console.error("sec-api query error:", filingsRes.status, text);
      return res.status(500).json({
        message: "Error calling sec-api.io query endpoint.",
        status: filingsRes.status,
        body: text
      });
    }

    const filingsJson = await filingsRes.json();
    const filing = filingsJson && filingsJson.filings && filingsJson.filings[0];

    if (!filing) {
      return res.status(200).json({
        source: "sec-api.io",
        cusip,
        filingMeta: null,
        note: null,
        message: "No 424B2 / FWP filings found for this CUSIP (full-text search)."
      });
    }

    const filingMeta = {
      accessionNo: filing.accessionNo,
      formType: filing.formType,
      filedAt: filing.filedAt,
      companyName: filing.companyName,
      cik: filing.cik,
      linkToHtml: filing.linkToHtml
    };

    // 2) Download the full HTML text of the filing
    //    We’ll use sec-api.io's "filing-text" endpoint for simplicity.
    const filingTextRes = await fetch(
      `https://api.sec-api.io/filing-text?accessionNo=${encodeURIComponent(
        filing.accessionNo
      )}`,
      {
        headers: {
          Authorization: SEC_API_KEY
        }
      }
    );

    if (!filingTextRes.ok) {
      const text = await filingTextRes.text();
      console.error("sec-api filing-text error:", filingTextRes.status, text);
      return res.status(500).json({
        source: "sec-api.io",
        cusip,
        filingMeta,
        note: null,
        message: "Found filing, but failed to download filing text."
      });
    }

    const rawText = await filingTextRes.text();

    // 3) For now, we are NOT yet using an AI model to parse the document.
    //    We just return:
    //    - filing metadata
    //    - a short preview of the raw text
    //    - a stub "note" object that your frontend already understands
    const rawTextPreview =
      rawText.length > 1000 ? rawText.slice(0, 1000) + "…" : rawText;

    const noteStub = {
      issuer: filing.companyName || "Issuer from filing",
      issuer_sub: "Parsed issuer description will go here.",
      trade_date: "To be parsed",
      maturity_date: "To be parsed",
      product_type: "To be parsed (e.g. Autocallable Contingent Income Note)",
      profile_key: "To be parsed (e.g. autocallable_single_underlier_barrier)",
      coupon: {
        label:
          "To be parsed (e.g. 8.50% p.a. contingent quarterly coupon)",
        structure: "To be parsed from document.",
        barrier: "To be parsed from document."
      },
      protection: {
        label: "To be parsed (e.g. 70% European barrier)",
        principal: "To be parsed.",
        downside: "To be parsed."
      },
      underliers: [],
      payoff_today: {
        amount_per_1000: null,
        pct_of_par: null,
        status: "Not yet calculated",
        status_variant: "upside",
        explanation:
          "Payoff logic not yet implemented for live data.",
        subtitle: "Phase 1 – only filing lookup + text fetch is live."
      }
    };

    return res.status(200).json({
      source: "sec-api.io",
      cusip,
      filingMeta,
      rawTextPreview,
      note: noteStub
    });
  } catch (err) {
    console.error("analyze-cusip internal error:", err);
    return res.status(500).json({
      message: "Internal error in analyze-cusip function.",
      error: String(err && err.message ? err.message : err)
    });
  }
}
