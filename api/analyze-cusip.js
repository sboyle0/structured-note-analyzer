export default async function handler(req, res) {
  try {
    const { cusip } = req.query;

    if (!cusip) {
      return res.status(400).json({
        message: "CUSIP missing in query string, e.g. ?cusip=48136H7D4"
      });
    }

    const apiKey = process.env.SEC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        message: "SEC_API_KEY environment variable is not set in Vercel."
      });
    }

    // 1) Full-text search via sec-api.io using only the CUSIP
    const searchBody = {
      query: {
        query_string: {
          // Just search for this CUSIP anywhere in the filing text,
          // then we take the most recent hit.
          query: `"${cusip}"`
        }
      },
      from: 0,
      size: 1, // only the latest filing
      sort: [{ filedAt: { order: "desc" } }]
    };

    const response = await fetch("https://api.sec-api.io/full-text-search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // sec-api.io expects the API token here
        Authorization: apiKey
      },
      body: JSON.stringify(searchBody)
    });

    // Read the raw body first so we can return it even on non-OK status
    const rawText = await response.text();

    if (!response.ok) {
      // Do NOT throw – just surface whatever sec-api.io sent
      return res.status(response.status).json({
        message: "sec-api.io returned a non-OK status",
        status: response.status,
        body: rawText
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(500).json({
        message: "Could not parse JSON from sec-api.io",
        raw: rawText
      });
    }

    // sec-api full-text search usually returns { filings: [...] }
    const filings = Array.isArray(data.filings) ? data.filings : [];

    if (filings.length === 0) {
      // Nothing crashed; we just didn’t find a filing
      return res.status(404).json({
        source: "sec-api.io",
        cusip,
        filingsCount: 0,
        filingMeta: null,
        message:
          "No filings found for this CUSIP (full-text search).",
        raw: data
      });
    }

    // Take the most recent filing
    const filing = filings[0] || {};

    const accessionNo = filing.accessionNo || null;
    const formType = filing.formType || null;
    const filedAt = filing.filedAt || null;
    const cikRaw = filing.cik || null;
    const companyName =
      filing.companyNameLong || filing.companyName || null;

    // 2) Try to build a direct SEC HTML URL using CIK + accession number
    let linkToHtml = filing.linkToHtml || null;
    let linkToFilingDetails = filing.linkToFilingDetails || null;
    let htmlFromIndex = null;

    if (!linkToHtml && accessionNo && cikRaw) {
      // Example SEC path pattern:
      // https://www.sec.gov/Archives/edgar/data/{cikWithoutLeadingZeros}/{accessionNoNoDashes}/index.json
      const cikNoZeros = String(cikRaw).replace(/^0+/, "");
      const accDir = accessionNo.replace(/-/g, "");

      const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accDir}/index.json`;

      try {
        const indexResp = await fetch(indexUrl, {
          headers: {
            // SEC asks for a User-Agent. Use something descriptive for your app.
            "User-Agent": "structured-note-analyzer/1.0",
            Accept: "application/json"
          }
        });

        if (indexResp.ok) {
          const indexData = await indexResp.json();
          const items =
            indexData &&
            indexData.directory &&
            Array.isArray(indexData.directory.item)
              ? indexData.directory.item
              : [];

          // Look for an .htm/.html file that is likely the main document
          const htmlItem =
            items.find(
              (it) =>
                typeof it.name === "string" &&
                (it.name.toLowerCase().endsWith(".htm") ||
                  it.name.toLowerCase().endsWith(".html"))
            ) || null;

          if (htmlItem) {
            htmlFromIndex = `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accDir}/${htmlItem.name}`;
            linkToHtml = linkToHtml || htmlFromIndex;
          }
        } else {
          // If SEC index doesn’t respond, we just carry on without crashing
          console.error(
            "SEC index returned non-OK status",
            indexResp.status
          );
        }
      } catch (indexErr) {
        console.error("Error fetching SEC index.json", indexErr);
      }
    }

    // Optional: we don’t strictly need a "details" URL, but keep it if sec-api provided it
    linkToFilingDetails = linkToFilingDetails || null;

    return res.status(200).json({
      source: "sec-api.io",
      cusip,
      filingsCount: filings.length,
      filingMeta: {
        accessionNo,
        formType,
        filedAt,
        cik: cikRaw,
        companyName
      },
      linkToHtml: linkToHtml || null,
      linkToFilingDetails,
      htmlFromSecIndex: htmlFromIndex, // may be null if we couldn’t infer it
      message:
        "Found at least one filing containing this CUSIP via full-text search."
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error in /api/analyze-cusip",
      error: err.toString()
    });
  }
}

