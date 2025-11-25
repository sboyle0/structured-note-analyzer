\const { SecAPI } = require("sec-api");

const secApi = new SecAPI(process.env.SEC_API_KEY);

// Map first 6 digits of CUSIP → CIK
// You will expand this list over time
const issuerMap = {
  "48136H": "19617",     // JPMorgan Chase Financial Company LLC
  "48134K": "19617",     // More JPM prefixes
  "46647P": "19617"      // Etc — you will add UBS, HSBC, MS, C, BAC later
};

export default async function handler(req, res) {
  try {
    const cusip = req.query.cusip;
    if (!cusip) return res.status(400).json({ error: "CUSIP missing" });

    const prefix = cusip.substring(0, 6).toUpperCase();
    const cik = issuerMap[prefix];

    if (!cik) {
      return res.status(404).json({
        message: `Unknown issuer prefix ${prefix}. Add to issuerMap.`,
        cusip
      });
    }

    // 1) Get last 100 pricing supplements for this CIK
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
        message: "No pricing supplements found for issuer",
        cusip,
        cik
      });
    }

    // 2) Loop filings and inspect HTML for exact CUSIP match
    let match = null;

    for (const f of filings.filings) {
      const html = await secApi.filing(f.linkToHtml);

      if (html && html.includes(cusip)) {
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

    // 3) Return the matched filing HTML so next step can parse terms
    return res.json({
      source: "sec-api.io",
      cusip,
      cik,
      filingMeta: match.filing,
      htmlPreview: match.html.substring(0, 1000) + "...",
      message: "Found pricing supplement containing this CUSIP"
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.toString()
    });
  }
}
