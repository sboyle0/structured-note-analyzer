export default async function handler(req, res) {
  try {
    const { cusip, accessionNo, cik } = req.query;

    if (!accessionNo || !cik) {
      return res.status(400).json({
        message:
          "accessionNo and cik are required, e.g. ?cusip=48136H7D4&accessionNo=0001213900-25-104551&cik=19617"
      });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(500).json({
        message: "OPENAI_API_KEY environment variable is not set in Vercel."
      });
    }

    // --- 1) Figure out where the HTML file lives on sec.gov ---

    // CIK in the path is just digits, no leading zeros needed
    const cikNormalized = String(cik).replace(/^0+/, "");
    // Accession number folder has the dashes removed
    const folderAccession = accessionNo.replace(/-/g, "");

    // Every filing folder on sec.gov has an index.json we can inspect
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNormalized}/${folderAccession}/index.json`;

    const indexResp = await fetch(indexUrl, {
      headers: {
        // Being a good citizen with SEC – they like a UA string
        "User-Agent":
          "structured-note-analyzer/1.0 (contact: your-email@example.com)",
        Accept: "application/json"
      }
    });

    const indexText = await indexResp.text();

    if (!indexResp.ok) {
      return res.status(indexResp.status).json({
        message: "Could not fetch index.json from sec.gov",
        status: indexResp.status,
        body: indexText,
        indexUrl
      });
    }

    let indexJson;
    try {
      indexJson = JSON.parse(indexText);
    } catch (e) {
      return res.status(500).json({
        message: "Could not parse index.json from sec.gov",
        raw: indexText,
        indexUrl
      });
    }

    const items =
      indexJson &&
      indexJson.directory &&
      Array.isArray(indexJson.directory.item)
        ? indexJson.directory.item
        : [];

    // Choose an .htm file – usually the main pricing supplement
    const htmlItem =
      items.find(
        (it) =>
          typeof it.name === "string" &&
          it.name.toLowerCase().endsWith(".htm")
      ) || null;

    if (!htmlItem) {
      return res.status(404).json({
        message: "Could not find an .htm file for this filing in index.json.",
        indexUrl,
        items: items.map((it) => it.name)
      });
    }

    const htmlFileName = htmlItem.name;
    const htmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikNormalized}/${folderAccession}/${htmlFileName}`;

    // --- 2) Fetch the actual HTML pricing supplement ---

    const htmlResp = await fetch(htmlUrl, {
      headers: {
        "User-Agent":
          "structured-note-analyzer/1.0 (contact: your-email@example.com)",
        Accept: "text/html,application/xhtml+xml"
      }
    });

    const html = await htmlResp.text();

    if (!htmlResp.ok) {
      return res.status(htmlResp.status).json({
        message: "Could not fetch filing HTML from sec.gov",
        status: htmlResp.status,
        body: html,
        htmlUrl
      });
    }

    // --- 3) Strip HTML tags to get plain text for the model ---

    const withoutScripts = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ");

    const plainText = withoutScripts
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Keep it to a reasonable size for the model (can adjust as needed)
    const maxChars = 20000;
    const snippet = plainText.slice(0, maxChars);

    // --- 4) Ask OpenAI to extract the key terms into a JSON object ---

    const systemPrompt = `
You are a structured note analyst. You read pricing supplements and extract key terms
into a clean JSON object. The JSON will be used to populate a UI for financial advisors.

Return ONLY valid JSON. Do not include backticks or any explanation.
If a field is not clearly available, set it to null and do not guess wildly.
    `.trim();

    // This schema is designed to match your existing UI fields in app.html
    const schemaDescription = `
You must return a single JSON object with this exact shape:

{
  "issuer": string | null,
  "issuer_sub": string | null,
  "trade_date": string | null,
  "maturity_date": string | null,
  "product_type": string | null,
  "profile_key": string | null,
  "coupon": {
    "label": string | null,
    "structure": string | null,
    "barrier": string | null
  },
  "protection": {
    "label": string | null,
    "principal": string | null,
    "downside": string | null
  },
  "underliers": [
    {
      "name": string | null,
      "ticker": string | null,
      "role": string | null,
      "initial_level": number | null,
      "weighting": string | null,
      "worst_of_or_basket": string | null
    }
  ],
  "payoff_today": {
    "amount_per_1000": number | null,
    "pct_of_par": number | null,
    "status": string,
    "status_variant": "upside" | "downside" | "neutral",
    "explanation": string,
    "subtitle": string
  }
}

Rules:
- "profile_key" should be a short machine-friendly label, e.g.
  "autocallable_single_underlier_barrier" or "point_to_point_single_underlier".
- For "underliers", include one entry per underlier.
- "initial_level" should be the official initial level on the trade/pricing date, if available.
- For now, do NOT try to compute actual payoff_today numbers. Set the numeric fields to null,
  set "status" to "Not yet calculated", "status_variant" to "neutral", and explain that only
  terms have been parsed, not payoff logic.
    `.trim();

    const userPrompt = `
CUSIP (if known): ${cusip || "unknown"}

Below is text extracted from a structured note pricing supplement. Extract the fields
according to the schema described. Again: return ONLY JSON, no commentary.

---
${snippet}
    `.trim();

    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "system", content: schemaDescription },
          { role: "user", content: userPrompt }
        ]
      })
    });

    const openaiRaw = await openaiResp.text();

    if (!openaiResp.ok) {
      return res.status(openaiResp.status).json({
        message: "OpenAI API returned a non-OK status",
        status: openaiResp.status,
        body: openaiRaw
      });
    }

    let openaiData;
    try {
      openaiData = JSON.parse(openaiRaw);
    } catch (e) {
      return res.status(500).json({
        message: "Could not parse JSON from OpenAI chat completion response",
        raw: openaiRaw
      });
    }

    const content =
      openaiData &&
      openaiData.choices &&
      openaiData.choices[0] &&
      openaiData.choices[0].message &&
      openaiData.choices[0].message.content;

    if (!content) {
      return res.status(500).json({
        message: "OpenAI response did not contain choices[0].message.content",
        openaiData
      });
    }

    let note;
    try {
      note = JSON.parse(content);
    } catch (e) {
      return res.status(500).json({
        message:
          "Assistant did not return valid JSON in message.content. Check the prompt.",
        assistantContent: content
      });
    }

    // --- 5) Respond with structured note data ---

    return res.status(200).json({
      source: "sec.gov + openai",
      cusip: cusip || null,
      accessionNo,
      cik: cikNormalized,
      htmlUrl,
      note
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error in /api/parse-filing",
      error: err.toString()
    });
  }
}
