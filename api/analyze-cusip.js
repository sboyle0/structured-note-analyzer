import secApi from "sec-api";

secApi.setApiKey(process.env.SEC_API_KEY);

// ---------------------------
//  Mapping CUSIP prefixes → CIK
// ---------------------------
const issuerMap = {
  "48136H": "19617", 
  "48134K": "19617",
  "46647P": "19617"
};

export default async function handler(req, res) {
  try {
    const cusip = req.query.cusip;
    const includeFiling = req.query.includeFiling === "true";

    if (!cusip) {
      return res.status(400).json({ error: "CUSIP parameter required" });
    }

    const prefix = cusip.substring(0, 6).toUpperCase();
    const cik = issuerMap[prefix];

    if (!cik) {
      return res.status(404).json({
        message: `Unknown issuer prefix: ${prefix}`,
        cusip
      });
    }

    // ---------------------------
    // 1. FULL-TEXT SEARCH FOR CUSIP IN ALL FILINGS
    // ---------------------------
    const searchQuery = {
      query: `FULL_TEXT:"${cusip}" AND (formType:"424B2" OR formType:"FWP")`,
      from: "0",
      size: "10",
      sort: [{ filedAt: { order: "desc" } }]
    };

    const result = await secApi.searchFilings(searchQuery, {
      mode: "full-text"
    });

    if (!result.filings || result.filings.length === 0) {
      return res.status(404).json({
        message: `No 424B2 / FWP filings found containing CUSIP ${cusip} (full-text search).`,
        cusip
      });
    }

    // Top match
    const filing = result.filings[0];

    // Base JSON response
    const base = {
      source: "sec-api.io",
      cusip,
      filingsCount: result.filings.length,
      filingMeta: {
        accessionNo: filing.accessionNo,
        formType: filing.formType,
        filedAt: filing.filedAt,
        cik: filing.cik
      },
      message: "Found at least one filing containing this CUSIP via full-text search."
    };

    // ---------------------------
    // 2. If includeFiling=true → Fetch HTML & Text
    // ---------------------------
    if (includeFiling) {
      const html = await secApi.filingHtml(filing.accessionNo);
      const text = await secApi.filingText(filing.accessionNo);

      return res.json({
        ...base,
        htmlPreview: html.substring(0, 3000) + "...",
        textPreview: text.substring(0, 3000) + "...",
        htmlFull: html,      // keep this only if <= 5MB
        textFull: text
      });
    }

    // Otherwise, return metadata only
    return res.json(base);

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.toString()
    });
  }
}
