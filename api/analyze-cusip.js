// /api/analyze-cusip.js

const { fullTextSearchApi } = require("sec-api");

// make sure you set SEC_API_KEY in your Vercel project settings
fullTextSearchApi.setApiKey(process.env.SEC_API_KEY);

module.exports = async (req, res) => {
  const { cusip } = req.query;

  if (!cusip) {
    res.status(400).json({ error: "Missing 'cusip' query parameter." });
    return;
  }

  try {
    // 1) Search the full text of 424B2 / FWP filings for this CUSIP
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const query = {
      query: `"${cusip}"`,           // look for the CUSIP string in document text
      formTypes: ["424B2", "FWP"],   // only pricing supplements / FWPs
      startDate: "2001-01-01",
      endDate: today,
    };

    const filings = await fullTextSearchApi.getFilings(query);

    if (!filings || filings.length === 0) {
      res.status(404).json({
        source: "sec-api.io",
        cusip,
        filingMeta: null,
        note: null,
        message: "No 424B2 / FWP filings found for this CUSIP via full-text search.",
      });
      return;
    }

    // 2) Take the most recent filing
    const filing = filings[0];

    const filingMeta = {
      accessionNo: filing.accessionNo,
      formType: filing.formType,
      filedAt: filing.filedAt,
      companyName: filing.companyName,
      cik: filing.cik,
      linkToHtml: filing.linkToHtml,
    };

    // 3) For now we just return filing metadata.
    //    In the next phase, we’ll:
    //      - fetch filingMeta.linkToHtml
    //      - send the text to OpenAI
    //      - parse issuer, trade date, underliers, coupon, etc.
    //      - compute payoff and return a full `note` object.
    res.status(200).json({
      source: "sec-api.io",
      cusip,
      filingMeta,
      note: null,
      message: "Filing found via full-text search. Term extraction not implemented yet.",
    });
  } catch (err) {
    console.error("analyze-cusip error:", err);
    res.status(500).json({
      error: "Internal server error talking to sec-api.io",
      details: err.message,
    });
  }
};


