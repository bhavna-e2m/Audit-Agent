import { CRO_CHECKPOINTS, formatCheckpointList, EXPECTED_SECTIONS, SECTION_LABELS } from "./shopifyStandards.js";
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
    observed: page.observed || {},
    sections: (page.observed?.sections || []).map((s) => ({ type: s.type, heading: s.heading })),
    featureSignals: perPageFeatures,
    textSnippet: (page.textSnippet || "").slice(0, 1200)
  };
}

// ── Storefront gap analysis ────────────────────────────────────────────────
// Turns the raw section inventory + observed values into three explicit,
// store-specific lists the LLM can anchor findings to:
//   • SECTIONS PRESENT        — real sections + their real headings
//   • EXPECTED SECTIONS MISSING — present-vs-standard diff (safe to recommend)
//   • WEAK UI/UX SIGNALS      — observed values that indicate a concrete problem
// This is what stops the report being generic: the model is handed the actual
// gaps instead of having to guess them.

const GENERIC_HEADLINES =
  /^(home|welcome|welcome to our store|welcome to your store|shop|shop all|hello|untitled|main|index|frontpage)$/i;

function weakSignalsForPage(page) {
  const o = page.observed || {};
  const type = page.pageType || "general";
  const out = [];

  if (type === "general") {
    const h = (o.heroHeadline || "").trim();
    if (!h) {
      out.push('No clear hero headline detected above the fold');
    } else if (GENERIC_HEADLINES.test(h) || h.length < 8) {
      out.push(`Hero headline "${h}" does not say what the store sells or why to buy`);
    }
    if (Array.isArray(o.navLabels) && o.navLabels.length > 0 && o.navLabels.length < 3) {
      out.push(`Main navigation is thin (only ${o.navLabels.length} item(s): ${o.navLabels.join(", ")})`);
    }
    // NOTE: we intentionally do NOT emit a "no announcement/offer bar" signal
    // from an empty announcementText. Non-detection is not proof of absence
    // (custom themes use non-standard markup), and asserting "missing" here
    // violates the no-claiming-uncertain-features-missing rule. A genuinely
    // absent bar is better surfaced via the feature matrix when confidently
    // confirmed, not inferred from a parser miss.
  }

  if (type === "product") {
    if (typeof o.productGalleryImageCount === "number" && o.productGalleryImageCount > 0 && o.productGalleryImageCount < 3) {
      out.push(`Product gallery shows only ${o.productGalleryImageCount} image(s) — too few to convey the product`);
    }
    if (!o.reviewCountText) {
      out.push('No visible review count / star rating near the product title');
    }
    if (!o.priceText) {
      out.push('Price was not clearly detected near the buy button');
    }
  }

  if (type === "collection") {
    if (typeof o.collectionCardCount === "number" && o.collectionCardCount > 0 && o.collectionCardCount < 4) {
      out.push(`Collection grid shows only ${o.collectionCardCount} product(s) — looks sparse`);
    }
  }

  return out;
}

function pageHasDetectedFeature(page, featureKey) {
  const f = page?.observed?.features?.[featureKey] || page?.featureDetection?.features?.[featureKey];
  if (!f || f.present !== true) return false;
  return f.confidence === "high" || f.confidence === "medium";
}

function analyzeStorefront(pages = []) {
  const present = [];
  const missing = [];
  const weak = [];

  const repByType = {};
  for (const p of pages) {
    const t = p.pageType || "general";
    if (!repByType[t]) repByType[t] = p;
  }

  for (const [t, rep] of Object.entries(repByType)) {
    const inv = (rep.observed && rep.observed.sections) || [];
    const label = t === "general" ? "home" : t;
    for (const s of inv) present.push({ pageType: label, type: s.type, label: s.label, heading: s.heading });
    for (const sig of weakSignalsForPage(rep)) weak.push({ pageType: label, signal: sig });
  }

  const checkMissing = (repType, expKey, displayType) => {
    const rep = repByType[repType];
    if (!rep) return;
    // Crawl-confidence gate: if this page came back thin (JS-rendered content
    // never painted, or a bot wall), we cannot trust "section absent" — the
    // section may well exist but simply wasn't captured. Skip absence findings
    // for it rather than emit confident-but-wrong "missing" recommendations.
    if (rep.crawlThin) return;
    const exp = EXPECTED_SECTIONS[expKey];
    if (!exp) return;
    const have = new Set(((rep.observed && rep.observed.sections) || []).map((s) => s.type));
    // Ground-truth digest: every real section's heading + text snippet, even ones
    // the classifier could not TYPE. We scan it with per-type keyword sets so a
    // custom-named section (e.g. "Meet Our Team", "What Clients Talk About Us")
    // counts as present even if classifySectionType missed it — this is what lets
    // the analysis reason from the actual page, not just the detector's verdict.
    const digestText = (((rep.observed && rep.observed.sectionDigest) || [])
      .map((d) => `${d.heading} ${d.text}`)
      .join("  ")
      .toLowerCase());
    const DIGEST_KEYWORDS = {
      benefits: /\b(free shipping|fast shipping|easy returns?|money[- ]back|guarantee|secure (checkout|payment)|why (shop|choose|us)|no nonsense|we deliver|what you get|how it works|satisfaction)/,
      featuredCollection: /\b(featured (collection|product)|shop (our |the )?(collection|offers|favorite)|best ?seller|new arrival|trending (product|now)|our favorite|hot items)/,
      testimonials: /\b(what (our )?(customers?|clients?|people) (say|talk)|testimonial|review|rated|loved by|happy customers?|kind words)/,
      brandStory: /\b(our story|about us|our mission|meet (our|the) team|creative minds|where design|who we are|our journey|founded|our craft|the makers)/,
      newsletter: /\b(newsletter|subscribe|sign ?up|join (our )?(list|email)|off your (first )?order)/,
      faq: /\b(faq|frequently asked|common questions?)/,
      productRecommendations: /\b(you (may|might) also like|frequently bought|pairs well|complete the look|related product|recommended for you)/,
      sizeGuide: /\b(size (guide|chart)|fit (guide|finder|predictor)|find your (size|fit)|measurements?|true to size|sizing)/,
      pressStrip: /\b(as seen (on|in)|as featured (on|in)|featured in|in the press|bestseller on (amazon|flipkart)|trusted by|as recommended)/
    };
    const inDigest = (secType) => {
      const re = DIGEST_KEYWORDS[secType];
      return Boolean(re && digestText && re.test(digestText));
    };
    // Vision validation (optional layer): section types a vision model confirmed
    // visible on the page screenshot. Suppression-only — never adds a finding.
    const visionPresent = new Set(
      (rep.observed && rep.observed.visionPresentSections) || []
    );
    // The "featured collection" standard means products merchandised inline on
    // the home page (a featured-collection / featured-product / recommendations
    // grid). Category tiles (collectionList) are a DIFFERENT thing — they route
    // to collections but don't put products in front of the visitor — so they
    // do NOT satisfy this standard. (Search-drawer product grids are already
    // excluded from the section inventory upstream.)
    const showcaseSatisfied =
      have.has("featuredCollection") ||
      have.has("featuredProduct") || have.has("productRecommendations");
    // Social proof on THIS page is only satisfied by social proof ON THIS PAGE —
    // a review widget on the PDP must NOT credit the home with a testimonials
    // section it doesn't have. (Previously any page's reviews satisfied it.)
    const reviewsOnThisPage =
      have.has("testimonials") ||
      Boolean(rep.observed && rep.observed.reviewCountText) ||
      pageHasDetectedFeature(rep, "reviews");
    for (const [secType, reason] of Object.entries(exp)) {
      let satisfied = have.has(secType);
      if (secType === "featuredCollection" && showcaseSatisfied) satisfied = true;
      if (secType === "testimonials" && reviewsOnThisPage) satisfied = true;
      if (secType === "newsletter" && pageHasDetectedFeature(rep, "newsletterSignup")) satisfied = true;
      // Ground-truth override: if the page's real section headings/text clearly
      // contain this section, it is present even if the classifier missed it.
      if (!satisfied && inDigest(secType)) satisfied = true;
      if (!satisfied && visionPresent.has(secType)) satisfied = true;
      // A "benefits / trust strip" means an actual icon/benefits row on the page
      // (detected as a `benefits` section). A generic trustSignals feature — a
      // free-shipping line or a discount badge — is NOT a benefits strip, so it
      // no longer counts as satisfying this expectation.
      if (secType === "benefits" && have.has("benefits")) satisfied = true;
      if (!satisfied) {
        missing.push({ pageType: displayType, type: secType, label: SECTION_LABELS[secType] || secType, reason });
      }
    }
  };

  checkMissing("general", "home", "home");
  checkMissing("product", "product", "product");

  // Ground-truth section digest per page, for the prompt to show the model the
  // page's real content (not just the detector's verdict).
  const digests = [];
  for (const p of pages) {
    const dg = (p.observed && p.observed.sectionDigest) || [];
    if (!dg.length) continue;
    const label = p.pageType === "general" ? "home" : p.pageType;
    for (const d of dg.slice(0, 18)) {
      if (d.heading || d.text) digests.push({ pageType: label, heading: d.heading || "", text: d.text || "" });
    }
  }

  return { present, missing, weak, digests };
}

function formatStorefrontObservations(analysis) {
  const { present, missing, weak, digests } = analysis;
  const lines = [];

  lines.push("ACTUAL PAGE SECTIONS (ground truth — the real content blocks found on the page, with their headings/snippets. Treat this as authoritative: if a section type is clearly represented here, it EXISTS — do NOT recommend adding it even if it is not in the typed list below):");
  if (digests && digests.length) {
    for (const d of digests) {
      const h = d.heading ? `"${d.heading}"` : "(no heading)";
      const t = d.text ? ` — ${d.text.slice(0, 110)}` : "";
      lines.push(`  - [${d.pageType}] ${h}${t}`);
    }
  } else {
    lines.push("  (no section content captured — crawl may have been thin)");
  }
  lines.push("");

  lines.push("SECTIONS PRESENT (real sections detected on the live store — cite these headings; never recommend ADDING any of these):");
  if (present.length) {
    for (const s of present) {
      const head = s.heading ? ` — heading: "${s.heading}"` : " — (no heading text found)";
      lines.push(`  - [${s.pageType}] ${s.label}${head}`);
    }
  } else {
    lines.push("  (none detected)");
  }

  lines.push("");
  lines.push("EXPECTED SECTIONS MISSING (present in well-converting Shopify stores but confirmed NOT found on this store's crawl). These are verified gaps against Shopify standards — you MUST write one separate finding for EACH item below, on the page indicated, using the given reason. Do NOT omit, merge, or silently drop any of them; every item here has to appear as its own recommendation in the report:");
  if (missing.length) {
    for (const s of missing) {
      lines.push(`  - [${s.pageType}] ${s.label} — why it matters: ${s.reason}`);
    }
  } else {
    lines.push("  (no expected sections missing — do NOT invent missing sections)");
  }

  lines.push("");
  lines.push("WEAK UI/UX SIGNALS (concrete observed problems — each is a valid, evidence-backed finding you may write up):");
  if (weak.length) {
    for (const s of weak) {
      lines.push(`  - [${s.pageType}] ${s.signal}`);
    }
  } else {
    lines.push("  (no weak signals detected from the crawl)");
  }

  return lines.join("\n");
}

/** Where each CRO checkpoint area should appear in the client report body. */
const CHECKPOINT_REPORT_SECTION = {
  footer: "Home Page",
  general: "Home Page",
  navigation: "Home Page",
  search: "Home Page",
  cartWidget: "Home Page",
  home: "Home Page",
  collection: "Collection Page",
  product: "Product Page",
  cart: "Home Page"
};

/**
 * Linked CRO checkpoints that are CONFIRMED ABSENT in the feature matrix.
 * These MUST appear as recommendations — the LLM cannot skip them.
 */
export function formatAbsentCheckpointMandatoryList(pages = []) {
  const matrix = aggregateFeatureMatrix(pages);
  const absentKeys = new Set(matrix.absent.map((f) => f.key));
  const lines = [];

  for (const [area, items] of Object.entries(CRO_CHECKPOINTS)) {
    for (const cp of items) {
      if (!cp.linkedFeature || !absentKeys.has(cp.linkedFeature)) continue;
      const section = CHECKPOINT_REPORT_SECTION[area] || "Home Page";
      lines.push(`  - [${section}] ${cp.text} (checkpoint ${cp.id})`);
    }
  }

  if (!lines.length) {
    return "  (none — no linked checkpoints are confirmed absent on this crawl)";
  }
  return lines.join("\n");
}

/**
 * Flatten the storefront analysis into the set of strings the model is allowed
 * to use as evidence (real section headings/labels, missing-section labels and
 * reasons, weak-signal phrasings). auditService's evidence corpus includes
 * these so the accuracy guard does NOT delete legitimate missing-section and
 * weak-UX findings as if they were invented.
 */
export function storefrontEvidenceStrings(pages = []) {  const { present, missing, weak } = analyzeStorefront(pages);
  const out = [];
  for (const s of present) {
    if (s.heading) out.push(s.heading);
    if (s.label) out.push(s.label);
    if (s.type) out.push(s.type);
  }
  for (const s of missing) {
    if (s.label) out.push(s.label);
    if (s.reason) out.push(s.reason);
    if (s.type) out.push(s.type);
  }
  for (const s of weak) {
    if (s.signal) out.push(s.signal);
  }
  return out.filter(Boolean);
}

/**
 * Boolean guard data the deterministic post-processor uses to suppress
 * unsupported findings. `heroHeadlineWeak` mirrors the hero-headline weak
 * signal exactly: it is true ONLY when the crawl observed a missing or generic
 * headline. When false, any "the hero lacks a compelling headline" finding the
 * model wrote is unsupported and must be removed.
 */
/**
 * Deterministic finding templates for each expected-section type. Used to GUARANTEE
 * that every confirmed-missing standard appears in the report even if the LLM
 * dropped it — the injector (auditService) only adds those the model omitted, so
 * the model still phrases the ones it did write. Title + recommendation bullets
 * mirror the report's existing style.
 */
const MISSING_SECTION_FINDING = {
  hero: {
    title: "Hero Section / Above-the-Fold Clarity",
    recs: [
      "Add a clear, benefit-driven hero headline (real text, not baked into an image) that says what the store sells",
      "Pair it with a short supporting subheadline and a prominent primary CTA"
    ]
  },
  benefits: {
    title: "Missing Value Proposition / Trust Strip",
    recs: [
      "Add a benefits / trust icon row (e.g. shipping, easy returns, COD, secure checkout)",
      "Use concise, benefit-driven copy that reassures first-time visitors"
    ]
  },
  featuredCollection: {
    title: "Missing Featured Collection",
    recs: [
      "Add a featured-collection / product showcase that merchandises real products inline on the home page (not just category tiles)",
      "Curate a clear set — e.g. bestsellers or new arrivals — to put visitors into shopping mode"
    ]
  },
  testimonials: {
    title: "Missing On-Page Social Proof",
    recs: [
      "Add customer reviews, ratings, or a testimonials block on this page",
      "Surface an aggregate rating or a few short quotes to build trust before the product page"
    ]
  },
  brandStory: {
    title: "Missing Brand Story Section",
    recs: [
      "Add a concise brand-story / mission section with authentic imagery",
      "Link through to a fuller About page for interested visitors"
    ]
  },
  newsletter: {
    title: "Missing Email Capture",
    recs: [
      "Add an email signup with a clear incentive (e.g. first-order discount)",
      "Place it where visitors who are not ready to buy will see it"
    ]
  },
  productRecommendations: {
    title: "Missing Product Recommendations",
    recs: [
      "Add a 'you may also like' / 'frequently bought together' row to lift average order value",
      "Surface related or complementary products near the buy box"
    ]
  },
  faq: {
    title: "Missing Product FAQ",
    recs: [
      "Add a collapsible FAQ that pre-empts common purchase objections (sizing, materials, care, delivery)",
      "Keep answers concise and specific to the product"
    ]
  }
};

/**
 * Structured list of confirmed-missing sections per page, for deterministic
 * report assembly. Each item: { pageType, type, title, recs }. Empty when the
 * crawl was thin (the analysis gates that), so the injector never fires on a
 * page we could not read.
 */
export function storefrontMissingSections(pages = []) {
  const { missing } = analyzeStorefront(pages);
  return missing.map((m) => {
    const tpl = MISSING_SECTION_FINDING[m.type] || null;
    return {
      pageType: m.pageType,
      type: m.type,
      title: tpl ? tpl.title : `Missing ${m.label}`,
      recs: tpl ? tpl.recs : [`Add ${m.label.toLowerCase()} to this page`]
    };
  });
}

export function storefrontGuardData(pages = []) {
  const rep = pages.find((p) => (p.pageType || "general") === "general");
  let heroHeadlineWeak = false;
  if (rep) {
    const h = (rep.observed?.heroHeadline || "").trim();
    heroHeadlineWeak = !h || GENERIC_HEADLINES.test(h) || h.length < 8;
  }
  return { heroHeadlineWeak };
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

export function buildAuditPrompt({ storeUrl, pages, date, additionalPageUrls = [], crawlNotes = [] }) {
  // Detected theme name (gives the LLM context)
  const themePage = pages.find((p) => p?.themeInfo?.schemaName || p?.themeInfo?.instanceName || p?.themeName);
  const detectedTheme = themePage?.themeInfo?.schemaName || themePage?.themeName || "";
  const detectedThemeLabel = themePage?.themeInfo?.instanceName || "";

  // Aggregated 4-bucket feature matrix
  const matrix = aggregateFeatureMatrix(pages);

  // Store-specific gap analysis: present sections, missing sections, weak signals.
  const storefrontAnalysis = analyzeStorefront(pages);
  const storefrontObservationsBlock = formatStorefrontObservations(storefrontAnalysis);

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
  const absentCheckpointMandatoryBlock = formatAbsentCheckpointMandatoryList(pages);

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

  const auditablePages = pages.filter((p) => !p?.loadErrorPage && !p?.challengePage);
  const pageSummaries = auditablePages.map(summarisePageForPrompt).filter(Boolean);
  const skippedErrorPages = pages
    .filter((p) => p?.loadErrorPage)
    .map((p) => ({ url: p.url, title: p.title || "", pageType: p.pageType || "general" }));
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
- CRITICAL: The "EXPECTED SECTIONS MISSING" list above applies ONLY to the home (and product) page. NEVER recommend home-page sections — value-prop / benefits / icon row, featured collection / product showcase, brand story / founder / mission, top categories — on a policy, utility, contact, order-tracking, FAQ, shipping, returns, warranty, or blog page. A refund or order-tracking page is not supposed to have a product showcase or founder story. For these pages, evaluate ONLY page-appropriate UX (clarity, layout, scannability, support/contact options, correct information); if there is no concrete page-specific issue, state the page is solid.
`
    : "";

  return `
You are a senior Shopify CRO and UX auditor. Generate a professional, practical, implementation-ready audit report. The report must be concise, client-friendly, accurate, and similar to a consultant handoff document.

Context:
- Store URL: ${storeUrl}
- Audit date: ${date}
- Platform: Shopify
${
  crawlNotes.length
    ? `- Crawl limitation: ${crawlNotes.join(" ")}`
    : ""
}
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
MANDATORY RECOMMENDATIONS — CONFIRMED ABSENT CHECKPOINTS (must appear in report):
═══════════════════════════════════════════════════════════════════════
Every item below is a CRO checkpoint from shopifyStandards.js whose linkedFeature
was confirmed ABSENT on the crawl. You MUST include each as a recommendation in the
report section shown in [brackets]. Do not skip these because they are standards gaps,
not optional suggestions.
${absentCheckpointMandatoryBlock}

═══════════════════════════════════════════════════════════════════════
STOREFRONT OBSERVATIONS (store-specific gaps from the live crawl — your PRIMARY source of findings):
═══════════════════════════════════════════════════════════════════════
${storefrontObservationsBlock}

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
9. EVERY recommendation bullet in a "Key Areas of Improvement" section MUST be anchored to a concrete observed value taken from the PER-PAGE CRAWL SUMMARY below — a real headline string, CTA label, nav item, announcement text, price, review count, or image/product count (see the "observed" object for each page). End each such bullet with a hidden evidence tag in this EXACT format: [ev: "<the exact observed string or fact you relied on>"]. If you cannot fill that tag with a real observed value, DELETE the bullet — do not invent one. The tag is internal QA metadata; write it on every recommendation bullet. Do NOT put evidence tags on Summary or Final Recommendation bullets.
10. NEVER treat accessibility-only link text (e.g. "Skip to content", "Skip to", "Back to top") as the hero headline or primary CTA. Use observed.heroHeadline or a real visible CTA label from observed.ctaLabels.
11. If SKIPPED ERROR PAGES are listed below, do NOT write recommendations for those URLs. For Collection/Product sections, use only pages present in PER-PAGE CRAWL SUMMARY. If no valid collection page was crawled, write one sentence under Collection Page that no collection page loaded successfully and omit collection recommendations.
12. Build the body of the report from the STOREFRONT OBSERVATIONS block above. Specifically: (a) every "EXPECTED SECTIONS MISSING" item MUST become its own numbered finding on the indicated page, recommending that the section be added, stated in plain merchant language with the given reason — include EVERY missing item, omit none; these are the store's verified missing sections; (b) every "WEAK UI/UX SIGNALS" item is a valid finding you should write up, quoting the exact observed value; (c) when you praise what the store does well, draw from "SECTIONS PRESENT" and the PRESENT/LIKELY-PRESENT feature matrix, citing the real section heading. Do NOT recommend adding any section that appears under SECTIONS PRESENT. If the missing/weak lists are empty for a page, keep that page's section short and say it is solid rather than inventing problems. For the evidence tag in rule #9, a missing-section reason, a weak-signal string, or a real section heading all count as valid observed evidence.
12b. Keep the description under each finding heading to ONE short sentence (about 1–1.5 lines, ≤ 25 words). State the gap plainly; put all the detail and specifics into the Recommendations bullets, not the description. Do NOT write two- or three-sentence lead-ins.
13. NEVER claim a feature or section is "missing", "absent", or "not present" unless PER-PAGE featureSignals show present: false with high confidence OR it appears under EXPECTED SECTIONS MISSING for that page type. Newsletter signup and trust / USP strips often live in the footer — check featureSignals and observed.features before claiming they are absent. If a feature IS present on that page type but poorly placed (e.g. reviews exist but not near the product title), critique PLACEMENT only — write "reviews are below the fold" or "no star rating near the title", NOT "there are no reviews".
14. Every item under "MANDATORY RECOMMENDATIONS — CONFIRMED ABSENT CHECKPOINTS" MUST appear in the report section indicated (e.g. f.back_to_top under Home Page, p.sticky_buy under Product Page). Footer-area checkpoints (f.*) belong under Home Page as site-wide UX improvements when absent.

═══════════════════════════════════════════════════════════════════════
HOW TO WRITE EACH RECOMMENDATION:
═══════════════════════════════════════════════════════════════════════
For each subsection:
  - HEADING — write it as a markdown H3 with a number, EXACTLY in the form
    "### 3. Above-the-Fold Trust Signals" (the "### " prefix is REQUIRED on every
    finding heading; do not write a bare "3. Title" without it). This lets the
    post-processor cleanly remove or renumber a finding if its recommendations
    are filtered out.
  - ONE issue paragraph (1–3 sentences) that CITES SPECIFIC OBSERVABLE EVIDENCE
    Example GOOD: "The hero headline reads 'Welcome to Hyper' which does not convey what the store sells or why a visitor should buy."
    Example BAD: "The hero section could be enhanced for stronger conversion."
  - "Recommendations:" label
  - 3–6 concrete bullets, each containing:
    * What to change (specific, observable)
    * Why (link to conversion / trust / clarity)
    * A trailing evidence tag: [ev: "<exact observed value from the crawl summary>"]
    * Quote the real observed value in the bullet itself where natural (e.g. the actual hero headline or CTA label), not a paraphrase
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
- Summary: SHORT — 3–5 sentences total in a single paragraph (no sub-paragraphs). One clause on what was covered; one citing 1–2 strengths from the PRESENT/LIKELY PRESENT matrix; one naming the 2–3 most impactful opportunity areas. Do not pad.
- Home Page: up to 6 subsections.
- Collection Page: up to 5 subsections.
- Product Page: up to 6 subsections. If crawl limitation notes say product pages were blocked, write one sentence under Product Page that product pages could not be crawled (bot protection) and do not invent product-page findings.
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

${
  skippedErrorPages.length
    ? `
═══════════════════════════════════════════════════════════════════════
SKIPPED ERROR PAGES (do not audit — page returned a theme/store error):
═══════════════════════════════════════════════════════════════════════
${skippedErrorPages.map((p) => `- ${p.pageType}: ${p.url} (${p.title || "error"})`).join("\n")}
`
    : ""
}
═══════════════════════════════════════════════════════════════════════
PER-PAGE CRAWL SUMMARY (use as supporting evidence; do not quote class names):
═══════════════════════════════════════════════════════════════════════
\`\`\`json
${JSON.stringify(pageSummaries, null, 2)}
\`\`\`
`;
}