import { CRO_CHECKPOINTS, formatCheckpointList } from "./shopifyStandards.js";
import { aggregateFeatureMatrix, FEATURE_LABELS } from "./featureDetection.js";
import { urlsEquivalent } from "./utils.js";

/**
 * Build a compact, prompt-friendly summary of one page.
 * Only the fields useful for the audit are kept — we never dump raw JSON.
 */
function summarisePageForPrompt(page) {
  if (!page) return null;
  const features = page.featureDetection?.features || {};

  const perPageFeatures = {};
  for (const [key, result] of Object.entries(features)) {
    if (!result || result.present === null) continue;
    perPageFeatures[key] = {
      present: result.present,
      confidence: result.confidence,
      evidence: (result.evidence || []).slice(0, 3)
    };
  }

  return {
    pageType: page.pageType,
    url: page.url,
    title: page.title,
    themeName: page.themeName || "",
    heroText: page.heroText || "",
    metaDescription: page.metaDescription || "",
    aboveFoldHasHeadlineAndCta: Boolean(page.aboveFoldModule?.messageAndCtaPresent),
    ctaCandidates: page.ctaCandidates || [],
    featureSignals: perPageFeatures,
    textSnippet: (page.textSnippet || "").slice(0, 1200)
  };
}

function formatFeatureBucket(title, entries, { withEvidence = true } = {}) {
  if (!entries.length) return `${title}: (none)\n`;
  const lines = [title + ":"];
  for (const entry of entries) {
    const label = FEATURE_LABELS[entry.key] || entry.key;
    if (withEvidence && entry.evidence && entry.evidence.length) {
      lines.push(`  - ${label} — evidence: ${entry.evidence.join("; ")}`);
    } else {
      lines.push(`  - ${label}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function buildAuditPrompt({ storeUrl, pages, date, additionalPageUrls = [] }) {
  // Detected theme name (gives the LLM context)
  const themePage = pages.find((p) => p?.themeInfo?.schemaName || p?.themeInfo?.instanceName || p?.themeName);
  const detectedTheme = themePage?.themeInfo?.schemaName || themePage?.themeName || "";
  const detectedThemeLabel = themePage?.themeInfo?.instanceName || "";

  // Aggregated 4-bucket feature matrix
  const matrix = aggregateFeatureMatrix(pages);

  const presentBlock = formatFeatureBucket(
    "PRESENT (high-confidence — feature EXISTS in this store; NEVER recommend adding/implementing/introducing this feature)",
    matrix.present
  );
  const likelyBlock = formatFeatureBucket(
    "LIKELY PRESENT (medium-confidence — treat as present; NEVER recommend adding/implementing/introducing this feature)",
    matrix.likelyPresent
  );
  const uncertainBlock = formatFeatureBucket(
    "UNCERTAIN (could not determine from crawl — do NOT claim this is missing; do NOT include in recommendations unless you have other explicit evidence)",
    matrix.uncertain,
    { withEvidence: false }
  );
  const absentBlock = formatFeatureBucket(
    "CONFIRMED ABSENT (high-confidence missing — safe to recommend adding)",
    matrix.absent
  );

  // Build the CRO checklist text for each page area, including the present/absent
  // status of any linked feature. Use this so the model knows WHICH checkpoints
  // it can already cross off without flagging.
  function annotatedCheckpoints(area) {
    const items = CRO_CHECKPOINTS[area] || [];
    const presentKeys = new Set(matrix.present.map((f) => f.key).concat(matrix.likelyPresent.map((f) => f.key)));
    const absentKeys  = new Set(matrix.absent.map((f) => f.key));
    const lines = [];
    let lastGroup = "";
    for (const cp of items) {
      if (cp.group !== lastGroup) {
        lines.push(`  ${cp.group}:`);
        lastGroup = cp.group;
      }
      let status = "[unknown — verify against page evidence]";
      if (cp.linkedFeature) {
        if (presentKeys.has(cp.linkedFeature)) status = "[✓ DETECTED — do NOT flag as missing]";
        else if (absentKeys.has(cp.linkedFeature)) status = "[✗ CONFIRMED MISSING — safe to recommend adding]";
        else status = "[? uncertain — only flag if you can quote specific page evidence]";
      }
      lines.push(`    - ${cp.text} ${status}`);
    }
    return lines.join("\n");
  }

  const pageSummaries = pages.map(summarisePageForPrompt).filter(Boolean);
  const requestedAdditionalPages = Array.isArray(additionalPageUrls)
    ? additionalPageUrls.filter(Boolean)
    : [];
  const additionalPagesBlock = requestedAdditionalPages.length
    ? `
═══════════════════════════════════════════════════════════════════════
MERCHANT-REQUESTED ADDITIONAL PAGES (must audit each URL below in "Other Pages"):
═══════════════════════════════════════════════════════════════════════
${requestedAdditionalPages.map((u, i) => `${i + 1}. ${u}`).join("\n")}

Crawl status for requested URLs:
${requestedAdditionalPages
  .map((u) => {
    const crawled = pageSummaries.some((summary) => urlsEquivalent(summary.url, u));
    return `- ${u}: ${crawled ? "crawled (evidence available)" : "NOT crawled (state that only; no invented recommendations)"}`;
  })
  .join("\n")}

Rules for these URLs:
- Include one numbered subsection per URL in "Other Pages - Key Areas of Improvement".
- Use crawl evidence from PER-PAGE CRAWL SUMMARY for that URL only. If a URL has no crawl row, write one sentence that the page could not be crawled and omit recommendations for it.
- If a page has no meaningful issues, use one sentence stating it is solid and do not invent problems.
- Do not skip a URL because another additional page already has findings.
- Order subsections in the same order as the list above.
`
    : "";

  return `
You are a senior Shopify CRO and UX auditor. Generate a professional, practical, implementation-ready audit report. The report must be concise, client-friendly, accurate, and similar to a consultant handoff document.

Context:
- Store URL: ${storeUrl}
- Audit date: ${date}
- Platform: Shopify
- Detected theme (schema_name): ${detectedTheme || "(not clearly detected)"}${
    detectedThemeLabel && detectedThemeLabel !== detectedTheme
      ? `\n- Theme instance label (Shopify.theme.name): ${detectedThemeLabel}`
      : ""
  }
${additionalPagesBlock}
═══════════════════════════════════════════════════════════════════════
DETECTED FEATURES MATRIX (ground truth from the live crawl):
═══════════════════════════════════════════════════════════════════════ 
${presentBlock}
${likelyBlock}
${uncertainBlock}
${absentBlock}

═══════════════════════════════════════════════════════════════════════
HARD RULES (absolute — never break):
═══════════════════════════════════════════════════════════════════════
1. NEVER recommend adding, installing, implementing, or introducing any feature listed under PRESENT or LIKELY PRESENT. If "Product image zoom" is PRESENT, do NOT write "Add image zoom"; you MAY write "Improve image resolution" only if you can cite specific evidence of a quality issue.
2. NEVER claim an UNCERTAIN feature is missing. Either omit it entirely or phrase it as "recommended to validate on the live theme".
3. Different Shopify themes use different class names, file names, and code. NEVER reference class names, file names, JS variables, or theme-specific code in the report.
4. NEVER make generic recommendations. Every bullet must reference a SPECIFIC, OBSERVABLE issue you can describe in plain language. Forbidden generic phrases include: "improve hierarchy", "enhance product cards", "redesign filter interface", "better presentation", "more engaging", "improve user experience", "optimize the experience", "create scannable sections", "implement comprehensive X", "strategic organization", "interactive elements that drive engagement", "needs strategic organization".
5. Every recommendation MUST trace back to a SPECIFIC CRO checkpoint (see lists below) AND to OBSERVABLE evidence from the crawl. If you cannot point to evidence for an issue, OMIT it. Don't pad.
6. NEVER invent a problem to justify a section. If a page has nothing meaningfully wrong, write ONE sentence saying it's solid and move on. It is FINE to have a short report.
7. NEVER include SEO, page-speed, or performance recommendations. They are out of scope.
8. NEVER include "Ensure …" phrasing. Use direct verbs: "Add", "Place", "Use", "Show", "Display".

═══════════════════════════════════════════════════════════════════════
HOW TO WRITE EACH RECOMMENDATION:
═══════════════════════════════════════════════════════════════════════
For each subsection:
  - HEADING (numbered, e.g. "3. Above-the-Fold Trust Signals")
  - ONE issue paragraph (1–3 sentences) that CITES SPECIFIC OBSERVABLE EVIDENCE
    Example GOOD: "The hero headline reads 'Welcome to Hyper' which does not convey what the store sells or why a visitor should buy."
    Example BAD: "The hero section could be enhanced for stronger conversion."
  - "Recommendations:" label
  - 3–6 concrete bullets, each containing:
    * What to change (specific, observable)
    * Why (link to conversion / trust / clarity)
    * Avoid every forbidden generic phrase listed in HARD RULE #4

If you would have to invent generic language to fill a section, OMIT the section.

═══════════════════════════════════════════════════════════════════════
CRO CHECKLIST — verify only against these; do not invent new categories:
═══════════════════════════════════════════════════════════════════════

— GENERAL / SITE-WIDE:
${annotatedCheckpoints("general")}

— NAVIGATION:
${annotatedCheckpoints("navigation")}

— SEARCH:
${annotatedCheckpoints("search")}

— CART WIDGET (header):
${annotatedCheckpoints("cartWidget")}

— FOOTER:
${annotatedCheckpoints("footer")}

— HOME PAGE:
${annotatedCheckpoints("home")}

— COLLECTION PAGE:
${annotatedCheckpoints("collection")}

— PRODUCT PAGE:
${annotatedCheckpoints("product")}

— CART PAGE:
${annotatedCheckpoints("cart")}

═══════════════════════════════════════════════════════════════════════
REPORT STRUCTURE (exact headings):
═══════════════════════════════════════════════════════════════════════
1) Shopify Store Audit - <Store Name or Domain>
2) Website: <store URL>
3) Summary
4) Home Page - Key Areas of Improvement
5) Collection Page - Key Areas of Improvement
6) Product Page - Key Areas of Improvement
${requestedAdditionalPages.length ? "7) Other Pages - Key Areas of Improvement" : "7) OMIT ENTIRELY — no merchant-requested additional URLs were provided; do NOT add an Other Pages section"}
${requestedAdditionalPages.length ? "8" : "7"}) Final Recommendation

Section depth (these are MAX, not minimums — drop sections that don't have real findings):
- Summary: 3 short paragraphs.
   - P1: what this audit covered.
   - P2: 2–3 specific things the theme already does well, CITED from the PRESENT/LIKELY PRESENT matrix.
   - P3: the 2–3 most impactful opportunity areas (drawn from the body).
- Home Page: up to 6 subsections.
- Collection Page: up to 5 subsections.
- Product Page: up to 6 subsections.
- Other Pages: ONLY when merchant-requested additional URLs are listed above — one subsection per URL. If no list was provided above, do not include this section at all.
- Final Recommendation: 5 prioritized bullets that summarise actual report findings (no new ideas). 

Layout requirements:
- Markdown headings and lists only. No tables.
- No "Status / Requirement / Evidence / Reference / Quality Scorecard" labels.
- For "Other Pages" (only when additional URLs were provided), include the exact URL under each subsection heading:
    URL: <full page url>
- Avoid vague filler: "overall foundation", "notably", "could be improved", "would benefit from" without evidence.
- Avoid the words "Ensure" / "ensure".
- Do not repeat the same recommendation across sections.
- Do not include a Reference Benchmark / Reference Screenshots section.
- Do not invent app names unless the merchant clearly needs one and you are explicit about why.

═══════════════════════════════════════════════════════════════════════
PER-PAGE CRAWL SUMMARY (use as supporting evidence; do not quote class names):
═══════════════════════════════════════════════════════════════════════
\`\`\`json
${JSON.stringify(pageSummaries, null, 2)}
\`\`\`
`;
}
