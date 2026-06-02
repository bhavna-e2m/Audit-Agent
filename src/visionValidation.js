import { chromium } from "playwright";

/**
 * VISION VALIDATION LAYER (optional, suppression-only)
 * ----------------------------------------------------
 * Purpose: close the last gap between a human read of a page and the agent's
 * detector/digest view. The deterministic pipeline decides which sections are
 * "missing". Before those ship, we render the page to a screenshot and ask a
 * vision-capable model, strictly from the image, whether each supposedly-missing
 * section is actually visible. Any the model can SEE are removed from the
 * missing list (suppressed). 
 *
 * Design rules (kept deliberately conservative):
 *  - SUPPRESS ONLY. Vision can turn a false "missing" into "present". It can
 *    NEVER add a new finding — so it cannot reintroduce hallucinated problems.
 *  - OFF BY DEFAULT. No-ops unless VISION_MODEL + an API key are configured, so
 *    the deterministic behaviour is unchanged until you opt in.
 *  - FAIL SAFE. Any error (render, network, parse) returns an empty set →
 *    no suppression, never a crash, the audit proceeds exactly as before.
 */

const SECTION_VISION_DESC = {
  hero: "a hero / banner / slideshow at the top with a headline or value proposition",
  benefits:
    "a benefits / value-prop / trust icon row (e.g. free shipping, easy returns, guarantee, secure checkout)",
  featuredCollection:
    "a featured product or collection showcase that merchandises actual products inline (product cards with images/prices), not just category tiles",
  testimonials:
    "customer testimonials, reviews, named customer quotes, star ratings, or a review score",
  brandStory:
    "a brand story / about / mission / 'meet the team' / founder narrative section",
  newsletter: "an email newsletter signup form",
  productRecommendations:
    "a related / recommended / 'you may also like' / 'frequently bought together' product row",
  faq: "a FAQ / frequently-asked-questions section (often an accordion)",
  sizeGuide: "a size guide / size chart / fit guide / measurement table",
  pressStrip:
    "a press / 'as seen on' / 'featured in' media-logo strip, or a marketplace-bestseller / 'trusted by' logo bar"
};

function visionConfigured(opts = {}) {
  const key =
    opts.apiKey ||
    process.env.VISION_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY;
  const model = opts.model || process.env.VISION_MODEL;
  return Boolean(key && model);
}

async function renderFullPagePng(url, { timeout = 30000 } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-US"
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    try {
      await page.waitForLoadState("networkidle", { timeout: 6000 });
    } catch {
      /* chatty stores never settle — fine */
    }
    // Force lazy sections to paint (same idea as the crawler's scroll pass).
    try {
      await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const step = Math.max(400, Math.floor(window.innerHeight * 0.85));
        const maxScroll = () =>
          Math.max(
            document.body ? document.body.scrollHeight : 0,
            document.documentElement ? document.documentElement.scrollHeight : 0
          );
        let y = 0;
        for (let i = 0; i < 40 && y < maxScroll(); i++) {
          window.scrollTo(0, y);
          y += step;
          await sleep(200);
        }
        window.scrollTo(0, 0);
        await sleep(200);
      });
    } catch {
      /* best-effort */
    }
    return await page.screenshot({ fullPage: true, type: "png" });
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Ask the vision model which of `candidateTypes` are actually visible on the
 * page. Returns a Set of the types it confirms PRESENT. Empty set on any
 * failure or when vision is not configured.
 */
export async function validateSectionsWithVision({
  url,
  pageType = "home",
  candidateTypes = [],
  model,
  apiKey,
  endpoint,
  pngBuffer
} = {}) {
  const types = candidateTypes.filter((t) => SECTION_VISION_DESC[t]);
  if (!types.length) return new Set();
  if (!visionConfigured({ model, apiKey })) return new Set();

  const key =
    apiKey ||
    process.env.VISION_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY;
  const visionModel = model || process.env.VISION_MODEL;
  const url_ = endpoint || process.env.VISION_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions";

  let png = pngBuffer;
  if (!png) {
    try {
      png = await renderFullPagePng(url);
    } catch (err) {
      console.log(`vision: screenshot failed for ${url} — ${err.message}`);
      return new Set();
    }
  }
  const b64 = Buffer.from(png).toString("base64");

  const list = types.map((t) => `- ${t}: ${SECTION_VISION_DESC[t]}`).join("\n");
  const system =
    "You verify whether specific sections are visible in a screenshot of a web page. " +
    "Judge ONLY from what is visibly rendered in the image. Do not guess. Output strict JSON only.";
  const userText =
    `This is a full-page screenshot of a Shopify ${pageType} page.\n` +
    `For EACH item below, decide if it is visibly present ANYWHERE on the page.\n${list}\n\n` +
    `Return ONLY a JSON object mapping each key to "present" or "absent", e.g. ` +
    `{"testimonials":"present","brandStory":"absent"}. No explanation, no prose.`;

  const body = {
    model: visionModel,
    max_tokens: 400,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
        ]
      }
    ]
  };

  try {
    const res = await fetch(url_, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      console.log(`vision: API ${res.status} for ${url}`);
      return new Set();
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const jsonMatch = typeof text === "string" ? text.match(/\{[\s\S]*\}/) : null;
    if (!jsonMatch) return new Set();
    const parsed = JSON.parse(jsonMatch[0]);
    const present = new Set();
    for (const [t, v] of Object.entries(parsed)) {
      if (types.includes(t) && /present/i.test(String(v))) present.add(t);
    }
    if (present.size) {
      console.log(
        `vision: ${url} — confirmed PRESENT (suppressing false "missing"): ${Array.from(present).join(", ")}`
      );
    }
    return present;
  } catch (err) {
    console.log(`vision: request failed for ${url} — ${err.message}`);
    return new Set();
  }
}

/**
 * Annotate crawled pages in place with `observed.visionPresentSections` for any
 * supposedly-missing section the vision model can actually see. analyzeStorefront
 * reads that array as another "satisfied" source, exactly like the text digest —
 * so both the prompt's missing list AND the deterministic injector are suppressed
 * consistently. No-op (and silent) when vision is not configured.
 */
export async function annotatePagesWithVision(pages = [], missingByPageType = {}, opts = {}) {
  if (!visionConfigured(opts)) return;
  for (const p of pages) {
    const label = (p.pageType || "general") === "general" ? "home" : p.pageType;
    const candidates = missingByPageType[label];
    if (!candidates || !candidates.length) continue;
    // Reuse a crawl screenshot if one was already captured for this page.
    let pngBuffer;
    const present = await validateSectionsWithVision({
      url: p.url,
      pageType: label,
      candidateTypes: candidates,
      pngBuffer,
      ...opts
    });
    if (present.size) {
      p.observed = p.observed || {};
      const existing = new Set(p.observed.visionPresentSections || []);
      for (const t of present) existing.add(t);
      p.observed.visionPresentSections = Array.from(existing);
    }
  }
}

export { visionConfigured };