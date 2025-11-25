// api/analyze-cusip.js

const { queryApi } = require("sec-api");

// Make sure you have SEC_API_KEY set in Vercel Project → Settings → Environment Variables
queryApi.setApiKey(process.env.SEC_API_KEY);

// Map first 6 digits of CUSIP → CIK
// You will expand this list over time
const issuerMap = {
  "48136H": "19617", // JPMorgan Chase Financial Company LLC
  "48134K": "19617", // more JPM prefixes
  "46647P": "19617", // etc — later: add UBS, HSBC, MS, C, BAC...
};

module.exports = async function handler(req, res) {
  try {
    const cusip = (req.query.cusip || "").trim().toUpperCase();
    if (!cusip) {
      return res.status(400).json({ message: "CUSIP missing" });
    }

    const prefix = cusip.substring(0, 6);
    const cik = issuerMap[prefix];

    if (!cik) {
      return res.status(404).json({
        message: `Unknown issuer prefix ${prefix}. Add this prefix to issuerMap in analyze-cusip.js.`,
        cusip,
      });
    }

    // 1) Get recent 424B2 / FWP filings for that CIK
    const searchQuery = {
      query: `cik:${cik} AND (formType:"424B2" OR formType:"FWP")`,
      from: "0",
      size: "80", // up to 80 recent pricing supplements
      sort: [{ filedAt: { order: "desc" } }],
    };

    const filings = await queryApi.getFilings(searchQuery);

    if (!filings || !filings.filings || filings.filings.length === 0) {
      return res.status(404).json({
        message: "No 424B2 / FWP filings found for this issuer.",
        cusip,
        cik,
      });
    }

    // 2) Loop filings and fetch HTML, searching for exact CUSIP text
    let match = null;

    for (const filing of filings.filings) {
      if (!filing.linkToHtml) continue;

      // Vercel Node 18+ has global fetch
      const resp = await fetch(filing.linkToHtml);
      if (!resp.ok) continue;

      const html = await resp.text();
      if (!html) continue;

      // Case-insensitive CUSIP search
      if (html.toUpperCase().includes(cusip)) {
        match = { filing, html };
        break;
      }
    }

    if (!match) {
      return res.status(404).json({
        message:
          "CUSIP not found in the recent 424B2 / FWP filings for this issuer. You may need to broaden the search window or check the prefix mapping.",
        cusip,
        cik,
      });
    }

    // 3) Return the matched filing meta + a trimmed HTML preview
    const previewLength = 2000;
    const htmlPreview =
      match.html.length > previewLength
        ? match.html.substring(0, previewLength) + "…"
        : match.html;

    return res.status(200).json({
      source: "sec-api.io",
      cusip,
      cik,
      filingMeta: {
        accessionNo: match.filing.accessionNo,
        formType: match.filing.formType,
        filedAt: match.filing.filedAt,
        companyName: match.filing.companyName,
        linkToHtml: match.filing.linkToHtml,
      },
      htmlPreview,
      message: "Found pricing supplement containing this CUSIP.",
    });
  } catch (err) {
    console.error("analyze-cusip error:", err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.toString(),
    });
  }
};

