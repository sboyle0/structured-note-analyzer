const { SecAPI } = require("sec-api");

const secApi = new SecAPI(process.env.SEC_API_KEY);

// Map first 6 digits of CUSIP → CIK
// You will expand this list over time.
const issuerMap = {
  "48136H": "19617", // JPMorgan Chase Financial Company LLC
  "48134K": "19617", // More JPM prefixes
  "46647P": "19617"  // Example – you'll add UBS, HSBC, MS, C, BAC later
};

module.exports = async function handler(req, res) {
  try {
    const cusipParam = req.query.cusip;
    if (!cusipParam) {
      return res.status(400).json({ error: "CUSIP missing" });
    }

    const cusip = cusipParam.toUpperCase();
    const prefix = cusip.substring(0, 6);
    const cik = issuerMap[prefix];

    if (!cik) {
      return res.status(404).json({
        message: `Unknown issuer prefix ${prefix}. Add to issuerMap.`,
        cusip
      });
    }

    // 1) Get recent pricing supplements (424B2 / FWP) for this issuer
    const filings = await secApi.search({
      query: {
        query_string: {
          query: `cik:${cik} AND (formType:424B2 OR formType:FWP)`
        }
      },
      from: 0,
      size: 200,
      sort: [{ filedAt: { order: "desc" } }]
    });

    const list = filings && filings.filings ? filings.filings : [];

    if (!list.length) {
      return res.status(404).json({
        message: "No pricing supplements found for issuer",
        cusip,
        cik
      });
    }

    // 2) Loop filings and fetch HTML until we find one that contains the CUSIP
    let match = null;

    for (const f of list) {
      let html;
      try {
        html = await secApi.filing(f.linkToHtml);
      } catch (e) {
        console.error("Error fetching filing HTML", f.accessionNo, e.toString());
        continue;
      }

      if (html && html.toUpperCase().includes(cusip)) {
        match = { filing: f, html };
        break;
      }
    }

    if (!match) {
      return res.status(404).json({
        message: "CUSIP not found in any recent pricing supplements for issuer",
        cusip,
        cik
      });
    }

    // 3) Return just enough info for now – later we'll send the HTML to the AI
    return res.status(200).json({
      source: "sec-api.io",
      cusip,
      cik,
      filingMeta: {
        accessionNo: match.filing.accessionNo,
        formType: match.filing.formType,
        filedAt: match.filing.filedAt,
        companyName: match.filing.companyName,
        cik: match.filing.cik,
        linkToHtml: match.filing.linkToHtml
      },
      htmlPreview: match.html.substring(0, 2000) + "...",
      message: "Found pricing supplement containing this CUSIP"
    });
  } catch (err) {
    console.error("analyze-cusip error", err);
    return res.status(500).json({
      message: "Internal server error in analyze-cusip",
      error: err.toString()
    });
  }
};
