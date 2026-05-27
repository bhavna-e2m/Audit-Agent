import OpenAI from "openai";

export async function generateAuditMarkdown(prompt, model) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const baseURL = useOpenRouter
    ? process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
    : process.env.OPENAI_BASE_URL || undefined;

  const client = new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: useOpenRouter
      ? {
          ...(process.env.OPENROUTER_HTTP_REFERER
            ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER }
            : {}),
          ...(process.env.OPENROUTER_X_TITLE
            ? { "X-Title": process.env.OPENROUTER_X_TITLE }
            : {})
        }
      : undefined
  });

  const draftResponse = await client.responses.create({
    model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }]
      }
    ],
    temperature: 0.2
  });

  const draft = draftResponse.output_text?.trim() || "";
  if (!draft) return "";

  // Fast mode: skip second refinement call for speed.
  if (process.env.AUDIT_FAST_MODE === "1") {
    return draft;
  }

  const refinePrompt = `
You are a senior Shopify QA reviewer.
Refine the following audit to be higher quality and more accurate.

Hard requirements:
- Keep same high-level section structure.
- No tables.
- Keep recommendations tied to Shopify standards, not generic website advice.
- Do not include SEO recommendations.
- Do not include speed/performance optimization recommendations.
- Do not create dedicated SEO or Performance sections.
- Keep Home Page section at 5-6 subsections with clear "Recommendations:" and actionable bullets.
- Keep writing like a human consultant manually auditing the store.
- Do not use "Ensure/ensure" phrasing in recommendation bullets.
- Do not include "Reference:" lines.
- In "Other Pages" subsections, print the exact page URL on its own line as: URL: <full page url>.
- Remove fluff, repetition, and vague statements.
- Output only final markdown.

Audit draft:
${draft}
`;

  const finalResponse = await client.responses.create({
    model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: refinePrompt }]
      }
    ],
    temperature: 0.1
  });

  return finalResponse.output_text?.trim() || draft;
}
