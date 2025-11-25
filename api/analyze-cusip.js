// api/analyze-cusip.js
import OpenAI from "openai";

const SEC_API_KEY = process.env.SEC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Helper: basic JSON response
function sendJson(res, statusCode, data) {
  res.status(statusCode).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

// Helper: call sec-api search to find the most recent final terms for a CUSIP
async function findFilingForCusip(cusip) {
  const body = {
    query: {
      query_string: {
        // You can refine this query later if needed
        query: `cusip:"${cusip}" AND (formType:"424B2" OR formType:"FWP" OR formType:"424B5")`
      }
    },
    from: 0,
    size: 1,
    sort: [{ filedAt: { order: "desc" } }]
  };

  const resp = await fetch("https://api.sec-api.io/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: SEC_API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    throw new Error(`sec-api search error: ${resp.status}`);
  }

  const json = await resp.json();
  const hit = json.filings && json.filings[0];

  if (!hit) {
    return null;
  }

  return {
    accessionNo: hit.accessionNo,
    formType: hit.formType,
    filedAt: hit.filedAt,
    companyName: hit.companyName,
    cik: hit.cik
  };
}

// Helper: fetch the full text of a filing
async function fetchFilingText(accessionNo) {
  // This uses sec-api's filing-text endpoint. If sec-api changes this,
  // adjust the URL accordingly based on their docs.
  const url = `https://api.sec-api.io/filing-text?accession-no=${encodeURIComponent(
    accessionNo
  )}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: SEC_API_KEY
    }
  });

  if (!resp.ok) {
    throw new Error(`sec-api filing-text error: ${resp.status}`);
  }

  const text = await resp.text();

  // Optional: truncate if extremely long to keep token usage reasonable
  const MAX_CHARS = 20000;
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

// Helper: ask OpenAI to extract structured note terms
async function extractNoteTermsFromText(filingText) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  const systemPrompt = `
You are a specialist in US structured products.
You will receive the text of a FINAL PRICING SUPPLEMENT or FREE WRITING PROSPECTUS for a structured note.

Your job is to return a STRICT JSON object describing the note terms, with NO extra commentary.
If a value is not clearly stated, use null.

The JSON schema MUST be:

{
  "issuer": string | null,
  "issuer_sub": string | null,
  "trade_date": string | null,            // free-text date, e.g. "January 12, 2024"
  "maturity_date": string | null,
  "product_type": string | null,          // e.g. "Autocallable Contingent Income Note"
  "profile_key": string | null,           // short classification key, e.g. "autocallable_single_underlier_barrier"
  "coupon": {
    "label": string | null,               // short label, e.g. "8.50% p.a. contingent, quarterly"
    "structure": string | null,          // plain English summary of coupon mechanics (1–3 sentences)
    "barrier": string | null             // how coupon barrier works (level, % of initial, etc.)
  },
  "protection": {
    "label": string | null,              // e.g. "70% European barrier"
    "principal": string | null,          // plain English principal protection description
    "downside": string | null            // what happens if barrier is breached
  },
  "underliers": [
    {
      "name": string | null,
      "ticker": string | null,
      "role": string | null,             // e.g. "Sole underlier", "Worst-of underlier", etc.
      "initial_level": number | null
    }
  ],
  "payoff_today": {
    "amount_per_1000": number | null,    // leave null for now, do NOT invent
    "pct_of_par": number | null,        // leave null for now
    "status": string,                    // e.g. "Not yet calculated"
    "status_variant": "upside" | "downside",
    "explanation": string,               // short explanation that payoff logic is not calculated yet
    "subtitle": string                   // e.g. "Phase 1 – only filing lookup is live."
  }
}

Important:
- Return ONLY JSON, no markdown, no explanation.
- Use short, advisor-friendly language.
- Underliers: if there is a basket or worst-of, reflect that in the "role" field.
- Do not try to calculate any payoff numbers for "payoff_today"; those are out of scope for this step.
`;

  const userPrompt = `
Here is the text of a US structured note final pricing supplement or related document.
Extract the note terms according to the schema.

Document text:
"""${filingText}"""
`;

  const completion = await client.chat.completions.create({
    model: "gpt-4.1", // or "gpt-4o" / whatever model you prefer
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No content returned from OpenAI");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error("Failed to parse JSON from OpenAI");
  }

  // Ensure there's at least a minimal payoff_today block
  if (!parsed.payoff_today) {
    parsed.payoff_today = {
      amount_per_1000: null,
      pct_of_par: null,
      status: "Not yet calculated",
      status_variant: "upside",
      explanation:
        "Payoff values are not calculated in this phase. Only note terms are extracted from the filing.",
      subtitle: "Phase 1 – payoff calculation not implemented yet."
    };
  }

  return parsed;
}

// Vercel / Next.js API handler
export default async function handler(req, res) {
  try {
    const { cusip } = req.query;

    if (!cusip) {
      return sendJson(res, 400, { error: "Missing 'cusip' query parameter" });
    }

    if (!SEC_API_KEY) {
      return sendJson(res, 500, { error: "SEC_API_KEY is not set" });
    }

    // 1) Find a relevant filing for this CUSIP
    const filingMeta = await findFilingForCusip(cusip);
    if (!filingMeta) {
      return sendJson(res, 404, {
        error: "No filing found for this CUSIP",
        cusip
      });
    }

    // 2) Get the full filing text from sec-api
    const filingText = await fetchFilingText(filingMeta.accessionNo);

    // 3) Ask OpenAI to extract the structured note terms
    const noteTerms = await extractNoteTermsFromText(filingText);

    // 4) Return combined response
    return sendJson(res, 200, {
      source: "sec-api.io + openai",
      cusip,
      filingMeta,
      note: noteTerms
    });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, {
      error: "Internal error in analyze-cusip",
      details: err.message || String(err)
    });
  }
}

