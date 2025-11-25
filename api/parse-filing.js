export default async function handler(req, res) {
  try {
    const { cusip, accessionNo, cik } = req.query || {};

    if (!cusip || !accessionNo || !cik) {
      return res.status(400).json({
        message: "Missing required query params. Expected cusip, accessionNo, cik.",
        received: { cusip, accessionNo, cik }
      });
    }

    const openAiKey = process.env.OPENAI_API_KEY;
    if (!openAiKey) {
      return res.status(500).json({
        message: "OPENAI_API_KEY environment variable is not set in Vercel."
      });
    }

    // --- 1. Fetch main HTML filing from sec.gov directly ---
    const cleanAccession = accessionNo.replace(/-/g, "");
    const cleanCik = String(parseInt(cik, 10));
    const basePath = `https://www.sec.gov/Archives/edgar/data/${cleanCik}/${cleanAccession}`;

    const ua = "StructuredNoteAnalyzer/1.0 (contact: your-email@example.com)";

    // Get index.json for the filing directory to discover the main HTML file
    const indexResp = await fetch(`${basePath}/index.json`, {
      headers: {
        "User-Agent": ua,
        "Accept": "application/json"
      }
    });

    if (!indexResp.ok) {
      const body = await indexResp.text();
      return res.status(502).json({
        message: "Failed to fetch index.json from sec.gov",
        status: indexResp.status,
        body
      });
    }

    let indexData;
    try {
      indexData = await indexResp.json();
    } catch (e) {
      return res.status(500).json({
        message: "Could not parse index.json from sec.gov",
        error: e.toString()
      });
    }

    // index.json usually has shape: { directory: { item: [ { name, type, ... }, ... ] } }
    const items = indexData?.directory?.item;
    let htmlFileName = null;

    if (Array.isArray(items)) {
      const htmlFile = items.find(
        (it) =>
          typeof it.name === "string" &&
          it.name.toLowerCase().endsWith(".htm")
      );
      if (htmlFile) {
        htmlFileName = htmlFile.name;
      }
    }

    if (!htmlFileName) {
      return res.status(404).json({
        message: "Could not identify main HTML file for this filing in index.json.",
        basePath,
        indexSample: indexData
      });
    }

    const htmlUrl = `${basePath}/${htmlFileName}`;

    const htmlResp = await fetch(htmlUrl, {
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,*/*"
      }
    });

    const htmlText = await htmlResp.text();

    if (!htmlResp.ok) {
      return res.status(502).json({
        message: "Failed to fetch filing HTML from sec.gov",
        status: htmlResp.status,
        bodyPreview: htmlText.slice(0, 500)
      });
    }

    // Truncate HTML so we don't blow up the model context
    const MAX_CHARS = 150000;
    const htmlSnippet = htmlText.slice(0, MAX_CHARS);

    // --- 2. Call OpenAI to parse core terms from the HTML ---
    const systemPrompt = `
You are an expert financial document parser focused on US structured notes.
Your job is to read structured note final pricing supplements (424B2, FWP, etc.)
and extract a concise, standardized summary in strict JSON form.

Return ONLY a single JSON object, no explanations, no code fences, and no trailing text.
The JSON must match this schema exactly:

{
  "issuer": string,
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

If a field is not clearly stated in the document, set it to null.
Make reasonable, conservative interpretations, but do NOT invent coupon rates,
barrier levels, or dates that are not clearly present.
`.trim();

    const userPrompt = `
Parse the following structured note pricing supplement HTML and extract terms
according to the schema described.

Metadata:
- CUSIP: ${cusip}
- Accession No: ${accessionNo}
- CIK: ${cik}
- Filing HTML URL: ${htmlUrl}

Return ONLY a JSON object matching the schema. Do not wrap it in \`\`\` fences.

----- BEGIN HTML SNIPPET -----
${htmlSnippet}
----- END HTML SNIPPET -----
`.trim();

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0,
        max_tokens: 800
      })
    });

    const aiRaw = await aiResp.text();

    if (!aiResp.ok) {
      return res.status(aiResp.status).json({
        message: "OpenAI API returned a non-OK status",
        status: aiResp.status,
        body: aiRaw
      });
    }

    let aiData;
    try {
      aiData = JSON.parse(aiRaw);
    } catch (e) {
      return res.status(500).json({
        message: "Could not parse JSON from OpenAI API response",
        raw: aiRaw
      });
    }

    const assistantMessage = aiData?.choices?.[0]?.message?.content;
    if (!assistantMessage) {
      return res.status(500).json({
        message: "No message content returned from OpenAI.",
        raw: aiData
      });
    }

    let jsonText = assistantMessage.trim();

    // If the model still returned ```json ... ``` despite instructions, strip fences.
    if (jsonText.startsWith("```")) {
      const firstBrace = jsonText.indexOf("{");
      const lastBrace = jsonText.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1) {
        jsonText = jsonText.slice(firstBrace, lastBrace + 1);
      }
    }

    let note;
    try {
      note = JSON.parse(jsonText);
    } catch (e) {
      return res.status(500).json({
        message: "Assistant did not return valid JSON in message.content. Check the prompt.",
        assistantContent: assistantMessage
      });
    }

    return res.status(200).json({
      source: "sec.gov + openai",
      cusip,
      accessionNo,
      cik,
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


