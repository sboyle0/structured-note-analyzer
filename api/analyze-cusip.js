// api/analyze-cusip.js
//
// Simple, defensive handler that:
// - Calls sec-api.io full-text search over EDGAR
// - Looks for most recent filing that matches that CUSIP
// - Returns basic metadata + links
// - Never assumes arrays exist before checking them

export default async function handler(req, res) {
  try {
    const { cusip } = req.query;

    if (!cusip) {
      return res.status(400).json({
        message: "CUSIP missing in query string, e.g. ?cusip=48136H7D4"
      });
    }

    const apiKey = process.env.SEC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        message: "SEC_API_KEY environment variable is not set in Vercel."
      });
    }

    // Full-text search query: look for this CUSIP in 424B2 or FWP
    const searchBody = {
  query: {
    query_string: {
      // Just search for this CUSIP anywhere in the filing text,
      // then we take the most recent hit.
      query: `"${cusip}"`
    }
  },
  from: 0,
  size: 1, // only the latest filing
  sort: [{ filedAt: { order: "desc" } }]
};

    const response = await fetch("https://api.sec-api.io/full-text-search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // sec-api.io expects the API token here
        Authorization: apiKey
      },
      body: JSON.stringify(searchBody)
    });

    // Read the raw body first so we can return it even on non-OK status
    const rawText = await response.text();

    if (!response.ok) {
      // Do NOT throw – just surface whatever sec-api.io sent
      return res.status(response.status).json({
        message: "sec-api.io returned a non-OK status",
        status: response.status,
        body: rawText
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(500).json({
        message: "Could not parse JSON from sec-api.io",
        raw: rawText
      });
    }

    // sec-api full-text search usually returns { filings: [...] }
    const filings = Array.isArray(data.filings) ? data.filings : [];

    if (filings.length === 0) {
      // Nothing crashed; we just didn’t find a filing
      return res.status(404).json({
        source: "sec-api.io",
        cusip,
        filingsCount: 0,
        filingMeta: null,
        message:
          "No 424B2 / FWP filings found for this CUSIP (full-text search).",
        raw: data
      });
    }

    // Take the most recent filing
    const filing = filings[0] || {};

    return res.status(200).json({
      source: "sec-api.io",
      cusip,
      filingsCount: filings.length,
      filingMeta: {
        accessionNo: filing.accessionNo || null,
        formType: filing.formType || null,
        filedAt: filing.filedAt || null,
        cik: filing.cik || null,
        companyName: filing.companyNameLong || filing.companyName || null
      },
      linkToHtml: filing.linkToHtml || null,
      linkToFilingDetails: filing.linkToFilingDetails || null,
      message:
        "Found at least one filing containing this CUSIP via full-text search.",
      // Optional: you can keep this around for debugging if you want
      // raw: data
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error in /api/analyze-cusip",
      error: err.toString()
    });
  }
}
