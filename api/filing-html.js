export default async function handler(req, res) {
  try {
    const { accessionNo, cik } = req.query;

    if (!accessionNo || !cik) {
      return res.status(400).json({
        message:
          "Missing required query params. Example: /api/filing-html?accessionNo=0001213900-25-104551&cik=19617",
      });
    }

    // 1) Build the SEC EDGAR base path
    // Example target:
    // https://www.sec.gov/Archives/edgar/data/19617/000121390025104551/index.json
    const cikTrimmed = String(parseInt(cik, 10)); // remove leading zeros if present
    const accessionNoNoDashes = accessionNo.replace(/-/g, "");

    const basePath = `https://www.sec.gov/Archives/edgar/data/${cikTrimmed}/${accessionNoNoDashes}`;
    const indexUrl = `${basePath}/index.json`;

    // IMPORTANT: SEC wants a real User-Agent string
    // Replace the email below with your own email so you’re a good citizen.
    const headers = {
      "User-Agent": "structured-note-analyzer/1.0 (contact: your-email@example.com)",
      Accept: "application/json",
    };

    // 2) Fetch index.json to see what files exist in the filing folder
    const indexResp = await fetch(indexUrl, { headers });

    if (!indexResp.ok) {
      const raw = await indexResp.text();
      return res.status(indexResp.status).json({
        message: "Failed to fetch SEC index.json",
        status: indexResp.status,
        indexUrl,
        body: raw,
      });
    }

    const indexData = await indexResp.json();
    const items =
      indexData?.directory?.item && Array.isArray(indexData.directory.item)
        ? indexData.directory.item
        : [];

    if (!items.length) {
      return res.status(404).json({
        message: "No files listed in SEC index.json for this filing.",
        indexUrl,
        indexData,
      });
    }

    // 3) Try to pick the best HTML doc:
    //    Prefer a file whose name references 424B2 or FWP and ends with .htm/html.
    let doc = items.find(
      (it) =>
        /\.html?$/i.test(it.name || "") && /424b2/i.test(it.name || "")
    );

    if (!doc) {
      doc = items.find(
        (it) => /\.html?$/i.test(it.name || "") && /fwp/i.test(it.name || "")
      );
    }

    // If still nothing, just pick the first HTML-ish file
    if (!doc) {
      doc = items.find((it) => /\.html?$/i.test(it.name || ""));
    }

    if (!doc) {
      return res.status(404).json({
        message:
          "Could not find an HTML document for this filing in index.json.",
        indexUrl,
        files: items.map((it) => it.name),
      });
    }

    const htmlFileName = doc.name;
    const htmlUrl = `${basePath}/${htmlFileName}`;

    // 4) Fetch the actual HTML
    const htmlResp = await fetch(htmlUrl, {
      headers: {
        "User-Agent": headers["User-Agent"],
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!htmlResp.ok) {
      const rawHtmlErr = await htmlResp.text();
      return res.status(htmlResp.status).json({
        message: "Failed to fetch the filing HTML from sec.gov",
        status: htmlResp.status,
        htmlUrl,
        body: rawHtmlErr,
      });
    }

    const htmlText = await htmlResp.text();
    const previewLength = 4000; // keep response manageable
    const htmlPreview =
      htmlText.length > previewLength
        ? htmlText.slice(0, previewLength) + "\n...[truncated]..."
        : htmlText;

    return res.status(200).json({
      source: "sec.gov",
      accessionNo,
      cik: cikTrimmed,
      htmlUrl,
      htmlFileName,
      htmlPreview,
      htmlLength: htmlText.length,
      message: "Fetched filing HTML from sec.gov successfully.",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error in /api/filing-html",
      error: err.toString(),
    });
  }
}
