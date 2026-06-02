import path from "node:path";
import { crawlStore, inferShopifyFromCrawledPages, probeShopifyStore } from "./crawler.js";
import { buildAuditPrompt, storefrontEvidenceStrings, storefrontGuardData, storefrontMissingSections } from "./auditPrompt.js";
import { annotatePagesWithVision } from "./visionValidation.js";
import { markdownToDocxBuffer } from "./docxExport.js";
import { generateAuditMarkdown } from "./llm.js";
import { resolveReferenceSites } from "./referenceBenchmarks.js";
import { collectReferenceScreenshots } from "./referenceCrawler.js";
import { getShopifyReference } from "./shopifyStandards.js";
import { saveBinary, saveReport, slugFromUrl, todayISO } from "./utils.js";
import {
  aggregateFeatureMatrix,
  ADD_FEATURE_PHRASES,
  FEATURE_LABELS,
  formatThemeForApi,
  pickStoreThemeFromPages,
  enforceAbsenceClaims
} from "./featureDetection.js";
import { crawlCanonicalUrlKey, urlsEquivalent } from "./utils.js";

function dedupeCrawledPages(pages = []) {
  const seen = new Set();
  return pages.filter((page) => {
    const key = crawlCanonicalUrlKey(page.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeCrawledPagesForApi(pages = [], additionalPageUrls = []) {
  const requestedExtras = Array.isArray(additionalPageUrls) ? additionalPageUrls.filter(Boolean) : [];

  return pages.map((page, index) => {
    const requestedAsAdditional = requestedExtras.some((requested) =>
      urlsEquivalent(page.url, requested)
    );
    return {
      order: index + 1,
      url: page.url,
      title: page.title || "",
      pageType: page.pageType || "general",
      requestedAsAdditional
    };
  });
}

function isTableLine(line) {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|");
}

function isDividerLine(line) {
  const t = line.replace(/\s/g, "");
  return /^\|:?-{3,}:?(\|:?-{3,}:?)+\|$/.test(t);
}

function parseTableCells(line) {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

function convertTableBlockToList(blockLines) {
  const lines = blockLines.filter((l, idx) => !(idx === 1 && isDividerLine(l)));
  if (lines.length < 2) return [];

  const headers = parseTableCells(lines[0]);
  const out = [];

  lines.slice(1).forEach((row, idx) => {
    const cells = parseTableCells(row);
    out.push(`${idx + 1}.`);
    headers.forEach((h, i) => {
      const value = cells[i] || "";
      out.push(`- ${h}: ${value}`);
    });
    out.push("");
  });

  return out;
}

function sanitizeMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!isTableLine(line)) {
      out.push(line);
      continue;
    }

    const block = [line];
    let j = i + 1;
    while (j < lines.length && isTableLine(lines[j])) {
      block.push(lines[j]);
      j += 1;
    }
    out.push(...convertTableBlockToList(block));
    i = j - 1;
  }

  const cleaned = out
    .join("\n")
    // Remove markdown bold markers for cleaner client-facing documents.
    .replace(/\*\*(.*?)\*\*/g, "$1")
    // Remove markdown horizontal rules that add visual clutter in docs.
    .replace(/^\s*---+\s*$/gm, "")
    // Trim trailing spaces often used for markdown line breaks.
    .replace(/[ \t]+$/gm, "");

  // Cleanup excessive blank lines for readability.
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeAuditLayout(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];

  const isSectionHeading = (line) => /^\d+\)\s+/.test(line.trim());
  const isMarkdownHeading = (line) => /^#{1,6}\s+/.test(line.trim());
  const isFieldLine = (line) =>
    /^(Section|Requirement Check|Status|Evidence|Recommendation|Reference|Screenshot Reference|Current Observation|Why This Matters|Recommendations)\s*:/i.test(
      line.trim()
    );

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] || "";
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push("");
      continue;
    }

    // Force consistent top-level section headings.
    if (isSectionHeading(line) && !isMarkdownHeading(line)) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push(`## ${line.trim()}`);
      out.push("");
      continue;
    }

    // Keep markdown headings with consistent spacing around.
    if (isMarkdownHeading(line)) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push(line.trim());
      out.push("");
      continue;
    }

    // Normalize requirement field lines for readability.
    if (isFieldLine(line)) {
      out.push(`- ${line.trim()}`);
      continue;
    }

    out.push(line);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * Aggregate detected signals across pages using BOTH the new theme-agnostic
 * feature matrix AND the legacy flags (for backward compatibility).
 *
 * Returns:
 *   - featureMatrix: { present, likelyPresent, uncertain, absent } from featureDetection
 *   - confirmedFeatures: Set of feature keys that are present OR likelyPresent
 *                       (these should NEVER be recommended as "add" items)
 *   - plus a few coarse-grained legacy booleans used by older code paths
 */
function aggregateDetectedSignals(pages = []) {
  const byType = (type) => pages.filter((p) => p.pageType === type);
  const homePages = byType("general");
  const collectionPages = byType("collection");
  const productPages = byType("product");

  // New theme-agnostic feature matrix (preferred source of truth).
  const featureMatrix = aggregateFeatureMatrix(pages);
  const confirmedFeatures = new Set([
    ...featureMatrix.present.map((f) => f.key),
    ...featureMatrix.likelyPresent.map((f) => f.key)
  ]);

  // Legacy flag-based detection (kept for backward compatibility).
  const hasAny = (rows, key) => rows.some((r) => Boolean(r?.flags?.[key]));

  // Each legacy boolean now considers BOTH the new feature matrix AND the legacy flags.
  const hasHomeHero =
    confirmedFeatures.has("heroSection") ||
    hasAny(homePages, "hasHeroSection") ||
    homePages.some((p) => Boolean(p?.aboveFoldModule));
  const hasHomeStickyHeader =
    confirmedFeatures.has("stickyHeader") ||
    hasAny(homePages, "hasStickyHeaderHint") ||
    hasAny(homePages, "hasStickyHeaderDetected");
  const hasHomeTrustSignals =
    confirmedFeatures.has("trustSignals") ||
    hasAny(homePages, "hasTrust") ||
    hasAny(homePages, "hasTrustStrip");
  const hasCollectionFilter =
    confirmedFeatures.has("filtering") || hasAny(collectionPages, "hasCollectionFilter");
  const hasCollectionSort =
    confirmedFeatures.has("sort") || hasAny(collectionPages, "hasCollectionSort");
  const hasProductCta = productPages.some((p) => (p?.ctaCandidates || []).length > 0);
  const hasProductMediaZoom =
    confirmedFeatures.has("productMediaZoom") || hasAny(productPages, "hasProductMediaZoom");

  return {
    featureMatrix,
    confirmedFeatures,
    hasHomeHero,
    hasHomeStickyHeader,
    hasHomeTrustSignals,
    hasCollectionFilter,
    hasCollectionSort,
    hasProductCta,
    hasProductMediaZoom
  };
}

/**
 * Build a regex that loosely matches "the merchant should add / implement X"
 * for a given feature phrase. Tolerates wording variations like
 * "add a sticky header", "consider implementing sticky header", "introduce a wishlist".
 *
 * Three matching strategies:
 *   (a) action-verb BEFORE the phrase   — e.g. "implement sticky header"
 *   (b) phrase already begins with an action verb — e.g. "add a lightbox", "make the header sticky"
 *   (c) phrase appears with "is missing / should be added" tail
 */
function buildAddFeatureRegex(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const phraseStartsWithVerb = /^(add|implement|introduce|enable|install|create|integrate|build|set\s*up|make\s+the\b|show|display)\b/i.test(phrase);

  const alternatives = [
    // (a) action verb appears before the phrase, within ~80 chars
    `\\b(add|implement|introduce|enable|install|create|integrate|build|set\\s*up|display|show|use|include|provide|incorporate|consider\\s+(?:adding|implementing|introducing|enabling|displaying|showing|using|including|providing))\\b[^\\n]{0,80}\\b${escaped}\\b`,
    // (c) phrase followed by missing/should-be-added tail
    `\\b${escaped}\\b[^\\n]{0,80}\\b(should\\s+be\\s+added|is\\s+missing|is\\s+absent|is\\s+not\\s+present|needs\\s+to\\s+be\\s+added)\\b`
  ];

  if (phraseStartsWithVerb) {
    // (b) Phrase already begins with a verb — match it bare (allow leading word boundary)
    alternatives.push(`\\b${escaped}\\b`);
  }

  return new RegExp(alternatives.join("|"), "i");
}

/**
 * Strip recommendation bullets / lines that ask the merchant to ADD a feature
 * that is already PRESENT or LIKELY PRESENT in the store. This is the core
 * mechanism for keeping the report relevant and free of false positives.
 *
 * It iterates over ADD_FEATURE_PHRASES dynamically - so as we add more feature
 * detectors in featureDetection.js, this filter automatically benefits.
 */
function stripFalsePositiveRecommendations(markdown, confirmedFeatures) {
  if (!confirmedFeatures || confirmedFeatures.size === 0) return markdown;

  // Pre-compile regexes for every confirmed feature.
  const regexes = [];
  for (const featureKey of confirmedFeatures) {
    const phrases = ADD_FEATURE_PHRASES[featureKey];
    if (!phrases || !phrases.length) continue;
    for (const phrase of phrases) {
      regexes.push({ featureKey, regex: buildAddFeatureRegex(phrase) });
    }
  }
  if (!regexes.length) return markdown;

  const lines = markdown.split(/\r?\n/);
  const kept = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const isBullet = /^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed);
    if (isBullet) {
      // Drop bullets that recommend adding a feature we already detected.
      const matched = regexes.some(({ regex }) => regex.test(trimmed));
      if (matched) continue;
    }
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Rewrite obviously-wrong assertions ("no sticky header detected", "zoom is missing")
 * when our detection contradicts them. Safer than dropping the entire paragraph.
 */
function rewriteContradictingAssertions(markdown, signalFacts) {
  let out = markdown;
  const { confirmedFeatures } = signalFacts;

  if (confirmedFeatures.has("stickyHeader")) {
    out = out
      .replace(/\bno sticky header (?:was )?detected\b/gi, "sticky header is present")
      .replace(/\b(header )?lacks sticky behavio(?:u)?r\b/gi, "$1has sticky behaviour")
      .replace(/\bsticky header is (?:not present|missing|absent)\b/gi, "sticky header is present");
  }
  if (confirmedFeatures.has("productMediaZoom")) {
    out = out
      .replace(/\bno (?:image )?zoom (?:or lightbox )?(?:functionality )?(?:was )?detected\b/gi, "product image zoom is present")
      .replace(/\b(product )?(?:image )?zoom (?:functionality )?is (?:not present|missing|absent|unavailable)\b/gi, "$1product image zoom is present")
      .replace(/\blacks (?:a |any )?(?:image |product )?zoom (?:functionality)?\b/gi, "has product image zoom");
  }
  if (confirmedFeatures.has("trustSignals")) {
    out = out
      .replace(/\bno (?:dedicated |visible )?trust(?: or usp)? (?:strip|signals?|badges?|cues?) (?:was |is )?(?:visible|present|detected)?\b/gi, "trust signals are visible")
      .replace(/\btrust signals are (?:not present|missing|absent)\b/gi, "trust signals are present");
  }
  if (confirmedFeatures.has("heroSection")) {
    out = out
      .replace(/\bno (?:clear )?hero (?:section|banner)? ?(?:was |is )?(?:detected|present|visible)\b/gi, "hero section is present")
      .replace(/\bhero (?:section|banner) is (?:missing|absent)\b/gi, "hero section is present");
  }
  if (confirmedFeatures.has("filtering") || confirmedFeatures.has("sort")) {
    out = out
      .replace(/\bfilters? (?:and|or) sort(?:ing)? (?:are|is) (?:missing|absent|not (?:present|available))\b/gi, "filters and sort are available")
      .replace(/\b(?:limited|no) filtering (?:and|or) sorting (?:options|capabilities)\b/gi, "filtering and sorting are available");
  }
  if (confirmedFeatures.has("quickView")) {
    out = out.replace(/\bquick(?:[- ]?view|[- ]?shop|[- ]?add) is (?:missing|absent|not (?:present|available))\b/gi, "quick view is present");
  }
  if (confirmedFeatures.has("wishlist")) {
    out = out.replace(/\b(?:no )?wishlist (?:functionality )?(?:is )?(?:missing|absent|not (?:present|available))\b/gi, "wishlist is present");
  }
  if (confirmedFeatures.has("searchBar")) {
    out = out.replace(/\b(?:search bar|site search) is (?:missing|absent|not (?:present|available))\b/gi, "search bar is present");
  }
  if (confirmedFeatures.has("cartDrawer")) {
    out = out.replace(/\b(?:cart drawer|slide[- ]?out cart|mini cart) is (?:missing|absent|not (?:present|available))\b/gi, "cart drawer is present");
  }
  if (confirmedFeatures.has("reviews")) {
    out = out.replace(/\b(?:customer )?reviews? (?:section|widget|system) is (?:missing|absent|not (?:present|available))\b/gi, "reviews are present");
  }
  if (confirmedFeatures.has("backInStockNotify")) {
    out = out
      .replace(/\b(?:notify[- ]me|back[- ]in[- ]stock|restock alert) (?:is |are )?(?:missing|absent|not (?:present|available))\b/gi, "back-in-stock notify capture is present")
      .replace(/\bno (?:notify[- ]me|back[- ]in[- ]stock|out[- ]of[- ]stock notification)\b/gi, "back-in-stock notify capture is present");
  }
  if (confirmedFeatures.has("stickyAddToCart")) {
    out = out
      .replace(/\b(?:sticky add to cart|sticky atc|sticky buy bar|floating add to cart) (?:is )?(?:missing|absent|not (?:present|available))\b/gi, "sticky add-to-cart is present")
      .replace(/\bno (?:sticky add to cart|sticky atc|floating add to cart|sticky buy bar)\b/gi, "sticky add-to-cart is present");
  }
  if (confirmedFeatures.has("backToTop")) {
    out = out
      .replace(/\bback[- ]to[- ]top (?:link )?(?:is )?(?:missing|absent|not (?:present|available))\b/gi, "back-to-top link is present")
      .replace(/\bno back[- ]to[- ]top\b/gi, "back-to-top link is present");
  }
  if (confirmedFeatures.has("variantSwatches")) {
    out = out.replace(/\b(?:variant |colou?r )?swatches? (?:are|is) (?:missing|absent|not (?:present|available))\b/gi, "variant swatches are present");
  }
  if (confirmedFeatures.has("breadcrumbs")) {
    out = out.replace(/\bbreadcrumbs? (?:are|is) (?:missing|absent|not (?:present|available))\b/gi, "breadcrumbs are present");
  }
  if (confirmedFeatures.has("productCardHover")) {
    out = out
      .replace(/\b(?:product[- ]?cards?|cards?)\s+lack[s]?\s+(?:any\s+)?hover[- ]?state[^.\n]*\./gi, "Product cards already have a hover state.")
      .replace(/\bno hover state[s]?\s+(?:on|for)\s+(?:product[- ]?)?cards?\b/gi, "product cards have a hover state")
      .replace(/\bhover[- ]?state[s]?\s+(?:are|is)\s+(?:missing|absent|not (?:present|implemented))\b/gi, "hover states are present");
  }
  if (confirmedFeatures.has("productCardQuickAdd") || confirmedFeatures.has("quickView")) {
    out = out
      .replace(/\bquick[- ]?(?:view|add|shop)\s+(?:functionality\s+)?(?:is|are)\s+(?:missing|absent|not (?:present|available|implemented))\b/gi, "quick-view / quick-add is present")
      .replace(/\bno\s+quick[- ]?(?:view|add|shop)\b/gi, "quick-view / quick-add is present");
  }
  if (confirmedFeatures.has("productCardBadges")) {
    out = out
      .replace(/\bno (?:sale|product)?\s*badges?\s+(?:on|for)\s+(?:product[- ]?)?cards?\b/gi, "product cards have badges")
      .replace(/\bbadges?\s+(?:are|is)\s+(?:missing|absent)\s+(?:on|from)\s+(?:product[- ]?)?cards?\b/gi, "product cards have badges");
  }
  if (confirmedFeatures.has("salePriceDisplay")) {
    out = out
      .replace(/\bno\s+(?:clear\s+)?(?:sale|discount)\s+indicators?\b/gi, "sale indicators are present")
      .replace(/\b(?:sale|discount)\s+indicators?\s+(?:are|is)\s+(?:missing|absent)\b/gi, "sale indicators are present");
  }
  if (signalFacts.hasProductCta) {
    out = out.replace(/\bno (?:visible )?CTA button\b/gi, "CTA button is visible");
  }

  return out;
}

/**
 * The model sometimes still emits vague consultant-speak even with strict
 * prompt instructions. We strip clearly-generic bullets here as a final
 * safety net so the merchant gets only specific, evidence-anchored
 * recommendations.
 *
 * A bullet is considered "generic" if it matches a forbidden phrase AND has
 * no evidence anchor (no specific noun, number, quoted text, or named
 * element). The list below is intentionally narrow to avoid stripping
 * legitimate recommendations.
 */
const GENERIC_BULLET_PATTERNS = [
  /^[-*]\s+(?:create|design|build)\s+(?:engaging|scannable|tabbed|tabbed,?\s+)?(?:product\s+specification|product information|page|sections?)\s+(?:that|with|to)?\s*(?:support|drive|improve|enhance)/i,
  /^[-*]\s+implement\s+visual\s+hierarchy\b/i,
  /^[-*]\s+implement\s+comprehensive\s+\w+\s+strategy/i,
  /^[-*]\s+(?:improve|enhance|optimize|optimise)\s+(?:overall\s+)?(?:user\s+experience|the\s+experience|engagement|presentation|interactivity|hierarchy)\s*\.?$/i,
  /^[-*]\s+(?:create|design)\s+more\s+engaging\s+\w+\s+(?:and\s+\w+\s+)?experiences?\.?$/i,
  /^[-*]\s+(?:use|provide|offer)\s+consistent[, ]+high-quality\s+\w+\s+imagery\.?$/i,
  /^[-*]\s+(?:redesign|design)\s+(?:the\s+)?filter\s+interface\s+for\s+mobile\s+and\s+desktop\s+responsiveness\.?$/i,
  /^[-*]\s+(?:add|implement)\s+hover-state\s+animations?\s+for\s+product\s+cards\.?$/i,
  /^[-*]\s+(?:implement|add)\s+(?:a\s+)?strategic\s+\w+/i,
  /^[-*]\s+(?:write|create)\s+a\s+(?:concise|clear)[,]?\s+(?:benefit[- ]driven\s+)?headline\s+targeting\s+customer\s+pain\s+points\.?$/i,
  /^[-*]\s+(?:position|place)\s+customer\s+testimonials\s+or\s+trust\s+badges\s+near\s+the\s+hero\s+section\.?$/i,
  /^[-*]\s+(?:select|use|choose)\s+lifestyle\s+imagery\s+that\s+demonstrates\s+product\s+context\s+and\s+aspirational\s+value\.?$/i,
  /^[-*]\s+(?:add|use)\s+brief\s+category\s+descriptions\.?$/i,
  /^[-*]\s+(?:use|add)\s+icons\s+to\s+(?:visualize|visualise|differentiate)\s+(?:collection|product)\s+(?:types?|features?)\.?$/i,
  /^[-*]\s+highlight\s+key\s+product\s+benefits\s+prominently\.?$/i,
  /^[-*]\s+include\s+review\s+count\s+to\s+build\s+credibility\.?$/i,
  /^[-*]\s+show\s+verified\s+customer\s+review\s+snippets\.?$/i,
  /^[-*]\s+provide\s+visual\s+feedback\s+when\s+filters\s+are\s+applied\.?$/i,
  /^[-*]\s+design\s+(?:an\s+)?engaging\s+(?:["']no\s+results["']|no-results)\s+page\.?$/i,
  /^[-*]\s+include\s+a\s+search\s+prompt\s+with\s+recommendations?\.?$/i,

  // ── General filler patterns (higher precision than the verbatim list above).
  // These target the "comprehensive/strategic + abstract noun" constructions
  // that recurred across reports with no observable anchor. Kept tight to avoid
  // stripping evidence-backed bullets (which name a real headline, price, etc.).
  /^[-*]\s+(?:develop|create|implement|build|design|add|use)\s+(?:a\s+|an\s+)?comprehensive\s+\w+(?:\s+\w+){0,2}\s*\.?$/i,
  /^[-*]\s+(?:strategically|strategic(?:ally)?)\s+(?:place|position|guide|use|organi[sz]e)\b.*$/i,
  /^[-*]\s+(?:implement|add|create|develop|use)\s+(?:a\s+|an\s+)?strategic\b.*$/i,
  /^[-*]\s+(?:improve|enhance|refine|optimi[sz]e)\s+(?:the\s+)?\w+\s+(?:placement|visibility|presentation|positioning|interactions?)(?:\s+and\s+\w+)?\.?$/i,
  /^[-*]\s+(?:implement|create|develop|design)\s+(?:a\s+|an\s+)?(?:clear,?\s+)?benefit-driven\s+\w+\s+(?:strategy|messaging|content)\.?$/i,
  /^[-*]\s+(?:reinforce|strengthen|build)\s+(?:trust|credibility|social proof)(?:\s+\w+){0,3}\.?$/i
];

function stripGenericRecommendations(markdown) {
  const lines = markdown.split(/\r?\n/);
  const kept = [];
  let droppedCount = 0;
  for (const line of lines) {
    const isGeneric = GENERIC_BULLET_PATTERNS.some((re) => re.test(line));
    if (isGeneric) {
      droppedCount += 1;
      continue;
    }
    kept.push(line);
  }
  if (droppedCount > 0) {
    console.log(`stripGenericRecommendations: dropped ${droppedCount} generic bullet(s)`);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Build a lowercase searchable corpus of everything we actually observed on the
 * crawled pages. Used to verify that an LLM-quoted piece of evidence is real.
 */
function buildEvidenceCorpus(pages = []) {
  const parts = [];
  for (const p of pages) {
    const o = p?.observed || {};
    parts.push(
      o.heroHeadline,
      o.heroSubtext,
      o.announcementText,
      o.priceText,
      o.reviewCountText,
      ...(o.ctaLabels || []),
      ...(o.navLabels || []),
      p?.heroText,
      p?.title,
      p?.metaDescription,
      p?.textSnippet
    );
    if (o.productGalleryImageCount != null) {
      parts.push(`${o.productGalleryImageCount} images`, `${o.productGalleryImageCount} photos`);
    }
    if (o.collectionCardCount != null) {
      parts.push(`${o.collectionCardCount} products`);
    }
    // Section inventory: real section headings, labels, and types are valid
    // evidence for "what the store does well" and missing-section findings.
    for (const sec of o.sections || []) {
      parts.push(sec.heading, sec.label, sec.type);
    }
  }
  // Storefront gap-analysis outputs (present headings, missing-section labels &
  // reasons, weak-signal phrasings) are deterministic facts the model is told
  // to cite — they must count as real evidence so the accuracy guard keeps
  // legitimate missing-section and weak-UX recommendations.
  try {
    parts.push(...storefrontEvidenceStrings(pages));
  } catch {
    // non-fatal: corpus just falls back to observed-value strings
  }
  return parts
    .filter(Boolean)
    .join("  \n  ")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const EV_TAG = /\s*\[ev:\s*["“]?(.*?)["”]?\]\s*$/i;

/**
 * Accuracy guard. The prompt requires every page-section recommendation bullet
 * to end with a hidden [ev: "<observed fact>"] tag. Here we:
 *   1. Drop bullets whose quoted evidence does NOT appear in the crawl corpus
 *      (i.e. the model invented a fact).
 *   2. Drop bullets that carry no evidence tag at all (unverifiable).
 *   3. Strip every [ev: ...] tag so the delivered report stays clean.
 *
 * SAFETY VALVE: if the model largely ignored the tagging instruction (low
 * compliance), we DO NOT delete anything — we only strip stray tags — so a
 * usable report is never emptied out by an over-eager filter. Enforcement is
 * scoped to "Key Areas of Improvement" sections only; Summary and Final
 * Recommendation roll-ups are left untouched (their tags are just stripped).
 */
function enforceEvidenceOnBullets(markdown, pages = []) {
  const corpus = buildEvidenceCorpus(pages);
  const lines = markdown.split(/\r?\n/);

  const isEnforcedHeading = (line) =>
    /^#{1,2}\s+/.test(line) && /key areas of improvement/i.test(line);
  const isSectionHeading = (line) => /^#{1,2}\s+/.test(line);
  const isRecoBullet = (line, inZone) =>
    inZone &&
    /^\s*[-*]\s+/.test(line) &&
    !/^\s*[-*]\s*recommendations:/i.test(line);

  // Pass 1 — measure how often the model actually emitted tags.
  let inZone = false;
  let tagged = 0;
  let total = 0;
  for (const line of lines) {
    if (isSectionHeading(line)) {
      inZone = isEnforcedHeading(line);
      continue;
    }
    if (isRecoBullet(line, inZone)) {
      total += 1;
      if (EV_TAG.test(line)) tagged += 1;
    }
  }
  const compliance = total ? tagged / total : 0;
  const enforce = compliance >= 0.4;

  // Pass 2 — filter (or, if low compliance, only clean tags).
  inZone = false;
  let dropped = 0;
  const kept = [];
  for (const line of lines) {
    if (isSectionHeading(line)) {
      inZone = isEnforcedHeading(line);
      kept.push(line);
      continue;
    }
    if (!isRecoBullet(line, inZone)) {
      kept.push(line.replace(EV_TAG, "")); // strip stray tags everywhere
      continue;
    }

    const match = line.match(EV_TAG);
    const clean = line.replace(EV_TAG, "").replace(/\s+$/, "");

    if (!enforce) {
      kept.push(clean);
      continue;
    }
    if (!match) {
      dropped += 1; // untagged → unverifiable → drop
      continue;
    }
    const quoted = (match[1] || "").toLowerCase().replace(/\s+/g, " ").trim();
    // Only verify substantive quotes; very short tags just need to exist.
    if (quoted.length >= 8 && !corpus.includes(quoted)) {
      dropped += 1; // quotes something never observed → invented → drop
      continue;
    }
    kept.push(clean);
  }

  if (dropped > 0) {
    console.log(
      `enforceEvidenceOnBullets: dropped ${dropped} unverifiable bullet(s) (tag compliance ${(compliance * 100).toFixed(0)}%)`
    );
  } else if (!enforce && total > 0) {
    console.log(
      `enforceEvidenceOnBullets: low tag compliance (${(compliance * 100).toFixed(0)}%) — skipped evidence filtering, stripped tags only`
    );
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * After evidence filtering, a subsection may have lost every recommendation
 * bullet, leaving a dangling "Recommendations:" label with nothing under it.
 * Strip those empty labels so the report never looks broken. A subsection that
 * keeps only its issue sentence is fine — that matches the "one sentence is
 * enough when there's nothing concrete to recommend" rule.
 */
function removeEmptyRecommendationBlocks(markdown) {
  if (!markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  const isRecLabel = (l) => /^\s*[-*]?\s*recommendations:\s*$/i.test(l);
  const isHeading = (l) => /^#{1,6}\s+/.test(l);
  const isBullet = (l) => /^\s*[-*]\s+\S/.test(l) && !isRecLabel(l);

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isRecLabel(lines[i])) {
      let hasBullet = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (isHeading(lines[j]) || isRecLabel(lines[j])) break;
        if (isBullet(lines[j])) {
          hasBullet = true;
          break;
        }
      }
      if (!hasBullet) continue; // drop the dangling label
    }
    out.push(lines[i]);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Main entry point used by runAudit. Combines:
 *   (1) Rewriting contradicting assertions to match reality.
 *   (2) Stripping recommendation bullets that ask the merchant to add features
 *       that are already present (the false-positive killer).
 *   (3) Stripping vague, evidence-less bullets that slipped past the prompt.
 *   (4) Verifying every surviving recommendation is anchored to a real observed
 *       value (the invented-finding killer).
 */
/**
 * Remove "### N." improvement subsections that ended up with NO recommendation
 * bullets and do not state the area is solid. Prevents orphan headings (an
 * issue paragraph with nothing actionable under it) from shipping in the report.
 */
function removeEmptyImprovementSubsections(markdown) {
  if (!markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let inZone = false;
  const isBullet = (l) =>
    /^\s*[-*]\s+\S/.test(l) && !/^\s*[-*]?\s*recommendations:\s*$/i.test(l);
  const saysSolid = (l) =>
    /(is|are|looks?)\s+(solid|strong|well[- ]implemented|effective)|no (major |meaningful )?(issues|problems|fixes)|nothing (meaningfully|critical)|already (in place|present|well)/i.test(l);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inZone = /key areas of improvement/i.test(line);
      out.push(line);
      continue;
    }
    if (inZone && /^###\s+/.test(line)) {
      let j = i + 1;
      const block = [];
      while (j < lines.length && !/^###\s+/.test(lines[j]) && !/^##\s+/.test(lines[j])) {
        block.push(lines[j]);
        j += 1;
      }
      if (!block.some(isBullet) && !block.some(saysSolid)) {
        i = j - 1; // skip heading + block entirely
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * When the crawl did NOT observe a weak hero headline, drop any improvement
 * subsection whose premise is that the headline is weak/missing/not-compelling.
 * The store has a real headline the crawl could not fault, so the claim is
 * unsupported and must not ship. Gated on storefrontGuardData(pages).
 */
function stripUnsupportedHeadlineClaims(markdown, { heroHeadlineWeak } = {}) {
  if (!markdown || heroHeadlineWeak) return markdown;
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let inZone = false;
  const headlineWeaknessClaim = (l) =>
    /(hero|home\s*page)[^.]*\b(lacks?|missing|no|weak|generic|not)\b[^.]*\bhead(line|er)\b/i.test(l) ||
    /\bhead(line|er)\b[^.]*\b(lacks?|isn'?t|is not|fails? to)\b[^.]*(compelling|benefit[- ]driven|clear|value)/i.test(l);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inZone = /key areas of improvement/i.test(line);
      out.push(line);
      continue;
    }
    if (inZone && /^###\s+/.test(line)) {
      let j = i + 1;
      const block = [];
      while (j < lines.length && !/^###\s+/.test(lines[j]) && !/^##\s+/.test(lines[j])) {
        block.push(lines[j]);
        j += 1;
      }
      if (block.some(headlineWeaknessClaim)) {
        i = j - 1; // drop the whole unsupported subsection
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Extra generic-cliché bullets observed slipping past GENERIC_BULLET_PATTERNS.
 * Deliberately narrow so genuinely specific bullets (e.g. a "Who this is for"
 * section recommendation) are preserved.
 */
const EXTRA_GENERIC_PATTERNS = [
  /^[-*]\s+(?:implement|add)\s+hover-?state\s+image\s+swap/i,
  /^[-*]\s+(?:develop|create|write)\s+(?:a\s+)?more\s+(?:emotional|engaging|compelling|emotionally\s+resonant)[, ]+/i,
  /^[-*]\s+enhance\s+product\s+card\s+interactivity\s+with\s+hover\s+states?\s+and\s+quick-?view/i,
  /^[-*]\s+(?:redesign|design)\s+(?:the\s+)?filter\s+layout\b/i
];
function stripExtraGenericBullets(markdown) {
  return markdown
    .split(/\r?\n/)
    .filter((l) => !EXTRA_GENERIC_PATTERNS.some((re) => re.test(l)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Never leave a "## X - Key Areas of Improvement" page section with no content
 * after pruning — insert a neutral one-liner instead of a blank section.
 */
function ensureNonEmptyImprovementSections(markdown) {
  if (!markdown) return markdown;
  const PLACEHOLDER = /^\s*No critical fixes identified from captured evidence\.?\s*$/i;
  const isFinding = (l) =>
    /^###\s+\S/.test(l) ||
    /^\s*[-*]\s+\S/.test(l) ||
    /^\s*\d+\.\s+\S/.test(l) ||
    (/[a-z]/i.test(l) && !PLACEHOLDER.test(l)); // any real prose counts (e.g. "could not be crawled"), but NOT the placeholder

  const lines = markdown.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^##\s+.*key areas of improvement/i.test(line)) {
      if (PLACEHOLDER.test(line)) continue; // never emit the placeholder line
      out.push(line);
      continue;
    }
    // A "Key Areas of Improvement" heading — keep it only if a real finding (or
    // an informative note) follows before the next ##. Otherwise drop the whole
    // empty section so no "No critical fixes identified…" message is shown.
    let j = i + 1;
    let hasContent = false;
    while (j < lines.length && !/^##\s+/.test(lines[j])) {
      if (isFinding(lines[j])) { hasContent = true; break; }
      j += 1;
    }
    if (hasContent) {
      out.push(line); // keep heading; body is emitted by later iterations
    } else {
      // skip the heading and its empty/placeholder body entirely
      let k = i + 1;
      while (k < lines.length && !/^##\s+/.test(lines[k])) k += 1;
      i = k - 1;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Renumber "### N." subsections within each page zone after removals so a
 * dropped subsection never leaves a gap (1, 3 → 1, 2).
 */
function renumberImprovementSubsections(markdown) {
  if (!markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  let inZone = false;
  let counter = 0;
  return lines
    .map((line) => {
      if (/^##\s+/.test(line)) {
        inZone = /key areas of improvement/i.test(line);
        counter = 0;
        return line;
      }
      if (inZone) {
        const m = line.match(/^(###\s+)\d+\.\s+(.*)$/);
        if (m) {
          counter += 1;
          return `${m[1]}${counter}. ${m[2]}`;
        }
      }
      return line;
    })
    .join("\n");
}

/**
 * Renumber the ordered list under "## Final Recommendation" after any roll-up
 * bullets were stripped, so it never skips a number.
 */
function renumberFinalRecommendation(markdown) {
  if (!markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  let inFinal = false;
  let n = 0;
  return lines
    .map((line) => {
      if (/^##\s+/.test(line)) {
        inFinal = /final recommendation/i.test(line);
        n = 0;
        return line;
      }
      if (inFinal) {
        const m = line.match(/^\s*\d+\.\s+(.*)$/);
        if (m) {
          n += 1;
          return `${n}. ${m[1]}`;
        }
      }
      return line;
    })
    .join("\n");
}

// Accessibility / locale chrome that must never be presented as a marketing
// CTA. If the model pulled "Skip to content" or a currency selector from the
// page-text snippet (despite the crawler no longer listing it as a CTA), drop
// the offending line. All-junk subsections then fall away via the downstream
// removeEmptyImprovementSubsections pass.
const JUNK_CTA_MENTION =
  /skip to (?:content|main|navigation)|\((?:USD|EUR|GBP|CAD|AUD|INR|JPY|CNY|AED|SGD|NZD|CHF|SEK|ZAR)[^)]*\)/i;

/** Do not strip lines that legitimately recommend adding a missing UX element. */
const LEGITIMATE_UX_RECOMMENDATION =
  /\b(add|implement|include|introduce|recommend|should have|needs? a?|missing|lacks?|does not have|no visible)\b/i;

function stripJunkCtaFindings(markdown) {
  if (!markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  const isHeading = (l) => /^#{1,3}\s+/.test(l) || /^\s*\d+\.\s+\S/.test(l);
  let inZone = false;
  let dropped = 0;
  const kept = [];
  for (const line of lines) {
    if (/^#{1,2}\s+/.test(line)) {
      inZone = /key areas of improvement/i.test(line);
      kept.push(line);
      continue;
    }
    if (inZone && !isHeading(line) && JUNK_CTA_MENTION.test(line) && !LEGITIMATE_UX_RECOMMENDATION.test(line)) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  if (dropped > 0) {
    console.log(`stripJunkCtaFindings: dropped ${dropped} a11y/locale-chrome line(s)`);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Strip "limited gallery / expand to N images" recommendations when the store
 * already has a rich product gallery. Gallery size is about IMAGE COUNT, not
 * zoom, so it is guarded by the crawler's observed productGalleryImageCount
 * rather than by a feature detector. If any product page shows >= 5 images, an
 * "expand the gallery" recommendation is a false positive.
 */
function stripGalleryExpansionWhenRich(markdown, pages = []) {
  const maxImages = Math.max(
    0,
    ...pages.map((p) => Number(p?.observed?.productGalleryImageCount) || 0)
  );
  if (maxImages < 5) return markdown; // genuinely few images → leave the rec alone

  const GALLERY_EXPANSION = /\b(limited (?:product )?gallery|expand (?:the |your |product )?(?:image )?gallery|expand product image gallery|(?:add|include) more (?:product )?images|only (?:a few|shows? (?:only )?\d+) images|5[-–\s]?6 (?:high[- ]quality )?images|few (?:product )?images|gallery shows only)\b/i;

  const lines = markdown.split(/\r?\n/);
  let dropped = 0;
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    const isBullet = /^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed);
    if (isBullet && GALLERY_EXPANSION.test(trimmed)) {
      dropped += 1;
      return false;
    }
    return true;
  });
  if (dropped > 0) {
    console.log(`stripGalleryExpansionWhenRich: dropped ${dropped} gallery-expansion bullet(s); store has ${maxImages} product images`);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Suppress "add a hero subheadline / add a primary CTA" recommendations when the
 * crawler already observed a hero subtext and/or CTA labels. "Headline clarity"
 * is a subjective LLM finding with no detector gating it, so the model often
 * recommends adding a CTA/subheadline that already exist (e.g. Serman Brands:
 * hero has "THE ONLY WALLET YOU NEED" + "Shop Now"). The subjective "make the
 * headline itself more descriptive" point is left intact — only the
 * add-a-CTA / add-a-subheadline bullets are dropped.
 */
function stripHeroChromeWhenPresent(markdown, pages = []) {
  const home = pages.find((p) => (p.pageType || "general") === "general") || pages[0];
  const o = home?.observed || {};
  const hasCta = Array.isArray(o.ctaLabels) && o.ctaLabels.some((c) => (c || "").trim().length);
  const hasSubtext = (o.heroSubtext || "").trim().length >= 8;
  if (!hasCta && !hasSubtext) return markdown;

  const CTA_REC = /\b(add|include|introduce|incorporate|implement|create|place)\b[^\n]{0,60}\b(call[- ]to[- ]action|cta|action[- ]oriented (?:button|cta))\b/i;
  const SUBHEAD_REC = /\b(add|include|introduce|incorporate|implement|create)\b[^\n]{0,40}\bsub[- ]?(?:headline|head|title|heading)\b/i;

  const lines = markdown.split(/\r?\n/);
  let dropped = 0;
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!(/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t))) return true;
    if (hasCta && CTA_REC.test(t)) { dropped += 1; return false; }
    if (hasSubtext && SUBHEAD_REC.test(t)) { dropped += 1; return false; }
    return true;
  });
  if (dropped > 0) {
    console.log(`stripHeroChromeWhenPresent: dropped ${dropped} add-CTA/subheadline bullet(s); hero already has ${hasCta ? "CTA " : ""}${hasSubtext ? "subtext" : ""}`);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Suppress product-card recommendations for details the cards already show.
 * The model often says "display price / color variants / ratings on cards" when
 * those are already present. Gated on observed evidence: price text seen,
 * variant swatches detected, and review-count text seen on a collection/home
 * page. Only the specific already-satisfied bullet is dropped.
 */
function stripCardDetailWhenPresent(markdown, pages = [], signalFacts = {}) {
  const relevant = pages.filter((p) => ["general", "collection"].includes(p.pageType || "general"));
  const hasPrice = relevant.some((p) => (p?.observed?.priceText || "").trim().length);
  const hasReviews = relevant.some((p) => (p?.observed?.reviewCountText || "").trim().length);
  const confirmed = signalFacts.confirmedFeatures instanceof Set
    ? signalFacts.confirmedFeatures
    : new Set(signalFacts.confirmedFeatures || []);
  const hasSwatches = confirmed.has("variantSwatches");

  const checks = [];
  if (hasPrice) checks.push(/\b(prominently )?(display|show|add)\b[^\n]{0,40}\bpric(e|es|ing)\b[^\n]{0,30}\b(on|across)?\s*(product )?cards?\b/i);
  if (hasPrice) checks.push(/\bdisplay price and (available )?(color )?variants?\b/i);
  if (hasPrice) checks.push(/\b(display|show|add|include)\b[^\n]{0,40}\b(clear )?pric(e|es|ing)\b[^\n]{0,30}\bdiscount\b/i);
  if (hasPrice) checks.push(/\b(display|show|add|highlight|include)\b[^\n]{0,40}\bdiscount\s*(percentage|percent|%|badge)/i);
  if (hasSwatches) checks.push(/\b(display|show|add|implement)\b[^\n]{0,40}\b(colou?r|variant)\s*(swatch(es)?|options?|variants?)\b/i);
  if (hasReviews) checks.push(/\b(show|display|add)\b[^\n]{0,40}\b(star )?ratings?\b[^\n]{0,30}\b(on|across)?\s*(product )?cards?\b/i);
  if (!checks.length) return markdown;

  const lines = markdown.split(/\r?\n/);
  let dropped = 0;
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!(/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t))) return true;
    if (checks.some((re) => re.test(t))) { dropped += 1; return false; }
    return true;
  });
  if (dropped > 0) {
    console.log(`stripCardDetailWhenPresent: dropped ${dropped} already-present card-detail bullet(s)`);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Normalize finding headings inside "Key Areas of Improvement" zones to the
 * "### N. Title" form the subsection-level cleaners expect. The prompt now asks
 * for "### " explicitly, but if the model emits a bare numbered heading
 * ("3. Above-the-Fold Trust Signals") the downstream guards
 * (removeEmptyImprovementSubsections, renumberImprovementSubsections,
 * stripUnsupportedHeadlineClaims, ensureNonEmptyImprovementSections) would
 * silently no-op — leaving a dangling heading after its bullets are stripped,
 * and never running the hero-headline guard. This promotes such headings so the
 * cleaners always fire. It is conservative: only short, title-like, period-free
 * numbered lines inside an improvement zone are promoted; recommendation bullets
 * (dashes, full sentences ending in evidence tags) and the numbered Final
 * Recommendation list (a different ## zone) are left untouched.
 */
function normalizeFindingHeadings(markdown) {
  if (!markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  let inZone = false;
  const out = lines.map((line) => {
    if (/^##\s+/.test(line)) {
      inZone = /key areas of improvement/i.test(line);
      return line;
    }
    if (!inZone) return line;
    if (/^###\s+/.test(line)) return line; // already a heading
    // Bare numbered, title-like line: "3. Above-the-Fold Trust Signals"
    const m = line.match(/^\s*(\d+)\.\s+(\S.*\S)\s*$/);
    if (m) {
      const title = m[2];
      const looksLikeTitle =
        title.length <= 70 &&
        !/[.:;]$/.test(title) &&        // not a sentence/clause ending
        !/\[ev:/i.test(title) &&        // not an evidence-tagged rec bullet
        !/^(implement|add|use|create|display|show|move|place|include|consider|ensure|make|position|highlight|break|craft|develop|enhance|optimi[sz]e|refine|restructure)\b/i.test(title); // not an imperative rec
      if (looksLikeTitle) {
        return `### ${m[1]}. ${title}`;
      }
    }
    return line;
  });
  return out.join("\n");
}

function enforceSignalConsistency(markdown, signalFacts, pages = []) {
  let out = markdown;
  out = normalizeFindingHeadings(out);
  out = rewriteContradictingAssertions(out, signalFacts);
  out = stripFalsePositiveRecommendations(out, signalFacts.confirmedFeatures);
  out = stripGalleryExpansionWhenRich(out, pages);
  out = stripHeroChromeWhenPresent(out, pages);
  out = stripCardDetailWhenPresent(out, pages, signalFacts);
  out = stripJunkCtaFindings(out);
  out = stripGenericRecommendations(out);
  out = stripExtraGenericBullets(out);
  out = enforceEvidenceOnBullets(out, pages);
  out = enforceAbsenceClaims(out, pages);
  out = removeEmptyRecommendationBlocks(out);
  out = stripUnsupportedHeadlineClaims(out, storefrontGuardData(pages));
  out = removeEmptyImprovementSubsections(out);
  out = ensureNonEmptyImprovementSections(out);
  out = ensureMissingSectionFindings(out, pages);
  out = shortenFindingDescriptions(out);
  out = renumberImprovementSubsections(out);
  out = renumberFinalRecommendation(out);
  return out;
}

/**
 * Keep each finding's description to ~1–1.5 lines (one short sentence). The
 * detail belongs in the Recommendations bullets, not a long lead-in. Within
 * "Key Areas of Improvement" sections, the lines between a "### N. Title" and
 * the first bullet ("* Recommendations:" etc.) are the description; we collapse
 * them to the first sentence and hard-cap the length at a word boundary.
 */
function shortenFindingDescriptions(markdown) {
  if (!markdown) return markdown;
  const MAX = 160; // ~1.5 lines
  const firstSentence = (text) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return t;
    const m = t.match(/^(.*?[.!?])(?:\s|$)/);
    let s = m ? m[1] : t;
    if (s.length > MAX) {
      const cut = s.slice(0, MAX);
      const sp = cut.lastIndexOf(" ");
      s = (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, "") + "…";
    }
    return s;
  };

  const lines = markdown.split(/\r?\n/);
  const out = [];
  let inZone = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inZone = /key areas of improvement/i.test(line);
      out.push(line);
      i += 1;
      continue;
    }
    const isFindingTitle = inZone && /^###\s+\d+\.\s+/.test(line);
    if (!isFindingTitle) {
      out.push(line);
      i += 1;
      continue;
    }
    // Emit the title, then gather description lines until a bullet / heading.
    out.push(line);
    i += 1;
    const desc = [];
    while (
      i < lines.length &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^#{2,3}\s+/.test(lines[i])
    ) {
      if (lines[i].trim()) desc.push(lines[i].trim());
      i += 1;
    }
    if (desc.length) {
      out.push(firstSentence(desc.join(" ")));
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Deterministic guarantee that every CONFIRMED-missing standard section appears
 * in the report. The model is told to cover them all, but being an LLM it
 * sometimes drops one or two; this injects any it omitted so the present/absent
 * facts — not the model's mood — decide the findings. We only ADD findings the
 * model didn't already write (so its own phrasing is preserved), and only for
 * sections the analysis confirmed missing (which is gated to non-thin crawls, so
 * this never fires on a page we couldn't read).
 */
export function ensureMissingSectionFindings(markdown, pages = []) {
  if (!markdown) return markdown;
  let missing;
  try {
    missing = storefrontMissingSections(pages);
  } catch {
    return markdown;
  }
  if (!missing || !missing.length) return markdown;

  const PAGE_HEADING = {
    home: /^##\s+Home Page - Key Areas of Improvement/i,
    product: /^##\s+Product Page - Key Areas of Improvement/i,
    collection: /^##\s+Collection Page - Key Areas of Improvement/i
  };
  // Keywords that mean the model ALREADY addressed a given section type, so we
  // must not inject a duplicate.
  const ADDRESSED = {
    hero: /\bhero\b|headline|above[- ]the[- ]fold|value prop/i,
    benefits: /benefit|trust (strip|badge|signal|icon)|value prop|icon row|\busp\b|reassur/i,
    featuredCollection: /featured collection|product showcase|featured product|shopping mode|merchandis|bestsellers?\s+(grid|section|row)/i,
    testimonials: /social proof|testimonial|customer review|\breviews?\b|\bratings?\b/i,
    brandStory: /brand story|our story|mission|founder|brand narrative/i,
    newsletter: /newsletter|email (capture|signup|sign-up|sign up)|subscribe/i,
    productRecommendations: /recommend|you may also like|frequently bought|cross-sell|related product/i,
    faq: /\bfaq\b|frequently asked|product question/i
  };

  const lines = markdown.split(/\r?\n/);
  // Build page-section bounds: heading line index -> end (next ## or EOF).
  const sectionRanges = {};
  for (const [pageType, re] of Object.entries(PAGE_HEADING)) {
    const start = lines.findIndex((l) => re.test(l));
    if (start === -1) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { end = i; break; }
    }
    sectionRanges[pageType] = { start, end };
  }

  // Group missing items by page and drop those already addressed in that block.
  const toInject = {}; // pageType -> [ {title, recs} ]
  for (const m of missing) {
    const range = sectionRanges[m.pageType];
    if (!range) continue; // page section not in report — skip rather than fabricate
    const blockText = lines.slice(range.start, range.end).join("\n");
    const addressedRe = ADDRESSED[m.type];
    if (addressedRe && addressedRe.test(blockText)) continue; // model already covered it
    (toInject[m.pageType] = toInject[m.pageType] || []).push(m);
  }

  const pagesToInject = Object.keys(toInject);
  if (!pagesToInject.length) return markdown;

  // Insert from the bottom-most section upward so earlier indices stay valid.
  const order = ["collection", "product", "home"].filter((p) => toInject[p]);
  let result = lines.slice();
  for (const pageType of order) {
    const range = sectionRanges[pageType];
    const block = [];
    for (const m of toInject[pageType]) {
      block.push(`### 0. ${m.title}`);
      block.push(`Not present on this page per the crawl; adding it aligns with Shopify best practice.`);
      block.push(`* Recommendations:`);
      for (const r of m.recs) block.push(`* ${r}`);
      block.push("");
    }
    // Insert at end of the section (before the next ## heading).
    result = [...result.slice(0, range.end), ...block, ...result.slice(range.end)];
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}

function scoreFromStatus(status) {
  if (/^meets$/i.test(status)) return 100;
  if (/^partially meets$/i.test(status)) return 70;
  if (/^needs improvement$/i.test(status)) return 40;
  return 55;
}

function buildSectionScore(lines, sectionTitleMatch, nextSectionStartRegex, weights) {
  const start = lines.findIndex((l) => sectionTitleMatch.test(l));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (nextSectionStartRegex.test(lines[i])) {
      end = i;
      break;
    }
  }

  const statuses = [];
  for (let i = start + 1; i < end; i += 1) {
    const m = lines[i].match(/status:\s*(Meets|Partially Meets|Needs Improvement)/i);
    if (m?.[1]) statuses.push(m[1]);
  }
  if (!statuses.length) return null;

  const effectiveWeights =
    Array.isArray(weights) && weights.length === statuses.length
      ? weights
      : Array.from({ length: statuses.length }, () => 100 / statuses.length);

  const weightedSum = statuses.reduce(
    (sum, status, idx) => sum + scoreFromStatus(status) * (effectiveWeights[idx] / 100),
    0
  );
  const rounded = Math.round(weightedSum);

  const counts = {
    meets: statuses.filter((s) => /^meets$/i.test(s)).length,
    partial: statuses.filter((s) => /^partially meets$/i.test(s)).length,
    needs: statuses.filter((s) => /^needs improvement$/i.test(s)).length
  };

  return { score: rounded, counts };
}

function injectQualityScorecard(markdown) {
  // Disabled for Error + Recommendation-only output format.
  return markdown;
}

function removeSeoAndSpeedContent(markdown) {
  if (!markdown) return markdown;
  const blockedLine = /(seo|search engine|meta description|structured data|rich snippets?|page[-\s]?speed|site speed|speed optimization|performance optimization|performance and loading|optimi[sz]e (script|css|image) loading|lighthouse score|core web vitals?)/i;
  const lines = markdown.split(/\r?\n/);
  const cleaned = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (blockedLine.test(trimmed)) {
      // Drop SEO/speed recommendation lines and surrounding subsection heading if now empty.
      continue;
    }

    cleaned.push(line);
  }

  return cleaned
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeThemeUpgradeContent(markdown) {
  if (!markdown) return markdown;
  return markdown
    .replace(
      /(?:^|\n)[^\n]*recommend[^\n]*upgrad(?:e|ing)[^\n]*latest[^\n]*theme[^\n]*\n?/gi,
      "\n"
    )
    .replace(
      /(?:^|\n)[^\n]*theme version[^\n]*(compatibilit|feature|release|update)[^\n]*\n?/gi,
      "\n"
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeEnsurePhrasing(markdown) {
  if (!markdown) return markdown;
  // "Ensure" governs a clause ("Ensure X provides Y"). Swapping it for a bare
  // verb like "Use" breaks grammar ("Use X provides Y"). "Make sure" governs a
  // clause identically, so it is a safe, meaning-preserving replacement.
  return markdown
    .replace(/\bEnsure that\b/g, "Make sure")
    .replace(/\bensure that\b/g, "make sure")
    .replace(/\bEnsure\b/g, "Make sure")
    .replace(/\bensure\b/g, "make sure");
}

function hasAllRequiredSections(markdown, includeOtherPages = true) {
  void includeOtherPages;
  const required = [
    /Shopify Store Audit\s*-\s*"?[^"\n]+"?/i,
    /Website:\s*https?:\/\//i,
    /Summary/i,
    /Home Page - Key Areas of Improvement/i,
    /Collection Page/i,
    /Product Page - Key Areas of Improvement/i,
    /Final Recommendation/i
  ];
  // Other Pages is no longer required here: the post-processing rebuild
  // deterministically adds it (only for pages with findings) or omits it when
  // every requested page is clean, so it must not be forced via regeneration.
  return required.every((r) => r.test(markdown));
}

function normalizeInvalidStatusValues(markdown) {
  // Status lines are not used in the concise Error/Recommendation format.
  return { markdown, invalidCount: 0 };
}

function hasSectionEightHeading(markdown, includeOtherPages = true) {
  void markdown;
  void includeOtherPages;
  // The Other Pages section is managed deterministically in post-processing
  // (added only when a requested page has a finding, omitted when all are
  // clean), so its presence is not a reliability requirement on the model.
  return true;
}

function screenshotReuseRisk(markdown) {
  void markdown;
  return false;
}

function countFinalRecommendationBullets(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*Final Recommendation/i.test(l));
  if (start === -1) return 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .filter((l) => /^\s*[-*]\s+/.test(l.trim()))
    .length;
}

function countInvalidStatusValues(markdown) {
  void markdown;
  return 0;
}

function contradictionRiskDetected(markdown) {
  void markdown;
  return false;
}

function buildReliabilityChecks(markdown, pages, includeOtherPages = true) {
  const fieldCoverage = scoreIssueFieldCoverage(markdown);
  const productPagesDetected = pages.filter((p) => p.pageType === "product").length;
  const finalRecommendationBullets = countFinalRecommendationBullets(markdown);
  const invalidStatusValues = countInvalidStatusValues(markdown);

  const checks = {
    requiredSectionsPresent: hasAllRequiredSections(markdown, includeOtherPages),
    sectionEightPresent: hasSectionEightHeading(markdown, includeOtherPages),
    placeholderDetected: looksLikePlaceholder(markdown),
    issueFieldCoverageScore: fieldCoverage.score,
    issueSubsectionsDetected: fieldCoverage.requiredSubsectionCount,
    invalidStatusValuesDetected: invalidStatusValues,
    productPagesDetected,
    productDataCoverageAdequate: productPagesDetected > 0,
    screenshotReuseRisk: screenshotReuseRisk(markdown),
    finalRecommendationBullets,
    finalRecommendationBulletCountValid:
      finalRecommendationBullets >= 5 && finalRecommendationBullets <= 7,
    contradictionRiskDetected: contradictionRiskDetected(markdown)
  };

  const failures = [];
  if (!checks.requiredSectionsPresent) failures.push("Missing required report sections.");
  if (!checks.sectionEightPresent) failures.push("Section 8 is missing.");
  if (checks.placeholderDetected) failures.push("Placeholder content detected.");
  if (checks.invalidStatusValuesDetected > 0) failures.push("Invalid status values detected.");
  if (checks.issueFieldCoverageScore < 75) failures.push("Improvement field coverage below threshold.");
  if (!checks.productDataCoverageAdequate) failures.push("No product page data detected.");
  if (!checks.finalRecommendationBulletCountValid) {
    failures.push("Final recommendation must contain 5-7 bullets.");
  }
  if (checks.screenshotReuseRisk) failures.push("Screenshot references are over-reused.");
  if (checks.contradictionRiskDetected) failures.push("Status/evidence contradiction risk detected."); 

  const hardPass = failures.length === 0;
  const reliabilityScore = Math.max(0, 100 - failures.length * 12);
  return { ...checks, failures, hardPass, reliabilityScore };
}

function looksLikePlaceholder(markdown) {
  return (
    /\[Remaining sections/i.test(markdown) ||
    /would follow similar/i.test(markdown) ||
    /\[Would you like me to continue/i.test(markdown)
  );
}

function countMarkdownHeadings(markdown, pattern) {
  return (markdown.match(pattern) || []).length;
}

function scoreIssueFieldCoverage(markdown) {  
  const recommendationsLabels = (markdown.match(/^\s*Recommendations\s*:?\s*$/gim) || []).length;
  const bulletCount = (markdown.match(/^\s*[-*]\s+/gim) || []).length;
  if (!recommendationsLabels || bulletCount < 8) return { score: 0, requiredSubsectionCount: 0 };
  return { score: 100, requiredSubsectionCount: recommendationsLabels };
}

function ensureImprovementFieldLine(block, pattern, fallbackLine) {
  return pattern.test(block) ? block : `${block.trimEnd()}\n- ${fallbackLine}\n`;
}

function enforceImprovementFields(markdown) {
  // Keep model output concise; do not auto-inject legacy verbose fields.
  return markdown;
}

function shouldIncludeOtherPagesSection(pages = [], additionalPageUrls = []) {
  void pages;
  return Array.isArray(additionalPageUrls) && additionalPageUrls.length > 0;
}

function removeOtherPagesSectionIfNotApplicable(markdown, includeOtherPages) {
  if (includeOtherPages) return markdown;

  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    /^(?:##\s*)?(?:\*\*)?\s*Other Pages(?:\s*-\s*Key Areas of Improvement)?\s*(?:\*\*)?\s*$/i.test(
      String(l || "").trim()
    )
  );
  if (start === -1) return markdown;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (
      /^##\s+/.test(lines[i]) ||
      /^(?:\*\*)?\s*Final Recommendation\s*(?:\*\*)?\s*$/i.test(String(lines[i] || "").trim())
    ) {
      end = i;
      break;
    }
  }

  const trimmed = [...lines.slice(0, start), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  console.log("[audit] Removed Other Pages section (no additional URLs requested).");
  return trimmed;
}

function enforceOtherPageUrlCoverage(markdown, additionalPageUrls = [], includeOtherPages = true) {
  if (!includeOtherPages) return markdown;
  if (!Array.isArray(additionalPageUrls) || additionalPageUrls.length === 0) return markdown;

  const lines = markdown.split(/\r?\n/);
  const headingIdx = lines.findIndex((l) =>
    /^(?:##\s*)?(?:\*\*)?\s*Other Pages(?:\s*-\s*Key Areas of Improvement)?\s*(?:\*\*)?\s*$/i.test(
      String(l || "").trim()
    )
  );
  if (headingIdx === -1) return markdown;

  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const otherSection = lines.slice(headingIdx, sectionEnd).join("\n");
  const missing = additionalPageUrls.filter(
    (u) => u && !new RegExp(String(u).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(otherSection)
  );
  if (!missing.length) return markdown;
  missing.forEach((url) => {
    console.log(`[audit] Other page omitted (no fix-required issue detected): ${url}`);
  });
  return markdown;
}

function normalizeOtherPagesNumbering(markdown) {
  if (!markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    /^(?:##\s*)?(?:\*\*)?\s*Other Pages(?:\s*-\s*Key Areas of Improvement)?\s*(?:\*\*)?\s*$/i.test(
      String(l || "").trim()
    )
  );
  if (start === -1) return markdown;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  let counter = 1;
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i].trim();
    const match = line.match(/^(?:\*\*)?\d+\.\s+(.+?)(?:\*\*)?$/);
    if (!match) continue;
    const title = (match[1] || "").trim();
    lines[i] = `${counter}. ${title}`;
    counter += 1;
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function enforceOtherPagesCrawlTruth(markdown, pages = [], additionalPageUrls = [], includeOtherPages = true) {
  if (!includeOtherPages) return markdown;
  if (!Array.isArray(additionalPageUrls) || additionalPageUrls.length === 0) return markdown;

  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    /^(?:##\s*)?(?:\*\*)?\s*Other Pages(?:\s*-\s*Key Areas of Improvement)?\s*(?:\*\*)?\s*$/i.test(
      String(l || "").trim()
    )
  );
  if (start === -1) return markdown;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (
      /^##\s+/.test(lines[i]) ||
      /^(?:\*\*)?\s*Final Recommendation\s*(?:\*\*)?\s*$/i.test(String(lines[i] || "").trim())
    ) {
      end = i;
      break;
    }
  }

  // Parse the model's existing per-URL blocks so we can preserve a finding ONLY
  // when it is anchored to that page's observed evidence. The model tends to
  // flesh out just the FIRST one or two requested pages (a positional artifact)
  // and drop the rest, so we never trust position — we rebuild the whole section
  // deterministically, covering EVERY requested URL in the order requested.
  const sectionLines = lines.slice(start + 1, end);
  const blocksByUrl = new Map();
  {
    let curUrl = null;
    let buf = [];
    const flush = () => {
      if (curUrl) blocksByUrl.set(curUrl, buf.join("\n").trim());
      buf = [];
    };
    for (const l of sectionLines) {
      const m = l.match(/^\s*URL:\s*(https?:\/\/\S+)\s*$/i);
      if (m) {
        // new block starts at the heading line just pushed; capture URL key
        curUrl = m[1];
        continue;
      }
      if (curUrl) buf.push(l);
    }
    flush();
  }

  // Build an evidence corpus per requested page so a kept finding must reference
  // something actually observed on that page (title, headings, section labels).
  const observedFor = (url) => {
    const pg = pages.find((p) => urlsEquivalent(p.url, url));
    if (!pg) return null;
    const o = pg.observed || {};
    const parts = [pg.title, o.heroHeadline, o.heroSubtext, o.announcementText];
    for (const sec of o.sections || []) parts.push(sec.heading, sec.label, sec.type);
    return parts.filter(Boolean).join("  ").toLowerCase();
  };

  // Build an entry per requested URL, but ONLY keep pages that have something
  // worth saying — a real finding, or a "could not be crawled" caveat. Pages
  // that were crawled cleanly with no finding are omitted entirely (no noisy
  // "No critical fixes identified" lines).
  const entries = [];
  additionalPageUrls.forEach((requestedUrl) => {
    const crawledPage = pages.find((p) => urlsEquivalent(requestedUrl, p.url));
    const title = crawledPage?.title || requestedUrl;

    const block = crawledPage ? blocksByUrl.get(requestedUrl) : null;
    let keptFinding = "";
    if (block) {
      const corpus = observedFor(requestedUrl) || "";
      const evMatches = Array.from(block.matchAll(/\[ev:\s*["“]?(.*?)["”]?\]/gi))
        .map((m) => (m[1] || "").toLowerCase().trim())
        .filter((q) => q.length >= 8 && corpus.includes(q));
      if (evMatches.length) keptFinding = block.replace(/\s*\[ev:[^\]]*\]/gi, "").trim();
    }

    let body = "";
    if (keptFinding) {
      body = keptFinding;
    } else if (crawledPage) {
      // Page-appropriate, detector-backed finding (item 27 compliant — never a
      // home section). Currently: contact pages with no on-page contact form.
      const sections = (crawledPage.observed && crawledPage.observed.sections) || [];
      const isContactPage =
        crawledPage.pageType === "contact" || /\/contact|contact-information/i.test(requestedUrl);
      const hasContactForm = sections.some((s) => /contact/i.test(s.type || ""));
      if (isContactPage && !hasContactForm) {
        body = [
          "This page provides contact details but no on-page contact form, so visitors must leave the site to reach out.",
          "* Recommendations:",
          "* Add an on-page contact form (name, email, order number, message)",
          "* Surface all available support channels here (live chat / WhatsApp), not only email and phone",
        ].join("\n");
      }
      // else: crawled cleanly, no finding → omit this page entirely.
    } else {
      body = "This requested page could not be crawled, so no recommendations are included.";
    }

    if (body) entries.push({ title, url: requestedUrl, body });
  });

  // If no additional page has anything to report, drop the whole section.
  if (!entries.length) {
    return [...lines.slice(0, start), ...lines.slice(end)]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const rebuilt = ["## Other Pages - Key Areas of Improvement", ""];
  entries.forEach((e, idx) => {
    rebuilt.push(`${idx + 1}. ${e.title}`);
    rebuilt.push(`URL: ${e.url}`);
    rebuilt.push(e.body);
    rebuilt.push("");
  });

  return [...lines.slice(0, start), ...rebuilt, ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function dropRecommendationsForNoFixSections(markdown) {
  if (!markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]);
    if (!/No critical fixes identified from captured evidence\./i.test(lines[i])) continue;

    let j = i + 1;
    while (j < lines.length && /^\s*$/.test(lines[j])) {
      out.push(lines[j]);
      j += 1;
    }
    if (j < lines.length && /^\s*Recommendations:\s*$/i.test(lines[j])) {
      j += 1;
      while (j < lines.length && /^\s*[-*]\s+/.test(lines[j])) j += 1;
      i = j - 1;
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function appendScreenshotAssets(markdown, pages) {
  void pages;
  return markdown;
}

function enforceReferenceLines(markdown) {
  // Keep client-facing output clean; do not inject reference lines.
  return markdown;
}

function buildSectionScreenshotReferences(pages, toPublicAssetUrl) {
  const pools = { home: [], collection: [], product: [], other: [] };

  for (const page of pages || []) {
    const area =
      page?.pageType === "collection"
        ? "collection"
        : page?.pageType === "product"
          ? "product"
          : page?.pageType === "general" 
            ? "home"
            : "other";

    const sectionShots = page?.sectionScreenshots || {};
    for (const shotPath of Object.values(sectionShots)) {
      const publicUrl = toPublicAssetUrl(shotPath);
      if (publicUrl && !pools[area].includes(publicUrl)) pools[area].push(publicUrl);
    }
    if (page?.aboveFoldScreenshotPath) {
      const aboveFold = toPublicAssetUrl(page.aboveFoldScreenshotPath);
      if (aboveFold && !pools[area].includes(aboveFold)) pools[area].push(aboveFold);
    }
  }

  return pools;
}

function buildSectionScreenshotLookup(pages, toPublicAssetUrl) {
  const lookup = {
    home: {},
    collection: {},
    product: {},
    other: {}
  };

  for (const page of pages || []) {
    const area =
      page?.pageType === "collection"
        ? "collection"
        : page?.pageType === "product"
          ? "product"
          : page?.pageType === "general"
            ? "home"
            : "other";

    const sectionShots = page?.sectionScreenshots || {};
    for (const [key, shotPath] of Object.entries(sectionShots)) {
      const publicUrl = toPublicAssetUrl(shotPath);
      if (publicUrl && !lookup[area][key]) {
        lookup[area][key] = publicUrl;
      }
    }
  }

  return lookup;
}

function sectionKeyFromLabel(area, sectionLabel = "") { 
  const text = sectionLabel.toLowerCase();
  if (area === "home") {
    if (text.includes("announcement")) return "announcement";
    if (text.includes("header") || text.includes("navigation")) return "header";
    if (text.includes("hero") || text.includes("banner")) return "hero";
    if (text.includes("trust") || text.includes("usp")) return "trust";
    if (text.includes("featured") || text.includes("collection") || text.includes("best seller")) return "featured";
    if (text.includes("footer")) return "footer";
  }
  if (area === "collection") {
    if (text.includes("heading")) return "heading";
    if (text.includes("intro") || text.includes("seo")) return "intro";
    if (text.includes("filter") || text.includes("sort")) return "filterSort";
    if (text.includes("product card") || text.includes("product grid") || text.includes("scanability")) return "productGrid";
    if (text.includes("trust")) return "productGrid";
  }
  if (area === "product") {
    if (text.includes("above-the-fold") || text.includes("title") || text.includes("price") || text.includes("cta")) return "titlePriceCta";
    if (text.includes("media") || text.includes("image") || text.includes("gallery")) return "media";
    if (text.includes("trust") || text.includes("warranty") || text.includes("returns") || text.includes("delivery")) return "trust";
    if (text.includes("cross-sell") || text.includes("upsell") || text.includes("recently viewed")) return "upsell";
  }
  return "";
}

function applySectionScreenshotReferences(markdown, sectionScreenshotLookup, sectionScreenshotReferences) {
  const lines = markdown.split(/\r?\n/);
  let currentArea = "other";
  let currentSectionLabel = "";

  const detectAreaFromHeading = (line) => {
    const t = line.toLowerCase();
    if (t.includes("home page")) return "home";
    if (t.includes("collection page")) return "collection";
    if (t.includes("product page")) return "product";
    return "other";
  };

  const result = lines.map((line) => {
    if (/^##\s+/.test(line)) {
      currentArea = detectAreaFromHeading(line);
      currentSectionLabel = "";
      return line;
    }

    const sectionMatch = line.match(/section:\s*(.+)$/i);
    if (sectionMatch?.[1]) {
      currentSectionLabel = sectionMatch[1].trim();
      return line;
    }

    if (/screenshot reference:/i.test(line)) {
      const sectionKey = sectionKeyFromLabel(currentArea, currentSectionLabel);
      const areaLookup = sectionScreenshotLookup[currentArea] || {};
      const mapped = areaLookup[sectionKey];
      const fallback = sectionScreenshotReferences[currentArea]?.[0] || "";
      // If we know the exact section key, never fall back to unrelated area screenshot.
      // This avoids mismatched references (e.g. featured collection -> header screenshot).
      const chosen = sectionKey ? mapped : mapped || fallback;
      if (!chosen) return "";
      return line.replace(/:\s*.*/i, `: View screenshot (${chosen})`);
    }

    return line;
  });

  return result.join("\n");
}

function applyScreenshotReferenceFallbacks(
  markdown,
  referenceScreenshots = [],
  sectionScreenshotReferences = {}
) {
  if (!Array.isArray(referenceScreenshots) || referenceScreenshots.length === 0) {
    return markdown;
  }

  const lightshotUrls = referenceScreenshots.filter((u) => /https?:\/\/(www\.)?prnt\.sc\//i.test(u));
  const preferred = lightshotUrls.length ? lightshotUrls : referenceScreenshots;

  const asDocLink = (url) => `View screenshot (${url})`;
  const sectionReference = {
    home: sectionScreenshotReferences.home?.[0] || preferred[0] || preferred[preferred.length - 1],
    collection: sectionScreenshotReferences.collection?.[0] || preferred[1] || preferred[0],
    product: sectionScreenshotReferences.product?.[0] || preferred[2] || preferred[0],
    other: sectionScreenshotReferences.other?.[0] || preferred[3] || preferred[0],
    default: preferred[0]
  };

  const lines = markdown.split(/\r?\n/);
  let currentArea = "default";

  const detectAreaFromHeading = (line) => {
    const t = line.toLowerCase();
    if (t.includes("home page")) return "home";
    if (t.includes("collection page")) return "collection";
    if (t.includes("product page")) return "product";
    if (t.includes("other pages")) return "other";
    return currentArea;
  };

  const result = lines.map((line) => {
    if (/^##\s+/.test(line)) {
      currentArea = detectAreaFromHeading(line);
      return line;
    }

    if (/screenshot reference:/i.test(line)) {
      const replacement = sectionReference[currentArea] || sectionReference.default;
      if (!replacement) return line;

      const isMissingLike =
        /:\s*(n\/a|na|none|not captured|see related item in screenshot assets)\s*$/i.test(line) ||
        /:\s*$/.test(line);
      if (isMissingLike) {
        return "";
      }
    }

    return line;
  });

  return result.join("\n");
}

export async function runAudit({
  url,
  out = "",
  maxPages = 6,
  appBaseUrl = "",
  additionalPageUrls = [],
  persistReports = true,
  createMarkdown = true,
  docx = false,
  fastMode = false,
  includeScreenshots = false,
  includeReferenceBenchmarks = false,
  referenceScreenshots = [],
  referenceSiteUrls = [],
  model = process.env.OPENAI_MODEL || "openai/gpt-4.1-mini",
  onProgress
}) {
  const emitProgress = (payload) => {
    if (typeof onProgress === "function") onProgress(payload);
  };
  const toPublicAssetUrl = (assetPath) => {
    if (!assetPath) return "";
    if (/^https?:\/\//i.test(assetPath)) return assetPath;
    const normalized = `/${String(assetPath).replace(/\\/g, "/").replace(/^\/+/, "")}`;
    if (!/^\/reports\//i.test(normalized) && !/^\/previews\//i.test(normalized)) {
      return normalized;
    }
    const base = String(appBaseUrl || "").replace(/\/+$/, "");
    return base ? `${base}${normalized}` : normalized;
  };

  process.env.AUDIT_FAST_MODE = fastMode ? "1" : "0";
  process.env.AUDIT_USE_FETCH_ONLY = fastMode ? "1" : "0";
  const screenshotDir = persistReports && includeScreenshots
    ? path.join("reports", "screenshots", `${slugFromUrl(url)}-${todayISO()}`)
    : "";
  const sectionScreenshotDir = persistReports
    ? path.join("reports", "section-screenshots", `${slugFromUrl(url)}-${todayISO()}`)
    : "";
  process.env.AUDIT_SCREENSHOT_DIR = screenshotDir;
  process.env.AUDIT_SECTION_SCREENSHOT_DIR = sectionScreenshotDir;

  emitProgress({ type: "phase", phase: "crawl", message: "Crawling storefront pages..." });

  let lastThemeEmitted = "";
  const {
    shopifyDetected,
    pages: crawledPagesRaw,
    crawlNotes = []
  } = await crawlStore(url, maxPages || 8, {
    additionalPageUrls,
    pagesPerType: Number(process.env.AUDIT_PAGES_PER_TYPE) || undefined,
    onPageCrawled: (event) => {
      if (event.status === "crawling" || event.status === "blocked") {
        emitProgress({
          type: "page",
          status: event.status,
          order: event.order,
          url: event.url,
          pageKey: event.pageKey,
          pageType: event.pageType,
          title: event.title
        });
        if (event.status === "blocked") return;
        return;
      }

      emitProgress({
        type: "page",
        status: "done",
        order: event.order,
        url: event.url,
        pageKey: event.pageKey,
        title: event.title,
        pageType: event.pageType,
        requestedAsAdditional: event.requestedAsAdditional
      });

      if (event.themeInfo) {
        const theme = formatThemeForApi(event.themeInfo);
        const themeKey = `${theme.schemaName}|${theme.instanceName}`;
        if (themeKey !== lastThemeEmitted && theme.displayName !== "Not clearly detected") {
          lastThemeEmitted = themeKey;
          emitProgress({ type: "theme", theme });
        }
      }
    }
  });

  const pages = dedupeCrawledPages(crawledPagesRaw);
  if (pages.length !== crawledPagesRaw.length) {
    console.log(
      `[audit] Deduped crawled pages: ${crawledPagesRaw.length} → ${pages.length} (variant/duplicate URLs removed)`
    );
  }

  emitProgress({
    type: "phase",
    phase: "crawl_done",
    message:
      crawlNotes.length > 0
        ? `Crawled ${pages.length} page(s). ${crawlNotes[0]}`
        : `Crawled ${pages.length} page(s).`,
    pagesFound: pages.length,
    crawlNotes
  });

  let shopifyConfirmed =
    shopifyDetected || inferShopifyFromCrawledPages(pages) || (await probeShopifyStore(url));

  console.log(
    `Crawling completed: shopifyDetected=${shopifyDetected}, shopifyConfirmed=${shopifyConfirmed}, pagesFound=${pages.length}`
  );

  if (!shopifyConfirmed) {
    throw new Error(
      `This URL does not appear to be a Shopify storefront. The audit agent only works with Shopify stores.\n` +
      `Please verify that ${url} is a valid Shopify website.`
    );
  }

  if (!pages.length) {
    throw new Error(
      `This store appears to be Shopify, but bot protection blocked the crawl and no pages could be analyzed.\n` +
      `Please try again later, use the live storefront URL (not a preview link), or ask the merchant to allow automated access.\n` +
      `Store URL: ${url}`
    );
  }

  const referenceBenchmarkDir = persistReports
    ? path.join("reports", "reference-screenshots", `${slugFromUrl(url)}-${todayISO()}`)
    : "";
  const shouldCollectReferenceBenchmarks =
    persistReports &&
    (includeReferenceBenchmarks || (referenceSiteUrls && referenceSiteUrls.length > 0));
  const resolvedReferenceSites = shouldCollectReferenceBenchmarks
    ? resolveReferenceSites(referenceSiteUrls)
    : [];
  const autoReferenceShots = shouldCollectReferenceBenchmarks
    ? await collectReferenceScreenshots({
        urls: resolvedReferenceSites,
        outputDir: referenceBenchmarkDir,
        limit: fastMode ? 1 : 2
      })
    : [];
  // Optional vision validation layer: render pages with a supposedly-missing
  // section and let a vision model confirm from the screenshot whether it is
  // actually present, suppressing false "missing" findings. No-ops unless
  // VISION_MODEL + an API key are configured; fails safe on any error.
  try {
    const missingByPageType = {};
    for (const m of storefrontMissingSections(pages)) {
      (missingByPageType[m.pageType] = missingByPageType[m.pageType] || []).push(m.type);
    }
    if (Object.keys(missingByPageType).length) {
      emitProgress({ type: "phase", phase: "vision", message: "Validating findings against page screenshots..." });
      await annotatePagesWithVision(pages, missingByPageType);
    }
  } catch (error) {
    console.log(`[audit] vision validation skipped: ${error.message}`);
  }

  const promptWithReferences = buildAuditPrompt({
    storeUrl: url,
    pages,
    date: todayISO(),
    additionalPageUrls,
    crawlNotes
  });

  emitProgress({
    type: "phase",
    phase: "generate",
    message: "Generating audit report with AI..."
  });

  const candidateModels = fastMode
    ? [process.env.FAST_AUDIT_MODEL || "openai/gpt-4.1-mini"]
    : [model, "openai/gpt-4.1-mini"].filter(
    (m, idx, arr) => m && arr.indexOf(m) === idx
  );

  let markdown = "";
  let markdownRaw = "";
  let success = false;
  const includeOtherPages = shouldIncludeOtherPagesSection(pages, additionalPageUrls);

  const maxAttemptsPerModel = fastMode ? 1 : 2;
  const minFieldCoverageScore = fastMode ? 60 : 75;

  for (const candidateModel of candidateModels) {
    for (let attempt = 0; attempt < maxAttemptsPerModel; attempt += 1) {
      const strictSuffix =
        attempt === 0
          ? ""
          : `

CRITICAL REPAIR INSTRUCTIONS:
- Previous output was rejected.
- Do not use placeholders like "remaining sections".
- You must include all required sections in the client format.
- Use subsection style: heading, short issue paragraph, "Recommendations:" bullets.
- Keep wording simple and human-friendly for merchants.
- No tables.
- Do not ask follow-up questions. Output final audit only.
`;
      markdownRaw = await generateAuditMarkdown(`${promptWithReferences}${strictSuffix}`, candidateModel);
      if (!markdownRaw) continue;
      markdown = sanitizeMarkdown(markdownRaw);
      markdown = removeSeoAndSpeedContent(markdown);
      markdown = removeThemeUpgradeContent(markdown);
      markdown = removeEnsurePhrasing(markdown);
      const fieldCoverage = scoreIssueFieldCoverage(markdown);
      const valid =
        hasAllRequiredSections(markdown, includeOtherPages) &&
        !looksLikePlaceholder(markdown) &&
        fieldCoverage.score >= minFieldCoverageScore;
      if (valid) {
        success = true;
        break;
      }
    }
    if (success) break;
  }

  // Safety net for detailed mode.
  if (!success && !fastMode) {
    const fallbackModel = "openai/gpt-4.1-mini";
    const repairPrompt = `${promptWithReferences}

CRITICAL REPAIR INSTRUCTIONS:
- Previous output was rejected.
- You must include all required sections completely.
- No placeholders, no "continue?" style responses.
- No tables.
- Keep each subsection concise and readable with "Recommendations:" bullets.
- Output final markdown only.
`;
    markdownRaw = await generateAuditMarkdown(repairPrompt, fallbackModel);
    if (markdownRaw) {
      markdown = sanitizeMarkdown(markdownRaw);
      markdown = removeSeoAndSpeedContent(markdown);
      markdown = removeThemeUpgradeContent(markdown);
      markdown = removeEnsurePhrasing(markdown);
      success = hasAllRequiredSections(markdown, includeOtherPages) && !looksLikePlaceholder(markdown);
    }
  }

  // Final safety: do not hard-fail if partial output exists; append missing section scaffolds.
  if (!success) {
    const ensureSection = (title) =>
      new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(markdown)
        ? ""
        : `\n## ${title}\n\n1. Key Improvement\nNeeds manual validation from crawl output.\nRecommendations:\n- Validate this section on live theme and add final recommendation items.\n`;

    const scaffoldTitles = [
      "Shopify Store Audit - Store Name",
      `Website: ${url}`,
      "Summary",
      "Home Page - Key Areas of Improvement",
      "Collection Page",
      "Product Page - Key Areas of Improvement",
      ...(includeOtherPages ? ["Other Pages - Key Areas of Improvement"] : []),
      "Final Recommendation"
    ];

    const missingScaffold = scaffoldTitles
      .map(ensureSection)
      .join("");

    markdown = `${markdown}\n${missingScaffold}`.trim();
  }

  markdown = removeSeoAndSpeedContent(markdown);
  markdown = removeThemeUpgradeContent(markdown);
  markdown = removeEnsurePhrasing(markdown);

  if (autoReferenceShots.length) {
    const refLines = ["", "## Reference Benchmark Screenshots", ""];
    autoReferenceShots.forEach((r, idx) => {
      refLines.push(`${idx + 1}. ${r.title} - ${r.url}`);
      refLines.push(`- Screenshot: ${r.screenshotPath}`);
      refLines.push("");
    });
    markdown = `${markdown}\n${refLines.join("\n")}`.trim();
  }
  const signalFacts = aggregateDetectedSignals(pages);
  markdown = enforceSignalConsistency(markdown, signalFacts, pages);
  markdown = removeOtherPagesSectionIfNotApplicable(markdown, includeOtherPages);
  markdown = enforceOtherPageUrlCoverage(markdown, additionalPageUrls, includeOtherPages);
  markdown = normalizeOtherPagesNumbering(markdown);
  markdown = enforceOtherPagesCrawlTruth(markdown, pages, additionalPageUrls, includeOtherPages);
  markdown = dropRecommendationsForNoFixSections(markdown);
  markdown = enforceImprovementFields(markdown);
  let normalizedStatusCount = 0;
  const normalizedStatuses = normalizeInvalidStatusValues(markdown);
  normalizedStatusCount = normalizedStatuses.invalidCount;
  markdown = normalizedStatuses.markdown;
  markdown = normalizeAuditLayout(markdown);
  markdown = injectQualityScorecard(markdown);
  markdown = enforceReferenceLines(markdown);
  markdown = markdown
    .replace(/^\s*[-*]?\s*Screenshot Reference:\s*.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let reliabilityChecks = buildReliabilityChecks(markdown, pages, includeOtherPages);

  if (!reliabilityChecks.hardPass) {
    const fallbackModel = model || "openai/gpt-4.1-mini";
    const repairPrompt = `${promptWithReferences}

CRITICAL RELIABILITY REPAIR:
- Fix all QA failures listed below.
- Keep sections in the client-facing audit format.
- Do not use Status/Requirement/Evidence labels.
- Final Recommendation must contain 5-7 concise bullets.
- Keep all findings evidence-backed and internally consistent.
- Output final markdown only.

QA failures to fix:
${reliabilityChecks.failures.map((f, idx) => `${idx + 1}. ${f}`).join("\n")}
`;
    const repairedRaw = await generateAuditMarkdown(repairPrompt, fallbackModel);
    if (repairedRaw) {
      let repaired = sanitizeMarkdown(repairedRaw);
      repaired = removeSeoAndSpeedContent(repaired);
      repaired = removeThemeUpgradeContent(repaired);
      repaired = removeEnsurePhrasing(repaired);
      repaired = enforceSignalConsistency(repaired, signalFacts, pages);
      repaired = removeOtherPagesSectionIfNotApplicable(repaired, includeOtherPages);
      repaired = enforceOtherPageUrlCoverage(repaired, additionalPageUrls, includeOtherPages);
      repaired = normalizeOtherPagesNumbering(repaired);
      repaired = enforceOtherPagesCrawlTruth(repaired, pages, additionalPageUrls, includeOtherPages);
      repaired = dropRecommendationsForNoFixSections(repaired);
      repaired = enforceImprovementFields(repaired);
      const repairedNormalizedStatuses = normalizeInvalidStatusValues(repaired);
      normalizedStatusCount = repairedNormalizedStatuses.invalidCount;
      repaired = repairedNormalizedStatuses.markdown;
      repaired = normalizeAuditLayout(repaired);
      repaired = injectQualityScorecard(repaired);
      repaired = enforceReferenceLines(repaired);
      repaired = repaired
        .replace(/^\s*[-*]?\s*Screenshot Reference:\s*.*$/gim, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const repairedChecks = buildReliabilityChecks(repaired, pages, includeOtherPages);
      if (repairedChecks.hardPass || repairedChecks.reliabilityScore >= reliabilityChecks.reliabilityScore) {
        markdown = repaired;
        reliabilityChecks = repairedChecks;
      }
    }
  }

  const outputPath = createMarkdown
    ? out || path.join("reports", `${slugFromUrl(url)}-audit-${todayISO()}.md`)
    : "";
  if (persistReports && createMarkdown) {
    await saveReport(outputPath, markdown);
  }

  let docxPath = "";
  if (docx && persistReports) {
    const docxBuffer = await markdownToDocxBuffer(markdown);
    docxPath = outputPath.replace(/\.md$/i, ".docx");
    await saveBinary(docxPath, docxBuffer);
  }

  const theme = formatThemeForApi(pickStoreThemeFromPages(pages));
  const crawledPages = summarizeCrawledPagesForApi(pages, additionalPageUrls);

  return {
    markdown,
    outputPath,
    docxPath,
    pagesAnalyzed: pages.length,
    theme,
    crawledPages,
    screenshots: includeScreenshots
      ? pages
          .map((p) => p.screenshotPath)
          .filter(Boolean)
          .map((s) => toPublicAssetUrl(s))
      : [],
    referenceBenchmarks: autoReferenceShots.map((r) => ({
      ...r,
      screenshotPath: toPublicAssetUrl(r.screenshotPath)
    })),
    referenceSitePoolUsed: resolvedReferenceSites,
    qualityChecks: {
      requiredSectionsPresent: reliabilityChecks.requiredSectionsPresent,
      sectionEightPresent: reliabilityChecks.sectionEightPresent,
      placeholderDetected: reliabilityChecks.placeholderDetected,
      issueFieldCoverageScore: reliabilityChecks.issueFieldCoverageScore,
      issueSubsectionsDetected: reliabilityChecks.issueSubsectionsDetected,
      invalidStatusValuesDetected: reliabilityChecks.invalidStatusValuesDetected,
      invalidStatusValuesNormalized: normalizedStatusCount,
      productPagesDetected: reliabilityChecks.productPagesDetected,
      productDataCoverageAdequate: reliabilityChecks.productDataCoverageAdequate,
      screenshotReuseRisk: reliabilityChecks.screenshotReuseRisk,
      finalRecommendationBullets: reliabilityChecks.finalRecommendationBullets,
      finalRecommendationBulletCountValid: reliabilityChecks.finalRecommendationBulletCountValid,
      contradictionRiskDetected: reliabilityChecks.contradictionRiskDetected,
      reliabilityScore: reliabilityChecks.reliabilityScore,
      hardPass: reliabilityChecks.hardPass,
      failures: reliabilityChecks.failures
    }
  };
}