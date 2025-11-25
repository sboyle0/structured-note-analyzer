export default async function handler(req, res) {
  try {
    const cusip = req.query.cusip;
    const apiKey = process.env.SEC_API_KEY;

    if (!cusip) {
      return res.status(400).json({ message: "CUSIP missing" });
    }

    if (!apiKey) {
      return res.status(500).json({
        message: "SEC_API_KEY environment variable is not set on Vercel."
      });
    }

    // Full-Text Search query: find filings that contain this exact CUSIP
    const fullTextQuery = {
      query: `"${cusip}"`,                 // exact phrase search
      formTypes: ["424B2", "FWP"],        // pricing supplements
      from: 0,
      size: 10,                           // first 10 matches is plenty
      sort: [{ filedAt: { order: "desc" } }]
    };

    // Call sec-api.io Full-Text Search API via REST
    // API key passed as query param: ?apiKey=YOUR_KEY
    const url = "https://api.sec-api.io/full-text-search?apiKey=" +
      encodeURIComponent(apiKey);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(fullTextQuery)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return res.status(502).json({
        message: "sec-api.io returned a non-OK status",
        status: response.status,
        body: text
      });
    }

    const data = await response.json();

    const filings = Array.isArray(data.filings) ? data.filings : [];
    const filingsCount = filings.length;

    if (filingsCount === 0) {
      return res.status(404).json({
        source: "sec-api.io",
        cusip,
        filingsCount,
        filingMeta: null,
        message:
          "No 424B2 / FWP filings found for this CUSIP (full-text search)."
      });
    }

    // Take the most recent match
    const first = filings[0];

    return res.status(200).json({
      source: "sec-api.io",
      cusip,
      filingsCount,
      filingMeta: {
        accessionNo: first.accessionNo,
        formType: first.formType,
        filedAt: first.filedAt,
        cik: first.cik,
        companyName: first.companyName,
        linkToHtml: first.linkToHtml,
        linkToFilingDetails: first.linkToFilingDetails
      },
      message:
        "Found at least one filing containing this CUSIP via full-text search."
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.toString()
    });
  }
}

