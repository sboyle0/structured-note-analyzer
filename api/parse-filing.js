// api/parse-filing.js

// This route:
// 1) Takes ?cusip, ?accessionNo, ?cik
// 2) Calls /api/filing-html to get the HTML snippet from sec.gov
// 3) Sends that HTML to OpenAI with instructions to return JSON
// 4) Cleans off any ```json fences and returns the parsed JSON

export default async function handler(req, res) {
  try {
    const { cusip, accessionNo, cik } = req.query;

    if (!cusip || !accessionNo || !cik) {
      return res.status(400).json({
        message:
          "Missing query parameters. Required: cusip, accessionNo, cik. Example: /api/parse-filing?cusip=48136H7D4&accessionNo=0001213900-25-104551&cik=19617"
      });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(500).json({
        message: "OPENAI_API_KEY environment variable is not set in Vercel."
      });
    }

    // --- 1) Get HTML snippet from our existing /api/filing-html route ----
    // In production this is your Vercel domain. For local dev you can adjust.
    const baseUrl =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "https://structured-note-analyzer.vercel.app";

    const filingHtmlUrl = `${baseUrl}/api/filing-html?accessionNo=${encodeURIComponent(
      accessionNo
    )}&cik=${encodeURIComponent(cik)}`;

    const filingResp = await fetch(filingHtmlUrl);

    if (!filingResp.ok) {
      const raw = await filingResp.text();
      return res.status(502).json({
        message: "Error calling /api/filing-html",
        status: filingResp.status,
        body: raw
      });
    }

    const filingData = await filingResp.json();
    const htmlPreview = filingData.htmlPreview;

    if (!htmlPreview) {
      return res.status(500).json({
        message:
          "No htmlPreview returned from /api/filing-html. Cannot parse terms.",
        filingData
      });
    }

    // --- 2) Call OpenAI to extract terms from HTML snippet -------------

    // Helper prompt text describing the JSON shape we want.
    const schemaDescription = `
You must return a SINGLE JSON object with the following shape:

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
      "weighting": number | null,
      "worst_of_or_basket": string | null
    }
  ],
  "payoff_today": {
    "amount_per_1000": number | null,
    "pct_of_par": number | null,
    "status": string | null,
    "status_variant": string | null,
    "explanation": string | null,
    "subtitle": string | null
  }
}

Rules:
- Use null if a field is not stated or cannot be determined.
- Dates can be left as human-readable strings (e.g. "October 29, 2025").
- "worst_of_or_basket" should be "worst_of", "basket", or null.
- "status_variant" should be one of "upside", "downside", "neutral", or null.
- DO NOT include any extra fields.
- DO NOT include any comments.
- DO NOT wrap the JSON in backticks or a code block.
Return ONLY the JSON.
`.trim();

    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini", // you can change this if you prefer another model
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "You extract structured terms from U.S. SEC structured note pricing supplements for financial advisors."
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    schemaDescription +
                    `

Context:
- CUSIP: ${cusip}
- CIK: ${cik}
- Accession number: ${accessionNo}

Here is an HTML snippet from the pricing supplement. Extract the note terms into the JSON shape above, following all rules.`
                },
                {
                  type: "text",
                  text: htmlPreview.slice(0, 6000) // avoid sending huge content
                }
              ]
            }
          ]
        })
      }
    );

    const rawOpenAI = await openaiResponse.text();

    if (!openaiResponse.ok) {
      // Surface the error from OpenAI so we can debug easily
      return res.status(openaiResponse.status).json({
        message: "OpenAI API returned a non-OK status",
        status: openaiResponse.status,
        body: rawOpenAI
      });
    }

    let openaiData;
    try {
      openaiData = JSON.parse(rawOpenAI);
    } catch (e) {
      return res.status(500).json({
        message: "Could not parse JSON from OpenAI API response",
        raw: rawOpenAI
      });
    }

    const assistantContent =
      openaiData?.choices?.[0]?.message?.content || "";

    if (!assistantContent) {
      return res.status(500).json({
        message:
          "OpenAI response did not contain message.content. Check model / prompt.",
        openaiRaw: openaiData
      });
    }

    // --- 3) Clean off ```json fences if the model ignored our instructions ---

    function extractJsonFromText(text) {
      let trimmed = text.trim();

      if (trimmed.startsWith("```")) {
        // remove starting ``` or ```json
        const firstNewline = trimmed.indexOf("\n");
        if (firstNewline !== -1) {
          trimmed = trimmed.substring(firstNewline + 1);
        } else {
          // whole thing is just ```...``` one line; strip leading fences
          trimmed = trimmed.replace(/^```[a-zA-Z0-9]*\s*/g, "");
        }

        // remove trailing ```
        const lastFence = trimmed.lastIndexOf("```");
        if (lastFence !== -1) {
          trimmed = trimmed.substring(0, lastFence);
        }
      }

      return trimmed.trim();
    }

    const cleaned = extractJsonFromText(assistantContent);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({
        message:
          "Assistant did not return valid JSON even after cleaning. See assistantContent and cleaned.",
        assistantContent,
        cleaned
      });
    }

    // --- 4) Return the parsed JSON plus a bit of meta -------------------

    return res.status(200).json({
      source: "sec.gov+openai",
      cusip,
      accessionNo,
      cik,
      htmlPreviewLength: htmlPreview.length,
      terms: parsed
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Internal server error in /api/parse-filing",
      error: err.toString()
    });
  }
}


