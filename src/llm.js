import OpenAI from "openai";

/**
 * Generate the audit markdown.
 *
 * Uses the Chat Completions API (client.chat.completions.create), which is what
 * OpenRouter implements. The previous version called client.responses.create
 * (the OpenAI Responses API), which OpenRouter does NOT support — so with
 * OPENROUTER_API_KEY set (and an Anthropic model like claude-3.5-haiku) the call
 * would fail or behave unpredictably. Chat Completions works for both OpenRouter
 * and OpenAI.
 */
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

  const draftResponse = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2
  });

  const draft = draftResponse.choices?.[0]?.message?.content?.trim() || "";
  if (!draft) return "";

  // Refine pass often reintroduces generic CRO filler. Off by default; enable with AUDIT_ENABLE_REFINE=1.
  if (process.env.AUDIT_FAST_MODE === "1" || process.env.AUDIT_ENABLE_REFINE !== "1") {
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
- Do NOT pad with generic subsections (e.g. "Verify mobile responsiveness", "Enhance currency options") unless the draft already quotes specific observed text from the crawl.
- Delete any recommendation bullet that does not quote a real observed headline, CTA label, nav item, price, or review count from the draft/crawl. Do not replace deleted bullets with invented ones.
- If a numbered subsection has no evidence-backed bullets after cleanup, delete the entire subsection.
- Keep writing like a human consultant manually auditing the store.
- Do not use "Ensure/ensure" phrasing in recommendation bullets.
- Do not include "Reference:" lines.
- PRESERVE every hidden evidence tag exactly as written: keep each [ev: "..."] tag at the end of its recommendation bullet. Do not remove, move, or reword these tags.
- Use only the detected theme name from the draft; do not substitute "Dawn" unless the draft explicitly says Dawn.
- In "Other Pages" subsections, print the exact page URL on its own line as: URL: <full page url>.
- Remove fluff, repetition, and vague statements.
- Output only final markdown.

Audit draft:
${draft}
`;

  const finalResponse = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: refinePrompt }],
    temperature: 0.1
  });

  return finalResponse.choices?.[0]?.message?.content?.trim() || draft;
}