// api/analyze-cusip.js

// This version does NOT use the sec-api Node SDK.
// It calls the SEC-API Full-Text Search HTTP endpoint directly via fetch.

export default async function handler(req, res) {
  try {
    const { cusip } = req.query;

    if (!cusip) {
      return res.status(400).json({ error: "Missing ?cusip= query parameter" });
    }

    const apiKey = process.env.SEC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "SEC_API_KEY environment variable is not set on Vercel.",
      });
    }

    // Build full-text search query:
    // - Search for this CUSIP as an exact phrase
    // - Restrict to 424B2 and FWP (pricing supplements / free writing prospectuses)
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const body = {
      query: `"${cusip}"`,
      formTypes: ["424B2", "FWP"],
      startDate: "2001-01-01",
      endDate: today,
      page: "1",
    };

    const response = await fetch(
      `https://api.sec-api.io/full-text-search?token=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => null);
      return res.status(500).json({
        message: "SEC-API full-text search HTTP error",
        status: response.status,
        body: text,
      });
    }

    const data = await response.json();

    // SEC-API docs: response usually has `filings` array
    const filings = Array.isArray(data.filings) ? data.filings : [];

    if (filings.length === 0) {
      return res.status(404).json({
        source: "sec-api.io",
        cusip,
        message:
          "No 424B2 / FWP filings found for this CUSIP via full-text search.",
        rawResponseSnippet: JSON.stringify(data).slice(0, 500),
      });
    }

    const first = filings[0];

    // Return clean metadata for the first match.
    // Later we’ll use linkToHtml or linkToFilingDetails to fetch and parse the full document.
    return res.status(200).json({
      source: "sec-api.io",
      cusip,
      filingsCount: filings.length,
      filingMeta: {
        accessionNo: first.accessionNo,
        formType: first.formType,
        filedAt: first.filedAt,
        companyName: first.companyName,
        cik: first.cik,
        linkToFilingDetails: first.linkToFilingDetails,
        linkToHtml: first.linkToHtml,
      },
      message:
        "Found at least one filing containing this CUSIP via full-text search.",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error",
      error: err && err.message ? err.message : String(err),
    });
  }
}
