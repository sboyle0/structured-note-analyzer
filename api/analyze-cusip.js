// api/analyze-cusip.js

export default async function handler(req, res) {
  try {
    const { cusip } = req.query;

    if (!cusip) {
      return res.status(400).json({ error: "Missing 'cusip' query parameter" });
    }

    const secApiKey = process.env.SEC_API_KEY;
    if (!secApiKey) {
      return res.status(500).json({ error: "SEC_API_KEY is not set on the server" });
    }

    // 1) Use SEC-API Full-Text Search to find the pricing supplement
    // We filter for common structured note forms: 424B2, FWP, 424B3.
    const fullTextBody = {
      query: cusip,                // search by CUSIP string
      formTypes: ["424B2", "FWP", "424B3"],
      page: "1"
    };

    const ftResponse = await fetch("https://api.sec-api.io/full-text-search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // SEC-API docs: either Authorization header OR ?token=... param
        // Here we use Authorization header:
        //   Authorization: YOUR_API_KEY
        "Authorization": secApiKey
      },
      body: JSON.stringify(fullTextBody)
    });

    if (!ftResponse.ok) {
      const text = await ftResponse.text();
      console.error("SEC-API full-text error:", ftResponse.status, text);
      return res.status(502).json({
        error: "SEC-API full-text search failed",
        status: ftResponse.status
      });
    }

    const ftData = await ftResponse.json();

    // Note: full-text search response structure is similar to Query API:
    // { filings: [ { accessionNo, formType, filedAt, linkToHtml, documentFormatFiles, ... }, ... ] }
    // If this ever comes back undefined, log ftData in Vercel logs and adjust the field names.
    const filing = ftData.filings && ftData.filings[0];

    if (!filing) {
      return res.status(404).json({
        error: "No matching pricing supplement found for this CUSIP",
        cusip
      });
    }

    // Try to grab the main HTML document URL from documentFormatFiles;
    // fall back to linkToFilingDetails if needed.
    let mainDocUrl = filing.linkToFilingDetails;
    if (Array.isArray(filing.documentFormatFiles) && filing.documentFormatFiles.length > 0) {
      const mainDoc =
        filing.documentFormatFiles.find(f => f.type === filing.formType) ||
        filing.documentFormatFiles[0];
      if (mainDoc && mainDoc.documentUrl) {
        mainDocUrl = mainDoc.documentUrl;
      }
    }

    // 2) Download the filing HTML/text from SEC (via SEC-API Download API or directly)
    // For now, we keep it simple and just fetch the HTML from sec.gov.
    // Later, we’ll add a call to ChatGPT to parse this into your structured fields.
    let rawText = null;
    if (mainDocUrl && mainDocUrl.startsWith("https://www.sec.gov")) {
      try {
        const htmlResp = await fetch(mainDocUrl);
        if (htmlResp.ok) {
          const html = await htmlResp.text();
          // Very naive "strip tags" – just so we have some plain text for the next phase.
          rawText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 10000);
        }
      } catch (err) {
        console.error("Error fetching mainDocUrl:", err);
      }
    }

    // 3) PHASE 1 RESPONSE:
    //    We return:
    //      - basic filing metadata from SEC-API
    //      - a "rawText" preview
    //      - a placeholder "note" object in roughly your existing format
    //
    // In Phase 2, we’ll replace the placeholder with ChatGPT-parsed data
    // based on rawText + your extraction rules.

    const responsePayload = {
      source: "sec-api.io",
      cusip,
      filingMeta: {
        accessionNo: filing.accessionNo,
        formType: filing.formType,
        filedAt: filing.filedAt,
        companyName: filing.companyName || filing.companyNameLong,
        cik: filing.cik,
        linkToHtml: filing.linkToHtml || mainDocUrl,
        linkToFilingDetails: filing.linkToFilingDetails,
      },
      // Limited raw text (for debugging / future AI parsing)
      rawTextPreview: rawText || null,

      // Placeholder "note" object – this keeps your front-end from breaking for now.
      // Once we add ChatGPT extraction, these fields will be populated from the filing text.
      note: {
        issuer: filing.companyName || "Issuer from filing",
        issuer_sub: "Parsed issuer description will go here.",
        trade_date: "To be parsed",
        maturity_date: "To be parsed",
        product_type: "To be parsed (e.g. Autocallable Contingent Income Note)",
        profile_key: "To be parsed (e.g. autocallable_single_underlier_barrier)",
        coupon: {
          label: "To be parsed (e.g. 8.50% p.a. contingent quarterly coupon)",
          structure: "To be parsed from document.",
          barrier: "To be parsed from document."
        },
        protection: {
          label: "To be parsed (e.g. 70% European barrier)",
          principal: "To be parsed.",
          downside: "To be parsed."
        },
        underliers: [
          // To be replaced with extracted underliers; left empty for now
        ],
        payoff_today: {
          amount_per_1000: null,
          pct_of_par: null,
          status: "Not yet calculated",
          status_variant: "upside",
          explanation: "Payoff logic not yet implemented for live data.",
          subtitle: "Phase 1 – only filing lookup is live."
        }
      }
    };

    return res.status(200).json(responsePayload);
  } catch (err) {
    console.error("analyze-cusip error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
