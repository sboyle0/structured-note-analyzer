// api/analyze-cusip.js
//
// CUSIP → issuer CIK (first 6 characters of CUSIP)
// You can extend this over time as you add more issuers.
const issuerMap = {
  "48136H": "19617", // JPMorgan Chase Financial Company LLC
  "48134K": "19617",
  "46647P": "19617"
};

// Helper to pad a CIK to 10 digits for the SEC "submissions" API
function padCik10(cik) {
  return cik.toString().padStart(10, "0");
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  try {
    const cusipRaw = req.query.cusip;
    if (!cusipRaw) {
      return res.status(400).json({ message: "CUSIP missing" });
    }

    const cusip = cusipRaw.trim().toUpperCase();
    const prefix = cusip.substring(0, 6);
    const cikShort = issuerMap[prefix];

    if (!cikShort) {
      return res.status(404).json({
        message: `Unknown issuer prefix ${prefix}. Add to issuerMap in analyze-cusip.js.`,
        cusip
      });
    }

    const cikPadded = padCik10(cikShort);
    const numericCik = parseInt(cikShort, 10);

    // IMPORTANT: set this env var in Vercel → Project → Settings → Environment Variables
    // e.g. "StructuredNoteAnalyzer/1.0 (youremail@example.com)"
    const userAgent =
      process.env.SEC_USER_AGENT ||
      "StructuredNoteAnalyzer/1.0 (youremail@example.com)";

    // 1) Pull the issuer's recent filings from SEC "submissions" API
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;

    const subsResp = await fetch(submissionsUrl, {
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json"
      }
    });

    if (!subsResp.ok) {
      const body = await subsResp.text();
      return res.status(502).json({
        message: "Error calling SEC submissions API",
        status: subsResp.status,
        body
      });
    }

    const subsJson = await subsResp.json();
    const recent = subsJson.filings && subsJson.filings.recent;

    if (!recent || !recent.form || !recent.accessionNumber) {
      return res.status(404).json({
        message: "No recent filings found in SEC submissions data",
        cusip,
        cik: cikShort
      });
    }

    // 2) Collect candidate pricing supplements (424B2 / FWP)
    const forms = recent.form;
    const accessionNumbers = recent.accessionNumber;
    const filingDates = recent.filingDate;
    const primaryDocs = recent.primaryDoc;

    const candidates = [];
    for (let i = 0; i < forms.length; i++) {
      const form = forms[i];
      if (form === "424B2" || form === "FWP") {
        candidates.push({
          accessionNo: accessionNumbers[i],
          filedAt: filingDates[i],
          primaryDoc: primaryDocs[i]
        });
      }
    }

    if (candidates.length === 0) {
      return res.status(404).json({
        message: "No 424B2 / FWP filings found for this issuer in recent submissions.",
        cusip,
        cik: cikShort
      });
    }

    // 3) For each candidate, fetch the HTML and search for the CUSIP string
    let match = null;

    for (const candidate of candidates) {
      const accessionNoNoDashes = candidate.accessionNo.replace(/-/g, "");
      const htmlUrl = `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accessionNoNoDashes}/${candidate.primaryDoc}`;

      const htmlResp = await fetch(htmlUrl, {
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html"
        }
      });

      if (!htmlResp.ok) {
        // Skip bad HTMLs but log them in the response
        continue;
      }

      const html = await htmlResp.text();
      if (html.toUpperCase().includes(cusip)) {
        match = {
          filingMeta: candidate,
          html
        };
        break;
      }
    }

    if (!match) {
      return res.status(404).json({
        source: "sec.gov",
        cusip,
        cik: cikShort,
        message:
          "Scanned recent 424B2/FWP filings for this issuer but did not find this CUSIP in the HTML."
      });
    }

    // 4) Return filing meta + a small preview of the HTML text
    const previewLength = 1200;
    const preview =
      match.html.length > previewLength
        ? match.html.substring(0, previewLength) + "..."
        : match.html;

    return res.status(200).json({
      source: "sec.gov",
      cusip,
      cik: cikShort,
      filingMeta: match.filingMeta,
      htmlPreview: preview,
      message: "Found a pricing supplement whose HTML contains this CUSIP."
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.toString()
    });
  }
};

