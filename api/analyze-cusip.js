// ----------------------------------------------------------
// analyze-cusip.js — works with sec-api on Vercel
// ----------------------------------------------------------

const secApi = require("sec-api");

// Map CUSIP prefixes → issuer CIK
const issuerMap = {
  "48136H": "19617",   // JPMorgan Chase
  "48134K": "19617",   // JPMorgan additional prefix
  "46647P": "19617"    // Example – extend this list later
};

module.exports = async function handler(req, res) {
  try {
    const cusip = req.query.cusip;
    if (!cusip) {
      return res.status(400).json({ error: "CUSIP missing" });
    }

    const prefix = cusip.substring(0, 6).toUpperCase();
    const cik = issuerMap[prefix];

    if (!cik) {
      return res.status(404).json({
        message: `Unknown issuer prefix ${prefix}. Add to issuerMap.`,
        cusip
      });
    }

    // STEP 1 — Get the latest 100 pricing supplements from this issuer
    const filings = await secApi.search({
      query: {
        query_string: {
          query: `cik:${cik} AND (formType:424B2 OR formType:FWP)`
        }
      },
      from: 0,
      size: 100,
      sort: [{ filedAt: { order: "desc" } }]
    });

    if (!filings.filings || filings.filings.length === 0) {
      return res.status(404).json({
        message: "No pricing supplements found for this issuer",
        cusip,
        cik
      });
    }

    // STEP 2 — Loop through filings to find one containing the CUSIP
    let match = null;

    for (const filing of filings.filings) {
      const html = await secApi.filing(filing.linkToHtml);

      if (html && html.includes(cusip)) {
        match = {
          filing,
          htmlSnippet: html.substring(0, 2000)
        };
        break;
      }
    }

    if (!match) {
      return res.status(404).json({
        message: "CUSIP not found in any recent pricing supplements",
        cusip,
        cik
      });
    }

    // STEP 3 — Return the HTML snippet (later used by ChatGPT to parse terms)
    return res.json({
      source: "sec-api.io",
      cusip,
      cik,
      filingMeta: match.filing,
      htmlSnippet: match.htmlSnippet,
      message: "Found pricing supplement containing this CUSIP"
    });

  } catch (err) {
    console.error("analyze-cusip error:", err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.toString()
    });
  }
};
