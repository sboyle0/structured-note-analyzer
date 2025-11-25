// api/analyze-cusip.js

export default async function handler(req, res) {
  try {
    const { cusip } = req.query;

    if (!cusip) {
      return res.status(400).json({ message: "CUSIP is required" });
    }

    // TODO: replace this with your real provider call
    // Example pattern:
    //
    // const response = await fetch(`https://your-provider.example.com/search?cusip=${encodeURIComponent(cusip)}&apikey=${process.env.YOUR_API_KEY}`);
    //
    // if (!response.ok) {
    //   const text = await response.text();
    //   return res.status(502).json({
    //     message: "Upstream provider returned non-OK status",
    //     status: response.status,
    //     body: text
    //   });
    // }
    //
    // const data = await response.json();

    // For now, I'll assume your provider returns a shape like:
    // { filings: [ { accessionNo, formType, filedAt, ... }, ... ] }
    //
    // Replace the next two lines with your actual `data`:
    const data = {}; // <-- CHANGE THIS to whatever your provider returns
    const filings = data.filings; // <-- CHANGE THIS field name if needed

    // Defensive checks so we NEVER crash with "[0]" errors
    if (!data || !Array.isArray(filings) || filings.length === 0) {
      return res.status(404).json({
        source: "alt-provider",
        cusip,
        message: "No filings found for this CUSIP from the provider.",
        rawResponseShape: data ? Object.keys(data) : []
      });
    }

    // Safe to access index 0
    const first = filings[0];

    // Build a minimal meta object (adapt to your provider’s fields)
    const filingMeta = {
      accessionNo: first.accessionNo || first.id || null,
      formType: first.formType || first.form || null,
      filedAt: first.filedAt || first.filingDate || null,
      cik: first.cik || null
    };

    // For now we just return meta; later we’ll fetch & parse HTML with ChatGPT
    return res.status(200).json({
      source: "alt-provider",
      cusip,
      filingsCount: filings.length,
      filingMeta,
      message: "Found at least one filing for this CUSIP."
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.toString()
    });
  }
}
