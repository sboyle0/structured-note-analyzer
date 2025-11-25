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

    // 1) Full-text search via sec-api.io – find filings containing this CUSIP
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
        Authorization: apiKey
      },
      body: JSON.stringify(searchBody)
    });

    const rawText = await response.text();

    if (!response.ok) {
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

    const filings = Array.isArray(data.filings) ? data.filings : [];

    if (filings.length === 0) {
      return res.status(404).json({
        source: "sec-api.io",
        cusip,
        filingsCount: 0,
        filingMeta: null,
        message: "No filings found for this CUSIP (full-text search).",
        raw: data
      });
    }

    const filing = filings[0] || {};
    const accessionNo = filing.accessionNo || null;
    const cik = filing.cik || null;

    let htmlUrl = null;
    let htmlPreview = null;

    if (accessionNo && cik) {
      try {
        const htmlResult = await fetchEdgarHtml(cik, accessionNo);
        if (htmlResult) {
          htmlUrl = htmlResult.htmlUrl;
          htmlPreview = htmlResult.htmlPreview;
        }
      } catch (e) {
        console.error("Error fetching HTML from EDGAR:", e);
      }
    }

    return res.status(200).json({
      source: "sec-api.io",
      cusip,
      filingsCount: filings.length,
      filingMeta: {
        accessionNo: accessionNo,
        formType: filing.formType || null,
        filedAt: filing.filedAt || null,
        cik: cik,
        companyName: filing.companyNameLong || filing.companyName || null
      },
      htmlUrl,
      htmlPreview,
      message: htmlUrl
        ? "Found at least one filing containing this CUSIP and fetched HTML from EDGAR."
        : "Found at least one filing containing this CUSIP via full-text search, but HTML fetch may have failed."
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error in /api/analyze-cusip",
      error: err.toString()
    });
  }
}

/**
 * Fetch the primary HTML document for a filing directly from sec.gov
 * using CIK + accession number.
 */
async function fetchEdgarHtml(cikRaw, accessionNo) {
  // CIK in the URL is the integer without leading zeros
  const cik = String(parseInt(String(cikRaw), 10));
  // accession like "0001213900-25-104551" → "000121390025104551"
  const accessionNoNoDashes = String(accessionNo).replace(/-/g, "");

  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNoNoDashes}/index.json`;

  // IMPORTANT: set a proper User-Agent per SEC guidelines
  const headers = {
    "User-Agent": "Structured Note Analyzer (contact: your-email@example.com)",
    Accept: "application/json"
  };

  const indexRes = await fetch(indexUrl, { headers });

  if (!indexRes.ok) {
    console.error("EDGAR index fetch failed:", indexRes.status, indexUrl);
    return null;
  }

  const indexData = await indexRes.json();

  const items =
    indexData &&
    indexData.directory &&
    Array.isArray(indexData.directory.item)
      ? indexData.directory.item
      : [];

  if (!items.length) {
    console.error("EDGAR index.json has no items:", indexUrl);
    return null;
  }

  // Try to pick the primary HTML doc – prefer *.htm files,
  // and if possible one that contains "424b" in the name.
  let primary =
    items.find(
      (f) =>
        /\.htm$/i.test(f.name || "") &&
        /424b/i.test(f.name || "")
    ) ||
    items.find((f) => /\.htm$/i.test(f.name || "")) ||
    items[0];

  if (!primary || !primary.name) {
    console.error("Could not identify primary HTML doc from index.json");
    return null;
  }

  const htmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNoNoDashes}/${primary.name}`;

  const htmlRes = await fetch(htmlUrl, {
    headers: {
      "User-Agent": "Structured Note Analyzer (contact: your-email@example.com)",
      Accept: "text/html"
    }
  });

  if (!htmlRes.ok) {
    console.error("EDGAR HTML fetch failed:", htmlRes.status, htmlUrl);
    return null;
  }

  const html = await htmlRes.text();

  return {
    htmlUrl,
    htmlPreview: html.slice(0, 2000) // just a preview for now
  };
}
