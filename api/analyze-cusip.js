// api/analyze-cusip.js

// This version does NOT use the sec-api Node SDK at all.
// It talks directly to the HTTP endpoints using fetch.

const FULL_TEXT_URL = "https://api.sec-api.io/full-text-search";

/**
 * Vercel serverless function handler
 */
module.exports = async (req, res) => {
  try {
    const { cusip } = req.query;

    if (!cusip) {
      return res.status(400).json({ message: "CUSIP query param is required" });
    }

    const token = process.env.SEC_API_KEY;
    if (!token) {
      return res.status(500).json({
        message: "SEC_API_KEY is not set in environment variables on Vercel",
      });
    }

    // 1) Call Full-Text Search API looking for this exact CUSIP string
    //    in 424B2 / FWP filings.
    const body = {
      query: `"${cusip}"`, // exact phrase search
      formTypes: ["424B2", "FWP"],
      // You can add date filters later if you want
      page: "0",
    };

    const ftResponse = await fetch(`${FULL_TEXT_URL}?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!ftResponse.ok) {
      const text = await ftResponse.text();
      return res.status(502).json({
        message: "Error calling sec-api full-text-search",
        status: ftResponse.status,
        body: text,
      });
    }

    const ftData = await ftResponse.json();

    // According to sec-api docs, the response has a `filings` array
    const filings = ftData.filings || [];

    if (!filings.length) {
      return res.status(404).json({
        source: "sec-api.io",
        cusip,
        filingsCount: 0,
        filingMeta: null,
        message:
          "No 424B2 / FWP filings found for this CUSIP (full-text search).",
      });
    }

    // 2) Take the most recent filing (they should already be sorted by filedAt desc,
    //    but we can be explicit if needed)
    const [latest] = filings;

    const filingMeta = {
      accessionNo: latest.accessionNo,
      formType: latest.formType,
      filedAt: latest.filedAt,
      cik: latest.cik,
      companyName: latest.companyName,
      linkToFilingDetails: latest.linkToFilingDetails,
      linkToHtml: latest.linkToHtml,
    };

    // 3) (Optional for now) fetch a short HTML preview from SEC
    //    We'll grab only the first ~5000 characters to keep the payload small.
    let htmlPreview = null;
    try {
      if (latest.linkToHtml) {
        const htmlRes = await fetch(latest.linkToHtml);
        if (htmlRes.ok) {
          const htmlText = await htmlRes.text();
          htmlPreview =
            htmlText.length > 5000
              ? htmlText.substring(0, 5000) + "..."
              : htmlText;
        }
      }
    } catch (e) {
      // If this fails, it's not fatal — we still return filingMeta.
      htmlPreview = null;
    }

    // 4) For now, we ONLY return filing metadata + (optional) preview.
    //    Parsing the terms with OpenAI will be Phase 2.
    return res.json({
      source: "sec-api.io",
      cusip,
      filingsCount: filings.length,
      filingMeta,
      htmlPreview,
      message:
        "Found at least one filing containing this CUSIP via full-text search.",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.toString(),
    });
  }
};
