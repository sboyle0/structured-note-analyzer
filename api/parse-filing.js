export default async function handler(req, res) {
  try {
    const { cusip, accessionNo, cik } = req.query;

    if (!cusip || !accessionNo || !cik) {
      return res.status(400).json({
        message:
          "Missing required query params. Example: ?cusip=48136H7D4&accessionNo=0001213900-25-104551&cik=19617"
      });
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return res.status(500).json({
        message: "OPENAI_API_KEY environment variable is not set in Vercel."
      });
    }

    // --- 1) Get HTML preview from our own /api/filing-html endpoint ---

    const baseUrl =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000";

    const filingUrl = `${baseUrl}/api/filing-html?accessionNo=${encodeURIComponent(
      accessionNo
    )}&cik=${encodeURIComponent(cik)}`;

    const filingRes = await fetch(filingUrl);
    const filingJson = await filingRes.json();

    if (!filingRes.ok) {
      return res.status(filingRes.status).json({
        message: "Error fetching filing HTML via /api/filing-html",
        filingUrl,
        filingJson
      });
    }

    const htmlPreview = filingJson.htmlPreview;
    if (!htmlPreview) {
      return res.status(500).json({
        message: "filing-html did not return htmlPreview.",
        filingJson
      });
    }

    // --- 2) Call OpenAI to extract structured note terms ---

    const systemPrompt = `
You are a structured note prospectus parser.
You receive HTML from a pricing supplement (SEC 424B2 / FWP) and must extract key trade terms.

Always return a SINGLE JSON object ONLY, with NO surrounding text and NO markdown code fences.
If something is missing or not clearly stated, use null for that field.

The JSON MUST have exactly this shape:

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
    "status_variant": string,
    "explanation": string,
    "subtitle": string
  }
}

Do NOT include any markdown, backticks, or commentary – only valid JSON.
`;

    const userPrompt = `
Here is a fragment of the pricing supplement HTML from sec.gov.

CUSIP: ${cusip}
CIK: ${cik}
Accession No: ${accessionNo}

HTML (truncated):
${htmlPreview.slice(0, 12000)}
`;

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    const openaiRawText = await openaiRes.text();

    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json({
        message: "OpenAI API returned a non-OK status",
        status: openaiRes.status,
        body: openaiRawText
      });
    }

    let openaiData;
    try {
      openaiData = JSON.parse(openaiRawText);
    } catch (e) {
      return res.status(500).json({
        message: "Could not parse JSON from OpenAI response",
        raw: openaiRawText
      });
    }

    const content = openaiData?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      return res.status(500).json({
        message: "OpenAI response did not contain message.content as a string",
        openaiData
      });
    }

    // --- 3) Make sure we have clean JSON (strip code fences if any still appear) ---

    let jsonText = content.trim();

    if (jsonText.startsWith("```")) {
      // Remove leading ``` or ```json and trailing ```
      jsonText = jsonText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/, "")
        .trim();
    }

    let note;
    try {
      note = JSON.parse(jsonText);
    } catch (e) {
      return res.status(500).json({
        message: "Assistant did not return valid JSON in message.content. Check the prompt.",
        assistantContent: content
      });
    }

    // --- 4) Return structured note terms ---

    return res.status(200).json({
      source: "sec.gov + OpenAI",
      cusip,
      accessionNo,
      cik,
      htmlPreviewLength: htmlPreview.length,
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

