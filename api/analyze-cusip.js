import secAPI from "sec-api";

secAPI.setApiKey(process.env.SEC_API_KEY);

export default async function handler(req, res) {
  try {
    const { cusip } = req.query;

    if (!cusip) {
      return res.status(400).json({ error: "Missing CUSIP parameter" });
    }

    // Step 1: CUSIP FULL-TEXT SEARCH
    const searchResponse = await secAPI.search({
      query: {
        query_string: {
          query: `\"${cusip}\" AND (formType:424B2 OR formType:FWP)`
        }
      },
      from: 0,
      size: 3,
      sort: [{ filedAt: { order: "desc" } }]
    });

    if (!searchResponse.filings || searchResponse.filings.length === 0) {
      return res.status(404).json({
        source: "sec-api.io",
        cusip,
        filingsCount: 0,
        message: "No filings found containing this CUSIP via full-text search."
      });
    }

    // Step 2: Select the most recent filing
    const filing = searchResponse.filings[0];

    // Step 3: Fetch FULL HTML of that filing
    const fullHtml = await secAPI.filing({
      accessionNo: filing.accessionNo
    });

    // Step 4: Return the HTML
    return res.status(200).json({
      source: "sec-api.io",
      cusip,
      filingsCount: searchResponse.filings.length,
      filingMeta: {
        accessionNo: filing.accessionNo,
        formType: filing.formType,
        filedAt: filing.filedAt,
        cik: filing.cik
      },
      htmlLength: fullHtml.length,
      htmlPreview: fullHtml.substring(0, 2000) + "...",
      message: "Returning full HTML of matched pricing supplement."
    });

  } catch (err) {
    console.error("Error in API:", err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.toString()
    });
  }
}
