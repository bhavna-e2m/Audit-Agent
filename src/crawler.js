import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { detectFeatures, detectThemeInfo, detectThemeName } from "./featureDetection.js";
import { canonicalUrlKey, crawlCanonicalUrlKey, urlsEquivalent } from "./utils.js";

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function abs(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return "";
  }
}

function classifyPage(url) {
  if (/\/products\//i.test(url)) return "product";
  if (/\/collections\//i.test(url)) return "collection";
  if (/\/pages\/faq|\/faq/i.test(url)) return "faq";
  if (/\/pages\/contact|\/contact/i.test(url)) return "contact";
  if (/\/pages\/warranty|\/warranty/i.test(url)) return "warranty";
  return "general";
}

const PAYMENT_TITLE_NOISE =
  /\s*(?:Visa|Mastercard|American Express|PayPal|Diners Club|Discover|Amex|Apple Pay|Google Pay|Shop Pay|Afterpay|Klarna)+\s*/gi;

// ── CTA label hygiene ──────────────────────────────────────────────────────
// Navigation / accessibility / locale chrome that is NOT a real marketing CTA.
// Without this filter, "Skip to content" and the currency selector
// "United States (USD $)" leak in as "primary CTAs" and the LLM repeats them
// back in the report (violating audit Hard Rule #10).
const JUNK_CTA_LABEL =
  /^(?:skip(?:\s+to\b.*)?|back to top|menu|close|open menu|toggle menu|cart|view cart|search|log ?in|sign ?in|account|my account|toggle|expand|collapse|previous|next|prev|submit|select (?:language|region|country|currency)|change (?:region|country|language|currency))$/i;

function isJunkCtaLabel(t) {
  const s = (t || "").trim();
  if (s.length < 2 || s.length > 40) return true;       // empty / oversized
  if (!/[a-z0-9]/i.test(s)) return true;                // pure icon / punctuation
  if (JUNK_CTA_LABEL.test(s)) return true;              // known chrome labels
  // Country / currency selectors, e.g. "United States (USD $)", "France (EUR €)".
  if (/\([^)]*(?:USD|EUR|GBP|CAD|AUD|INR|JPY|CNY|AED|SGD|NZD|CHF|SEK|ZAR)[^)]*\)/i.test(s)) return true;
  return false;
}

// ── Price extraction ───────────────────────────────────────────────────────
// Target the price VALUE node, not a wrapper that concatenates regular + sale
// + visually-hidden labels (which produced garbage like
// "Regular price $390.00 Sale price Regular"). Strip a11y labels, then pull the
// first money token so the report quotes a clean price.
function extractPriceText($) {
  const candidates = [
    "[class*='price-item--sale' i]",
    "[class*='price__sale' i] [class*='price-item' i]",
    "[class*='price-item--regular' i]",
    "[class*='price__regular' i] [class*='price-item' i]",
    "[class*='price-item' i]",
    "[class*='money' i]",
    "[class*='price' i]:not([class*='compare' i]):not([class*='was' i])"
  ];
  for (const sel of candidates) {
    const $el = $(sel).first();
    if (!$el.length) continue;
    const $clone = $el.clone();
    $clone
      .find("[class*='visually-hidden' i], [class*='visuallyhidden' i], [class*='sr-only' i], [hidden], [aria-hidden='true']")
      .remove();
    const raw = cleanText($clone.text());
    if (!raw) continue;
    const money = raw.match(/(?:[$€£¥₹]\s?\d[\d.,]*|\d[\d.,]*\s?[$€£¥₹])/);
    if (money) return money[0].replace(/\s+/g, "");
    if (/\d/.test(raw)) return raw.slice(0, 40);
  }
  return "";
}

// ── Announcement / offer bar text ──────────────────────────────────────────
// The old extractor only matched [class*='announcement'], so custom themes
// (e.g. Hyper/FoxEcom, whose bar reads "Free Express Shipping on orders $500"
// under a non-standard class) returned empty — which downstream code wrongly
// reported as "no offer bar". This uses the same broad vocabulary as
// detectAnnouncementBar, then a positional offer-phrase fallback, so a bar that
// genuinely exists is found regardless of class naming.
const OFFER_PHRASE =
  /\b(?:free (?:express )?shipping|free delivery|ships? free|\d+% ?off|% ?off|on sale|flash sale|clearance|limited time|today only|ends? (?:soon|today)|spend \$?\d|orders? over \$?\d|save \$?\d)/i;

function extractAnnouncementText($) {
  const barSelectors = [
    "[data-section-type*='announcement' i]",
    "[class*='announcement' i]",
    "[id*='announcement' i]",
    "[class*='promo-bar' i]",
    "[class*='promobar' i]",
    "[class*='promo_bar' i]",
    "[class*='top-bar' i]",
    "[class*='topbar' i]",
    "[class*='utility-bar' i]",
    "[class*='utilitybar' i]",
    "[class*='notification-bar' i]",
    "[class*='ticker' i]",
    "[class*='marquee' i]",
    "[class*='header-promo' i]"
  ];
  for (const sel of barSelectors) {
    const t = cleanText($(sel).first().text());
    if (t) return t.slice(0, 160);
  }
  // Positional fallback: first short top-of-page leaf that reads like an offer.
  let found = "";
  $("body *").slice(0, 60).each((_, el) => {
    if (found) return;
    const $el = $(el);
    if ($el.children().length > 3) return; // skip large containers, want the leaf
    const t = cleanText($el.text());
    if (t && t.length <= 120 && OFFER_PHRASE.test(t)) found = t;
  });
  return found.slice(0, 160);
}

function cleanPageTitle(raw) {
  let title = cleanText(raw || "");
  if (!title) return "";
  title = title.replace(PAYMENT_TITLE_NOISE, " ").replace(/\s{2,}/g, " ").trim();
  const parts = title.split(/\s*[–—]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const storeTail = parts[parts.length - 1];
    const storeTailNoisy =
      /(?:Visa|Mastercard|American Express|PayPal|Diners Club|Discover)/i.test(storeTail) ||
      storeTail.length > 80;
    if (storeTailNoisy) {
      return parts.slice(0, -1).join(" – ").trim().slice(0, 160);
    }
    return title.slice(0, 160);
  }
  return title.slice(0, 160);
}

function buildElementSelector($, el) {
  if (!el || !el.attribs) return "";
  const tag = el.tagName || el.name || "section";
  if (el.attribs.id) return `#${el.attribs.id}`;
  if (el.attribs["data-section-id"]) {
    return `${tag}[data-section-id="${el.attribs["data-section-id"]}"]`;
  }
  if (el.attribs["data-section-type"]) {
    return `${tag}[data-section-type="${el.attribs["data-section-type"]}"]`;
  }
  if (el.attribs.class) {
    const cls = String(el.attribs.class)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join(".");
    if (cls) return `${tag}.${cls}`;
  }
  return tag;
}

/**
 * Find the above-the-fold module without depending on a specific class name.
 * Tries semantic Shopify 2.0 attributes first, then falls back to "first
 * visible block in <main>". This is theme-agnostic.
 */
function detectAboveFoldModule($) {
  const prioritySelectors = [
    // Shopify 2.0 schema-based (most reliable, theme-agnostic)
    "[data-section-type*='slideshow']",
    "[data-section-type*='hero']",
    "[data-section-type*='image-banner']",
    "[data-section-type*='banner']",
    "[data-section-type*='image-with-text']",
    // Loose class hints (any case)
    "section[class*='hero' i]",
    "section[class*='banner' i]",
    "section[class*='slideshow' i]",
    "section[class*='carousel' i]",
    ".hero",
    ".banner",
    ".slideshow",
    // Fallback: first content block under main
    "main > section:first-of-type",
    "main > div:first-of-type"
  ];

  let moduleEl = null;
  for (const selector of prioritySelectors) {
    try {
      const candidate = $(selector).first();
      if (candidate.length) {
        moduleEl = candidate.get(0);
        break;
      }
    } catch {
      // ignore bad selector
    }
  }

  if (!moduleEl) return null;

  const moduleNode = $(moduleEl);
  const moduleText = cleanText(moduleNode.text()).slice(0, 500);
  const hasHeadline =
    moduleNode.find("h1,h2,[class*='headline' i],[class*='title' i]").length > 0 ||
    moduleText.length > 40;
  const hasCta =
    moduleNode.find("a[href],button").length > 0 &&
    /shop|buy|learn|explore|get|start|view|discover|quote|contact|order|browse/i.test(moduleText);

  return {
    selector: buildElementSelector($, moduleEl),
    hasHeadline,
    hasCta,
    messageAndCtaPresent: Boolean(hasHeadline && hasCta),
    textSnippet: moduleText
  };
}

// ── Storefront section inventory ───────────────────────────────────────────
// Theme-agnostic detection of which CONTENT sections a page actually contains.
// This is the observation the audit previously lacked: without a list of the
// sections that exist, the LLM cannot identify MISSING sections or reason about
// which present sections are weak. Page chrome (header/footer/announcement/
// cart/popups) is excluded — those are covered by featureDetection.js.

const SECTION_TYPE_LABELS = {
  hero: "Hero / banner / slideshow",
  featuredCollection: "Featured collection (product showcase)",
  collectionList: "Collection / category list",
  featuredProduct: "Featured single product",
  productRecommendations: "Recommended / related products",
  benefits: "Value-prop / benefits / icon row",
  imageWithText: "Image-with-text / editorial block",
  brandStory: "Brand story / about / mission",
  richText: "Rich-text content block",
  testimonials: "Testimonials / customer reviews block",
  press: "Press / 'as seen in' / brand logos",
  newsletter: "Newsletter / email signup",
  blog: "Blog / articles teaser",
  gallery: "Gallery / lookbook / UGC / Instagram",
  video: "Video section",
  contact: "Contact form / contact block",
  faq: "FAQ / accordion",
  countdown: "Countdown / promo / urgency",
  map: "Map / store locator",
  custom: "Custom / app section"
};

const SECTION_CHROME_TOKENS = [
  "header", "footer", "announcement", "cart", "drawer", "popup", "modal",
  "age-gate", "agegate", "cookie", "breadcrumb", "predictive-search",
  "search-modal", "menu-drawer", "localization"
];

function sectionNameFromId(id) {
  const raw = (id || "").toLowerCase().replace(/^shopify-section-/, "");
  if (!raw) return "";
  if (raw.includes("__")) return raw.split("__").pop();
  return raw.replace(/^(template--[^-]*-+|sections--[^-]*-+|static-)/, "");
}

function classifySectionType(signals, headingText) {
  const hay = (signals || []).join(" ").toLowerCase();
  const head = (headingText || "").toLowerCase();
  const has = (...words) => words.some((w) => hay.includes(w));
  const headHas = (...words) => words.some((w) => head.includes(w));
  // Brand-story / ethos vocabulary. Broadened beyond literal "story/about/
  // mission" so values, sustainability, craft and transparency sections (common
  // in furniture/lifestyle themes like Hyper) are recognised as a brand story
  // rather than dropped as generic image-with-text.
  const headIsBrandStory = () =>
    headHas(
      "story", "about", "mission", "founder", "who we are", "our journey",
      "our promise", "our values", "what we believe", "we believe",
      "sustainab", "ethic", "responsibly", "our craft", "craftsmanship",
      "made to last", "transparency", "our philosophy", "why we", "our story",
      "meet our team", "meet the team", "our team", "creative minds",
      "the creative", "behind our", "where design", "design meet",
      "the makers", "who makes", "our studio"
    );

  if (has("slideshow", "image-banner", "image_banner", "hero", "banner") && !has("collection-banner", "collection_banner")) return "hero";
  if (has("collection-list", "collection_list", "list-collections", "list_collections")) return "collectionList";
  if (has("featured-collection", "featured_collection", "product-grid", "product_grid")) return "featuredCollection";
  if (has("featured-product", "featured_product")) return "featuredProduct";
  if (has("product-recommendations", "product_recommendations", "related-products", "recommended", "complementary")) return "productRecommendations";
  if (has("newsletter", "email-signup", "email_signup", "subscribe")) return "newsletter";
  if (has("testimonial", "review") || headHas(
      "review", "what our customers", "what customers say", "loved by",
      "testimonial", "what clients", "what our clients", "clients say",
      "talk about us", "kind words", "happy customers", "what people say",
      "review score", "rated"
    )) return "testimonials";
  if (has("logo-list", "logo_list", "logos", "brands-bar") || headHas("as seen in", "featured in", "as seen on", "press")) return "press";
  if (has("multicolumn", "multi-column", "multi_column", "icons", "icon-row", "value-prop", "value_prop", "usp") || headHas("free shipping", "why shop", "why choose")) return "benefits";
  if (has("image-with-text", "image_with_text", "collage", "image-text")) {
    if (headIsBrandStory()) return "brandStory";
    return "imageWithText";
  }
  if (has("contact", "contact-form", "contact_form") || headHas("contact us", "get in touch")) return "contact";
  if (has("faq", "accordion") || headHas("frequently asked", "faq", "questions")) return "faq";
  if (has("blog", "article", "editorial") || headHas("from the blog", "latest posts", "journal")) return "blog";
  if (has("instagram", "ugc", "lookbook", "shop-the-look", "shop_the_look", "gallery") || headHas("follow us", "shop the look")) return "gallery";
  if (has("video")) return "video";
  if (has("countdown", "promo", "promotion", "sale-banner", "deal")) return "countdown";
  if (has("map", "store-locator", "store_locator")) return "map";
  if (has("rich-text", "rich_text") || headIsBrandStory()) {
    if (headIsBrandStory()) return "brandStory";
    return "richText";
  }
  if (has("custom-liquid", "custom_liquid", "apps", "app-")) return "custom";
  return "";
}

function sectionLooksLikeChrome(signals) {
  const hay = (signals || []).join(" ").toLowerCase();
  return SECTION_CHROME_TOKENS.some((t) => hay.includes(t));
}

function summarizeObservedFeatures(features = {}) {
  const out = {};
  for (const [key, result] of Object.entries(features)) {
    if (!result || result.present === null) continue;
    out[key] = {
      present: result.present,
      confidence: result.confidence || "low",
      evidence: (result.evidence || []).slice(0, 2)
    };
  }
  return out;
}

function extractSectionInventory($) {
  // Include footer shopify-sections — newsletter signup and trust strips often
  // live there and were previously skipped because "footer" matched chrome tokens.
  const sectionEls = $(
    [
      "[id^='shopify-section-']",
      ".shopify-section",
      "[data-section-type]",
      "[data-section-id]",
      "main > section",
      "main section[class]",
      "footer [id^='shopify-section-']",
      "footer .shopify-section",
      "footer [data-section-type]",
      "footer > section",
      "footer section[class]"
    ].join(", ")
  ).toArray();

  const seen = new Set();
  const inventory = [];

  for (const el of sectionEls) {
    const $el = $(el);
    // Skip content that lives inside an overlay/drawer — predictive search,
    // cart drawer, menu drawer, modal, popup, or anything hidden. e.g. the
    // predictive-search drawer's "SUGGESTED FOR YOU" product grid is search UI
    // present in the DOM of every page, NOT a real home-page section. Counting
    // it would falsely credit the page with a product showcase.
    if (
      $el.closest(
        "header, nav, [role='navigation'], [class*='mega-menu' i], [class*='mega_menu' i], [class*='predictive' i], [class*='search-drawer' i], [class*='drawer' i], [class*='modal' i], [class*='popup' i], [class*='cart' i], [hidden], [aria-hidden='true']"
      ).length
    ) {
      continue;
    }
    const id = $el.attr("id") || "";
    const dataType = $el.attr("data-section-type") || "";
    const className = $el.attr("class") || "";
    const idName = sectionNameFromId(id);

    const signals = [dataType, idName, className].filter(Boolean);
    if (!signals.length) continue;

    const headingText = ($el.find("h1, h2, h3, [class*='title' i], [class*='heading' i]").first().text() || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

    let type = classifySectionType(signals, headingText);

    // Content-based fallback for custom-built sections whose class names don't
    // match a known theme pattern (e.g. Rooted In's "shop by Concern" showcase
    // and its benefit marquee/trio). Without this they fall through to
    // unclassified and get dropped, which then makes a section that is clearly
    // PRESENT look missing — the cause of false "missing featured collection /
    // benefits" findings.
    if (!type && !sectionLooksLikeChrome(signals)) {
      const overlaySel =
        "header, nav, [class*='mega-menu' i], [class*='predictive' i], [class*='search-drawer' i], [class*='drawer' i], [class*='modal' i], [class*='popup' i], [class*='cart' i]";
      // (a) A section with multiple real product links is a product showcase.
      //     Category tiles link to /collections/ (not /products/), so they don't
      //     trigger this.
      const productLinks = $el
        .find("a[href*='/products/']")
        .filter((_, a) => $(a).closest(overlaySel).length === 0).length;
      if (productLinks >= 2) {
        type = "featuredProduct";
      } else {
        // (b) An icon/benefit row: several small images each paired with a short
        //     benefit phrase (icon grid or scrolling USP marquee).
        const imgCount = $el.find("img").length;
        const txt = ($el.text() || "").replace(/\s+/g, " ").trim();
        const headLc = headingText.toLowerCase();
        const benefitHeading =
          /\b(no nonsense|we deliver|why (us|choose|shop)|what you get|benefits?|how it works|results)\b/.test(headLc);
        if ((imgCount >= 3 && txt.length > 0 && txt.length < 400) || benefitHeading) {
          type = "benefits";
        }
      }
    }

    // Skip structural chrome only when we could not classify a content section.
    // Footer newsletter / USP rows often carry "footer" in class names.
    if (!type && sectionLooksLikeChrome(signals)) continue;
    if (!type) continue;

    // Avoid double-counting a section nested inside another content section.
    const nestedInContentSection = $el
      .parents("[id^='shopify-section-'], .shopify-section, [data-section-type]")
      .toArray()
      .some((p) => {
        const $p = $(p);
        const ps = [$p.attr("data-section-type"), sectionNameFromId($p.attr("id") || ""), $p.attr("class")]
          .filter(Boolean);
        const parentType = classifySectionType(ps, "");
        return Boolean(parentType) && parentType !== type;
      });
    if (nestedInContentSection) continue;

    const key = `${type}::${headingText.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    inventory.push({
      type,
      label: SECTION_TYPE_LABELS[type] || type,
      heading: headingText
    });
  }

  return inventory;
}

/**
 * Ground-truth digest of the page's real content sections: for every non-chrome
 * block in the main content, capture its heading and a short text snippet —
 * regardless of whether the classifier could TYPE it. This is fed to the model
 * (so it reasons from what's actually on the page, not just the detector's
 * verdict) and used to cross-check the missing-section analysis (so a section
 * the classifier mislabels can't be reported missing when its heading is right
 * there). Excludes header/nav/drawer/cart/modal chrome; keeps footer (newsletter).
 */
function extractSectionDigest($) {
  const overlaySel =
    "header, nav, [role='navigation'], [class*='mega-menu' i], [class*='predictive' i], [class*='search-drawer' i], [class*='drawer' i], [class*='modal' i], [class*='popup' i], [class*='cart' i], [hidden], [aria-hidden='true']";
  // Capture TOP-LEVEL content sections only. Selecting nested blocks (and
  // `main > div[class]`) floods the list with product tiles / sub-blocks from
  // the top of a long page, so a hard cap is hit BEFORE reaching real sections
  // at the bottom (e.g. brand story / testimonials) — which then get falsely
  // reported "missing" because the cross-check never saw their headings. Taking
  // only the outermost shopify-sections keeps the digest to ~1 entry per real
  // section, so the entire page (top to bottom) is represented.
  const blocks = $(
    "[id^='shopify-section-'], .shopify-section, [data-section-type], main > section"
  ).toArray();
  const digest = [];
  const seen = new Set();
  for (const el of blocks) {
    const $el = $(el);
    if ($el.closest(overlaySel).length) continue;
    // Outermost only: skip a block nested inside another section we already
    // capture (otherwise one rich section contributes many sub-block entries
    // and pushes later sections past the cap).
    if ($el.parents("[id^='shopify-section-'], .shopify-section, [data-section-type]").length) continue;
    const heading = cleanText(
      $el.find("h1,h2,h3,[class*='title' i],[class*='heading' i]").first().text()
    ).slice(0, 100);
    let snippet = cleanText($el.clone().find("script,style").remove().end().text())
      .replace(/\s+/g, " ")
      .slice(0, 160);
    if (!heading && !snippet) continue;
    const key = (heading + "|" + snippet).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    digest.push({ heading, text: snippet });
    if (digest.length >= 40) break;
  }
  return digest;
}

function extractSignals(url, html, runtimeHints = {}) {
  const $ = cheerio.load(html);
  const bodyText = cleanText($("body").text());
  const footerText = cleanText($("footer").text());
  // Keep footer copy in the feature-detection corpus — long home pages often
  // push newsletter / trust language below the 6k body slice.
  const text = `${bodyText.slice(0, 5500)} ${footerText}`.replace(/\s+/g, " ").trim().slice(0, 7500);
  const aboveFoldModule = detectAboveFoldModule($);

  // Run the comprehensive theme-agnostic feature detection.
  const featureDetection = detectFeatures($, html, url, runtimeHints, text);
  const themeInfo = detectThemeInfo(html, url);
  const themeName = detectThemeName(html);

  const headerText = cleanText($("header").first().text()).slice(0, 800);
  const footerTextSnippet = footerText.slice(0, 1200);
  const heroText = cleanText(
    $("main h1, [class*='banner' i] h1, [class*='hero' i] h1, [data-section-type*='hero'] h1, [data-section-type*='slideshow'] h1").first().text()
  );

  // CTA candidates: theme-agnostic. Look at actual buttons / known link copy.
  const ctaCandidates = [];
  $("button[name='add'], button[type='submit'][name*='add' i]").each((_, el) => {
    const t = cleanText($(el).text());
    if (t) ctaCandidates.push(t);
  });
  $("a[href]").each((_, el) => {
    const t = cleanText($(el).text());
    if (!t) return;
    if (/^(shop now|buy now|shop the|learn more|discover|explore|get started|order now|view all)$/i.test(t)) {
      ctaCandidates.push(t);
    }
  });

  // Derive at-a-glance booleans from featureDetection so existing downstream
  // code (signal aggregation, post-processing) keeps working.
  const f = featureDetection.features;
  const isPresent = (k) => f[k]?.present === true;
  const isAbsent = (k) => f[k]?.present === false;

  const links = $("a[href]")
    .map((_, a) => $(a).attr("href"))
    .get()
    .map((href) => abs(url, href))
    .filter((u) => /^https?:\/\//.test(u));

  const ogTitle = cleanText($("meta[property='og:title']").attr("content") || "");
  const metaTitle = cleanPageTitle(ogTitle || $("title").first().text());
  const metaDescription = cleanText($("meta[name='description']").attr("content") || "");
  const challengePage = isBotChallengePage(html, metaTitle);
  const pageType = classifyPage(url);

  // ── Observed literal values ──────────────────────────────────────────────
  // Concrete, quotable facts a human auditor would cite. These give the LLM
  // real strings to anchor findings to, instead of inventing generic ones.
  // Accuracy is capped by input richness: if the model can quote the actual
  // headline/CTA/price, it stops writing "lacks a compelling headline" filler.
  // Pick a real, VISIBLE hero headline. Skip accessibility skip-links and
  // visually-hidden text (e.g. "Skip to content") that would otherwise pollute
  // the evidence corpus and produce nonsense findings.
  let cleanHeadline = "";

  // Skip accessibility/hidden chrome AND the site logo/header region — the bare
  // <h1> on many homepages is the logo, not the hero copy. Picking it would
  // populate heroHeadline with the brand name and mask a genuinely weak hero.
  const EXCLUDE_CLOSEST =
    "[hidden], [aria-hidden='true'], [class*='visually-hidden' i], [class*='visuallyhidden' i], [class*='sr-only' i], [class*='skip' i], header, nav, [class*='header' i], [class*='logo' i], [class*='announcement' i]";
  // Shopify slideshow/section default labels that are NOT real hero copy — they
  // are theme placeholders (accessibility labels, empty block defaults). If these
  // leak through as the "headline" the report wrongly flags a generic hero.
  const PLACEHOLDER_HEADLINE =
    /^(image slide|slide\s*\d*|slideshow|image with text|button label|heading|talk about your brand|image\s*banner|rich text|collection list|featured collection|untitled|shop\s+(women|men|kids|denim|all|now|new|sale|the\s+collection|collection|bestsellers?|more|here)|women|men|denim)\.?$/i;
  // Short category-tile / CTA labels that get mistaken for a hero headline when
  // the real hero is an image banner — e.g. "SHOP WOMEN", "SHOP MEN", "SHOP NOW",
  // "SHOP DENIM", "VIEW ALL". These are navigation tiles, not value-prop copy.
  const CTA_TILE_HEADLINE =
    /^(shop|buy|view|explore|discover|browse|order)\b([\s\w'&-]{0,18})?$/i;
  const pickHeadline = (selector, minLen) => {
    $(selector).each((_, el) => {
      if (cleanHeadline) return;
      const $el = $(el);
      if ($el.closest(EXCLUDE_CLOSEST).length) return;
      if (/skip|visually-?hidden|sr-only|logo/i.test($el.attr("class") || "")) return;
      const t = cleanText($el.text());
      if (!t || t.length < minLen || t.length > 160) return;
      if (/^skip to (content|main|navigation)/i.test(t)) return;
      if (PLACEHOLDER_HEADLINE.test(t)) return; // theme placeholder, not real copy
      if (t.length <= 24 && CTA_TILE_HEADLINE.test(t)) return; // category/CTA tile, not a headline
      cleanHeadline = t;
    });
  };

  const heroScopes = ["[class*='banner' i]", "[class*='hero' i]", "[data-section-type*='hero']", "[data-section-type*='slideshow']"];

  // Pass 1: headings / explicit title classes INSIDE a hero/banner/slideshow.
  // This is the real hero copy and is tried before any global <h1> (the logo).
  const headingSels = ["h1", "h2", "h3", "[class*='title' i]", "[class*='heading' i]", "[class*='headline' i]"];
  pickHeadline(heroScopes.flatMap((s) => headingSels.map((h) => `${s} ${h}`)).join(", "), 6);

  // Pass 2: first substantive text block inside the hero (styled div/p heros).
  if (!cleanHeadline) {
    pickHeadline(heroScopes.flatMap((s) => [`${s} p`, `${s} div`]).join(", "), 12);
  }

  // Pass 3: an <h1> in main content (still excluding header/logo via closest()).
  if (!cleanHeadline) {
    pickHeadline("main h1, main h2", 6);
  }

  // Pass 4 (last resort): any <h1> not in header/logo — may be the logo on some
  // themes, but better than nothing for the evidence corpus.
  if (!cleanHeadline) {
    pickHeadline("h1", 3);
  }

  const heroHeadline =
    cleanHeadline ||
    (/^skip to /i.test(heroText) || PLACEHOLDER_HEADLINE.test(cleanText(heroText)) ? "" : heroText);
  // Hero subtext: the secondary line under/near the hero headline. The old
  // approach only worked when the subtext was a SIBLING of an <h1> inside a
  // hero/banner block. Many themes (e.g. Serman Brands: "Built To Last" →
  // "THE ONLY WALLET YOU NEED" → "Shop Now") don't nest it that way, so the
  // subtext came back empty and downstream guards couldn't fire. This version
  // is structure-agnostic: it scans the first hero/banner/slideshow container
  // for short text lines, drops the headline itself, nav/announcement/price
  // chrome, and CTA button text, and takes the first remaining line.
  let heroSubtext = cleanText(
    $("main h1, [class*='hero' i] h1, [class*='banner' i] h1, [data-section-type*='hero'] h1")
      .first()
      .nextAll("p, h2, [class*='subtitle' i], [class*='subheading' i], [class*='text' i]")
      .first()
      .text()
  ).slice(0, 200);

  if (!heroSubtext) {
    const heroScope = $(
      "[class*='hero' i], [class*='banner' i], [class*='slideshow' i], [data-section-type*='hero' i], [data-section-type*='slideshow' i], [data-section-type*='banner' i]"
    ).first();
    const scope = heroScope.length ? heroScope : $("main").first();
    const headlineNorm = cleanText(heroHeadline).toLowerCase();
    // When there is no classed hero wrapper (e.g. Serman Brands: bare text lines
    // after the hero <img>), we must also read leaf <div>/<span> nodes — but
    // main also contains the country/currency selector, cart, and product cards,
    // so exclude those explicitly and stop once a section heading begins.
    const EXCLUDE_CLOSEST =
      "header, nav, [role='navigation'], [class*='announcement' i], [class*='nav' i], [class*='localization' i], [class*='country' i], [class*='currency' i], [class*='cart' i], [class*='drawer' i], [class*='menu' i], [class*='footer' i], form, [hidden], [aria-hidden='true'], [class*='visually-hidden' i], [class*='sr-only' i], [class*='skip' i]";
    const candidates = [];
    let hitSectionHeading = false;
    scope
      .find("h2, h3, p, div, span, li, [class*='subtitle' i], [class*='subheading' i], [class*='subhead' i], [class*='tagline' i], [class*='text' i], [class*='caption' i]")
      .slice(0, 120)
      .each((_, el) => {
        if (hitSectionHeading) return;
        const $el = $(el);
        // Stop scanning once we reach a section heading like "Best Sellers"
        // (everything after is product grid / merchandising, not hero subtext).
        if (/^h2$/i.test(el.tagName || "") && cleanText($el.text())) {
          hitSectionHeading = true;
          return;
        }
        if ($el.children().length > 0) return; // leaf nodes only (own text)
        if ($el.closest(EXCLUDE_CLOSEST).length) return;
        const t = cleanText($el.text());
        if (!t || t.length < 6 || t.length > 160) return;
        const tl = t.toLowerCase();
        if (headlineNorm && (tl === headlineNorm || headlineNorm.includes(tl) || tl.includes(headlineNorm))) return;
        if (isJunkCtaLabel(t)) return; // skip "Shop Now"/"Add to cart" style button text
        if (/^\s*(shop|buy|add|learn|explore|view|get|order|discover|sale price|regular price)\b/i.test(t) && t.length <= 24) return;
        if (/\([A-Z]{2,3}[\s)]|\b(USD|EUR|GBP|CAD|AUD|INR|JPY|AED|SGD)\b\s*[$€£]|©|cookie|skip to|free shipping/i.test(t)) return; // locale/currency/announcement chrome
        candidates.push(t);
      });
    heroSubtext = (candidates[0] || "").slice(0, 200);
  }

  const ctaLabels = [];
  $("a[class*='button' i], button, a[class*='btn' i], [class*='hero' i] a, [class*='banner' i] a")
    .slice(0, 40)
    .each((_, el) => {
      const $el = $(el);
      // Skip hidden / accessibility-only / skip-link elements (same rule the
      // hero-headline picker uses) so locale & a11y chrome never becomes a CTA.
      if (
        $el.closest(
          "[hidden], [aria-hidden='true'], [class*='visually-hidden' i], [class*='visuallyhidden' i], [class*='sr-only' i], [class*='skip' i]"
        ).length
      )
        return;
      const t = cleanText($el.text());
      if (isJunkCtaLabel(t)) return;
      ctaLabels.push(t);
    });

  const navLabels = [];
  $("header nav a, [role='navigation'] a, [class*='nav' i] a")
    .slice(0, 40)
    .each((_, el) => {
      const t = cleanText($(el).text());
      if (t && t.length <= 30) navLabels.push(t);
    });

  const announcementText = extractAnnouncementText($);

  // Price string (most relevant on product pages). Uses extractPriceText to
  // target the price value and strip visually-hidden "Regular price"/"Sale
  // price" labels that previously produced garbled quotes.
  const priceText = extractPriceText($);

  // Rendered review count, e.g. "128 reviews".
  const reviewCountMatch = text.match(/(\d[\d,]*)\s+reviews?\b/i);
  const reviewCountText = reviewCountMatch ? reviewCountMatch[0] : "";

  const productGalleryImageCount =
    pageType === "product"
      ? $(
          "[class*='gallery' i] img, [class*='product__media' i] img, [class*='product-media' i] img, [class*='product__photo' i] img"
        ).length
      : null;

  const collectionCardCount =
    pageType === "collection"
      ? $(
          "[class*='product-card' i], [class*='product-item' i], [class*='card-wrapper' i], [class*='grid__item' i]"
        ).length
      : null;

  const observed = {
    heroHeadline,
    heroSubtext,
    ctaLabels: Array.from(new Set(ctaLabels)).slice(0, 10),
    navLabels: Array.from(new Set(navLabels)).slice(0, 12),
    announcementText,
    priceText,
    reviewCountText,
    productGalleryImageCount,
    collectionCardCount,
    sections: extractSectionInventory($),
    sectionDigest: extractSectionDigest($),
    features: summarizeObservedFeatures(f)
  };

  return {
    pageType,
    title: metaTitle,
    url,
    challengePage,
    heroText,
    headerText,
    footerText: footerTextSnippet,
    ctaCandidates: Array.from(new Set(ctaCandidates)).slice(0, 8),
    themeName: themeName || "",
    themeInfo: themeInfo || null,
    flags: {
      // Legacy flag names derived from the new featureDetection.
      // Downstream code (aggregateDetectedSignals etc.) reads from here.
      hasReviews:               isPresent("reviews"),
      hasUgc:                   /\binstagram|tiktok|user-generated|customer photos?\b/i.test(text),
      hasTrust:                 isPresent("trustSignals"),
      hasTrustStrip:            isPresent("trustSignals"),
      hasStickyHeaderHint:      isPresent("stickyHeader"),
      hasStickyHeaderDetected:  Boolean(runtimeHints.stickyHeader),
      hasWishlist:              isPresent("wishlist"),
      hasLiveChat:              isPresent("liveChat") || Boolean(runtimeHints.hasFloatingChatButton),
      smallFontRisk:            /font-size:\s*(10|11|12)px/i.test(html),
      hasHeroSection:           isPresent("heroSection") || Boolean(aboveFoldModule?.selector),
      hasCollectionFilter:      isPresent("filtering"),
      hasCollectionSort:        isPresent("sort"),
      hasProductMediaZoom:      isPresent("productMediaZoom"),
      hasQuickView:             isPresent("quickView"),
      hasCartDrawer:            isPresent("cartDrawer"),
      hasStickyAddToCart:       isPresent("stickyAddToCart"),
      hasBackToTop:             isPresent("backToTop"),
      hasStockIndicator:        isPresent("stockIndicator"),
      hasBackInStockNotify:     isPresent("backInStockNotify"),
      hasNewsletterSignup:      isPresent("newsletterSignup"),
      hasBreadcrumbs:           isPresent("breadcrumbs"),
      hasProductVideo:          isPresent("productVideo"),
      hasSizeGuide:             isPresent("sizeGuide"),
      hasRelatedProducts:       isPresent("relatedProducts"),
      hasRecentlyViewed:        isPresent("recentlyViewed"),
      hasMobileMenu:            isPresent("mobileMenuToggle"),
      hasCurrencySelector:      isPresent("currencySelector"),
      hasLanguageSelector:      isPresent("languageSelector"),
      hasFreeShippingBar:       isPresent("freeShippingBar"),
      hasAnnouncementBar:       isPresent("announcementBar"),
      hasVariantSwatches:       isPresent("variantSwatches"),
      hasSearchBar:             isPresent("searchBar"),
      hasMegaMenu:              isPresent("megaMenu"),
      // Confirmed-absent counterparts (high-confidence "no"). Used by the
      // post-processor to distinguish "uncertain" from "definitely missing".
      confirmedNoStickyHeader:  isAbsent("stickyHeader"),
      confirmedNoCartDrawer:    isAbsent("cartDrawer"),
      // Lightweight metadata flags
      hasMetaTitle:        metaTitle.length > 0,
      hasMetaDescription:  metaDescription.length > 0,
      hasCanonical:        Boolean($("link[rel='canonical']").length),
      hasOpenGraph:        Boolean($("meta[property^='og:']").length),
      hasStructuredData:   Boolean($("script[type='application/ld+json']").length),
      hasLazyLoading:      isPresent("lazyLoading"),
      imageCount:          $("img").length,
      scriptCount:         $("script").length,
      cssCount:            $("link[rel='stylesheet']").length
    },
    // Full feature-detection matrix (with evidence and confidence) — this is
    // what the prompt builder uses to construct accurate PRESENT/ABSENT lists.
    featureDetection,
    observed,
    textSnippet: text,
    aboveFoldModule,
    aboveFoldScreenshotPath: "",
    links,
    metaDescription
  };
}

/**
 * Runtime checks done inside the page context — these catch behaviours that
 * cannot be inferred from static HTML alone. Returns `tested: true|false` so
 * the static fallback knows whether to trust an absent signal as
 * "actually missing" vs "we just couldn't test".
 */
async function detectRuntimeHints(page) {
  try {
    const result = await page.evaluate(async () => {
      const result = {
        stickyHeaderTested: false,
        stickyHeader: false,
        hasFloatingChatButton: false,
        productCardHoverTested: false,
        productCardHoverChanges: false,
        quickAddRevealedOnHover: false
      };

      // ----- Sticky header probe -----
      const pickHeader = () =>
        document.querySelector("header") ||
        document.querySelector("[role='banner']") ||
        document.querySelector("[id*='shopify-section-header']") ||
        document.querySelector("[class*='header' i]");

      const header = pickHeader();
      if (header) {
        const beforeRect = header.getBoundingClientRect();
        const beforeStyle = window.getComputedStyle(header);
        const wasAtTop = Math.abs(beforeRect.top) <= 5;

        // Scroll a meaningful distance — many themes only attach sticky
        // behaviour after the page has scrolled past the original header height.
        const scrollTarget = Math.min(
          Math.max(window.innerHeight, 800),
          Math.max(document.body.scrollHeight - window.innerHeight, 100)
        );
        window.scrollTo({ top: scrollTarget, behavior: "instant" });
        await new Promise((r) => setTimeout(r, 300));

        const afterRect = header.getBoundingClientRect();
        const afterStyle = window.getComputedStyle(header);
        const usesStickyStyle =
          /sticky|fixed/i.test(beforeStyle.position || "") ||
          /sticky|fixed/i.test(afterStyle.position || "");
        const remainsPinned = Math.abs(afterRect.top) <= 5;
        const movedAway = afterRect.top < -20;

        result.stickyHeaderTested = wasAtTop;
        result.stickyHeader = Boolean(
          usesStickyStyle || (wasAtTop && remainsPinned && !movedAway)
        );
        // Restore scroll so subsequent screenshots are taken from the top.
        window.scrollTo({ top: 0, behavior: "instant" });
        await new Promise((r) => setTimeout(r, 100));
      }

      // ----- Floating chat / launcher button -----
      // Many chat widgets render a fixed-position bubble in a corner.
      try {
        const fixedFloaters = Array.from(document.querySelectorAll("body *")).filter((el) => {
          try {
            const cs = window.getComputedStyle(el);
            if (cs.position !== "fixed") return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < 30 || rect.width > 200) return false;
            if (rect.height < 30 || rect.height > 200) return false;
            const nearBottom = window.innerHeight - rect.bottom < 80;
            const nearSide = rect.left < 60 || window.innerWidth - rect.right < 60;
            return nearBottom && nearSide;
          } catch {
            return false;
          }
        });
        result.hasFloatingChatButton = fixedFloaters.length > 0;
      } catch {
        // ignore
      }

      // ----- Product-card hover probe -----
      // This addresses a specific merchant complaint: the audit kept saying
      // "no hover state on product cards" when there clearly was one. We pick
      // the first card-like element, simulate mouseenter, and check whether
      // (a) any descendant element changed visibility or opacity, or
      // (b) any new image source became visible.
      try {
        const cardCandidates = Array.from(
          document.querySelectorAll(
            "[class*='product-card' i], [class*='product-item' i], [class*='grid-product' i], [class*='card-product' i], [class*='product__card' i], [class*='product-grid__item' i], li.grid__item[class*='product' i]"
          )
        ).slice(0, 3);

        if (cardCandidates.length) {
          result.productCardHoverTested = true;

          const captureSnapshot = (card) => {
            const descendants = Array.from(card.querySelectorAll("*")).slice(0, 80);
            return descendants.map((el) => {
              const cs = window.getComputedStyle(el);
              return {
                opacity: parseFloat(cs.opacity || "1"),
                visibility: cs.visibility,
                display: cs.display,
                transform: cs.transform,
                bgImg: cs.backgroundImage,
                srcAttr: el.tagName === "IMG" ? (el.currentSrc || el.src || "") : ""
              };
            });
          };

          let anyChange = false;
          let quickAddRevealed = false;

          for (const card of cardCandidates) {
            const before = captureSnapshot(card);

            // Trigger pointer + mouse events that most themes listen for.
            const enter = new MouseEvent("mouseenter", { bubbles: true });
            const over = new MouseEvent("mouseover", { bubbles: true });
            card.dispatchEvent(enter);
            card.dispatchEvent(over);
            try {
              // Some themes use :hover CSS; we can't fake true :hover from
              // page.evaluate but we can poll for animation transitions to
              // settle. The runtime hover from page.hover() (above the eval)
              // will already have been applied by the caller for the FIRST
              // card.
            } catch {}
            await new Promise((r) => setTimeout(r, 350));

            const after = captureSnapshot(card);

            for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
              const b = before[i];
              const a = after[i];
              const opacityChanged = Math.abs((a.opacity || 0) - (b.opacity || 0)) > 0.05;
              const visibilityChanged = a.visibility !== b.visibility;
              const displayChanged = a.display !== b.display;
              const transformChanged = a.transform !== b.transform;
              const bgChanged = a.bgImg !== b.bgImg;
              const srcChanged = a.srcAttr && b.srcAttr && a.srcAttr !== b.srcAttr;
              if (
                opacityChanged || visibilityChanged || displayChanged ||
                transformChanged || bgChanged || srcChanged
              ) {
                anyChange = true;
                break;
              }
            }

            // Look for newly-visible quick-add / quick-view buttons
            const qa = card.querySelector(
              "[class*='quick-add' i], [class*='quickadd' i], [class*='quick-view' i], [class*='quickview' i], [class*='quick-shop' i], [class*='quickshop' i], [data-quick-add], [data-quickadd], [data-quick-view]"
            );
            if (qa) {
              const cs = window.getComputedStyle(qa);
              const visible =
                cs.display !== "none" &&
                cs.visibility !== "hidden" &&
                parseFloat(cs.opacity || "1") > 0.1;
              if (visible) quickAddRevealed = true;
            }

            // Leave hover state for next card iteration
            const leave = new MouseEvent("mouseleave", { bubbles: true });
            const out = new MouseEvent("mouseout", { bubbles: true });
            card.dispatchEvent(leave);
            card.dispatchEvent(out);
            await new Promise((r) => setTimeout(r, 100));

            if (anyChange && quickAddRevealed) break;
          }

          result.productCardHoverChanges = anyChange;
          result.quickAddRevealedOnHover = quickAddRevealed;
        }
      } catch {
        // ignore — keep defaults
      }

      return result;
    });

    // Augment with a REAL browser hover (triggers CSS :hover, which the
    // synthetic events above cannot). This is what lets the detector reliably
    // tell "no hover state" from "CSS-only hover state".
    result.productCardHoverRealHover = false;
    try {
      const real = await probeCardHoverReal(page);
      if (real && real.tested) {
        result.productCardHoverRealHover = true;
        result.productCardHoverTested = true;
        if (real.changed) result.productCardHoverChanges = true;
        if (real.quickAddRevealed) result.quickAddRevealedOnHover = true;
      }
    } catch {
      // ignore — keep synthetic-probe values
    }

    return result;
  } catch {
    return {
      stickyHeaderTested: false,
      stickyHeader: false,
      hasFloatingChatButton: false,
      productCardHoverTested: false,
      productCardHoverChanges: false,
      productCardHoverRealHover: false,
      quickAddRevealedOnHover: false
    };
  }
}

/**
 * Real-hover probe for product-card hover behaviour. The synthetic MouseEvents
 * dispatched inside detectRuntimeHints CANNOT trigger the CSS :hover pseudo-class,
 * which is how most Shopify themes implement the secondary-image swap / overlay
 * reveal. This uses Playwright's page.hover() (a true pointer hover) so :hover
 * actually applies, then diffs computed styles / image sources before vs. after.
 *
 * Returns { tested, changed, quickAddRevealed }. `tested` is true only when a
 * real card was found and hovered — that is the signal the detector needs before
 * it is allowed to conclude hover is genuinely absent.
 */
async function probeCardHoverReal(page) {
  const cardSel =
    "[class*='product-card' i], [class*='product-item' i], [class*='grid-product' i], [class*='card-product' i], [class*='product__card' i], [class*='product-grid__item' i], [class*='card-wrapper' i], li.grid__item, [class*='card' i]";
  try {
    const prepared = await page.evaluate((sel) => {
      const fingerprint = (card) =>
        Array.from(card.querySelectorAll("*")).slice(0, 100).map((el) => {
          const cs = window.getComputedStyle(el);
          return [
            cs.opacity, cs.visibility, cs.display, cs.transform, cs.backgroundImage,
            el.tagName === "IMG" ? (el.currentSrc || el.src || "") : ""
          ].join("|");
        });
      const cards = Array.from(document.querySelectorAll(sel)).filter((c) => c.querySelector("a[href*='/products/' i]"));
      const card = cards[0];
      if (!card) return false;
      card.setAttribute("data-cro-hovertarget", "1");
      window.__croHoverBefore = fingerprint(card);
      return true;
    }, cardSel);
    if (!prepared) return { tested: false, changed: false, quickAddRevealed: false };

    try {
      await page.hover("[data-cro-hovertarget='1']", { timeout: 2000 });
    } catch {
      await page.evaluate(() => {
        const c = document.querySelector("[data-cro-hovertarget='1']");
        if (c) c.removeAttribute("data-cro-hovertarget");
      });
      return { tested: false, changed: false, quickAddRevealed: false };
    }
    await new Promise((r) => setTimeout(r, 400)); // let transitions settle

    return await page.evaluate(() => {
      const card = document.querySelector("[data-cro-hovertarget='1']");
      if (!card) return { tested: false, changed: false, quickAddRevealed: false };
      const fingerprint = (c) =>
        Array.from(c.querySelectorAll("*")).slice(0, 100).map((el) => {
          const cs = window.getComputedStyle(el);
          return [
            cs.opacity, cs.visibility, cs.display, cs.transform, cs.backgroundImage,
            el.tagName === "IMG" ? (el.currentSrc || el.src || "") : ""
          ].join("|");
        });
      const before = window.__croHoverBefore || [];
      const after = fingerprint(card);
      let changed = false;
      for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
        if (before[i] !== after[i]) { changed = true; break; }
      }
      const qa = card.querySelector(
        "[class*='quick-add' i], [class*='quickadd' i], [class*='quick-view' i], [class*='quickview' i], [class*='quick-shop' i], [class*='overlay' i], [class*='card__actions' i]"
      );
      let quickAddRevealed = false;
      if (qa) {
        const cs = window.getComputedStyle(qa);
        quickAddRevealed = cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.1;
      }
      card.removeAttribute("data-cro-hovertarget");
      delete window.__croHoverBefore;
      return { tested: true, changed, quickAddRevealed };
    });
  } catch {
    return { tested: false, changed: false, quickAddRevealed: false };
  }
}

/** Equal number of collection + product pages to crawl (excluding home). */
export const DEFAULT_PAGES_PER_TYPE = 2;

export function getCoreStorefrontPageBudget(pagesPerType = DEFAULT_PAGES_PER_TYPE) {
  const each = Math.max(1, Number(pagesPerType) || DEFAULT_PAGES_PER_TYPE);
  return 1 + each * 2;
}

function resolveCrawlTargets(options = {}) {
  const each = Math.max(1, Number(options.pagesPerType) || DEFAULT_PAGES_PER_TYPE);
  return { each };
}

function isBotChallengePage(html, title = "") {
  const sample = `${title} ${String(html || "").slice(0, 12000)}`;
  return /verifying your connection|cf-browser-verification|challenge-platform|checking your browser|just a moment|attention required/i.test(
    sample
  );
}

/**
 * Keep collection and product counts balanced (e.g. 2 + 2, not 1 + 4).
 * - Queue collections while count < target and collections <= products.
 * - Queue products while count < target and products < collections, OR tied pair under target.
 */
function shouldQueueBalanced(type, stats, targetEach) {
  const col = stats.collection || 0;
  const prod = stats.product || 0;

  if (type === "collection") {
    return col < targetEach && col <= prod;
  }

  if (type === "product") {
    if (prod >= targetEach) return false;
    if (prod < col) return true;
    if (prod === col && col < targetEach) return false;
    return false;
  }

  return true;
}

function shouldQueueLink(
  startUrl,
  link,
  stats = {},
  targets = resolveCrawlTargets(),
  additionalPageKeys = new Set()
) {
  const sameDomain = new URL(link).hostname === new URL(startUrl).hostname;
  if (!sameDomain) return false;

  if (/\/collections\//i.test(link)) {
    return shouldQueueBalanced("collection", stats, targets.each);
  }
  if (/\/products\//i.test(link)) {
    return shouldQueueBalanced("product", stats, targets.each);
  }

  return isRequestedAdditionalPage(link, additionalPageKeys);
}

function buildAdditionalPageKeySet(additionalPageUrls = []) {
  return new Set(
    additionalPageUrls.map((u) => canonicalUrlKey(u)).filter(Boolean)
  );
}

function isRequestedAdditionalPage(link, additionalPageKeys = new Set()) {
  const key = canonicalUrlKey(link);
  return Boolean(key && additionalPageKeys.has(key));
}

function queueUrlType(startUrl, link, additionalPageKeys = new Set()) {
  if (urlsEquivalent(link, startUrl)) return "home";
  if (/\/collections\//i.test(link)) return "collection";
  if (/\/products\//i.test(link)) return "product";
  if (isRequestedAdditionalPage(link, additionalPageKeys)) return "additional";
  return "other";
}

function classifyQueuePriority(
  startUrl,
  link,
  additionalPageKeys = new Set(),
  stats = {},
  targets = resolveCrawlTargets()
) {
  const type = queueUrlType(startUrl, link, additionalPageKeys);
  const targetEach = targets.each;
  const col = stats.collection || 0;
  const prod = stats.product || 0;

  if (type === "home") return 0;

  const collectionsBehind = col < prod;
  const productsBehind = prod < col;
  const needCollection = col < targetEach && col <= prod;
  const needProduct = prod < targetEach && prod < col;

  if (type === "collection") {
    if (col >= targetEach) return 6;
    if (collectionsBehind || (col === prod && needCollection)) return 1;
    return 3;
  }

  if (type === "product") {
    if (prod >= targetEach) return 6;
    if (productsBehind || needProduct) return 1;
    if (col === prod && prod < targetEach) return 4;
    return 5;
  }

  if (type === "additional") return 2;
  return 5;
}

function enqueueByPriority(
  queue,
  queued,
  startUrl,
  link,
  additionalPageKeys = new Set(),
  stats = {},
  targets = resolveCrawlTargets()
) {
  if (!link || queued.has(link)) return;
  const incomingPriority = classifyQueuePriority(startUrl, link, additionalPageKeys, stats, targets);
  let idx = queue.findIndex(
    (u) => classifyQueuePriority(startUrl, u, additionalPageKeys, stats, targets) > incomingPriority
  );
  if (idx === -1) idx = queue.length;
  queue.splice(idx, 0, link);
  queued.add(link);
}

function sortQueueByPriority(
  queue,
  startUrl,
  additionalPageKeys = new Set(),
  stats = {},
  targets = resolveCrawlTargets()
) {
  queue.sort(
    (a, b) =>
      classifyQueuePriority(startUrl, a, additionalPageKeys, stats, targets) -
      classifyQueuePriority(startUrl, b, additionalPageKeys, stats, targets)
  );
}

function purgeQueueMatching(queue, queued, predicate) {
  let removed = 0;
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const url = queue[i];
    if (!predicate(url)) continue;
    queue.splice(i, 1);
    queued.delete(url);
    removed += 1;
  }
  return removed;
}

/** After bot protection on product URLs, drop remaining product queue items. */
function handleBotProtectionOnCrawl(crawlGuard, url, queue, queued) {
  crawlGuard.blockedAttempts += 1;
  if (/\/products\//i.test(url)) {
    crawlGuard.productUrlsBlocked = true;
    const removed = purgeQueueMatching(queue, queued, (u) => /\/products\//i.test(u));
    if (removed > 0) {
      console.log(
        `Removed ${removed} product URL(s) from crawl queue after bot protection (${url})`
      );
    }
  }
  return crawlGuard.blockedAttempts >= crawlGuard.maxBlockedAttempts;
}

function enqueueDiscoveredLinks(queue, queued, startUrl, signal, stats, additionalPageKeys, targets) {
  const collectionLinks = [];
  const productLinks = [];
  const otherLinks = [];

  for (const link of signal.links || []) {
    if (!shouldQueueLink(startUrl, link, stats, targets, additionalPageKeys)) continue;
    const linkKey = visitKeyForUrl(link);
    if (!linkKey || queued.has(link)) continue;
    if (/\/collections\//i.test(link)) collectionLinks.push(link);
    else if (/\/products\//i.test(link)) productLinks.push(link);
    else otherLinks.push(link);
  }

  for (const link of [...collectionLinks, ...productLinks, ...otherLinks]) {
    enqueueByPriority(queue, queued, startUrl, link, additionalPageKeys, stats, targets);
  }
}

function applyCrawlStats(signal, stats) {
  if (signal.pageType === "general") stats.home += 1;
  if (signal.pageType === "collection") stats.collection += 1;
  if (signal.pageType === "product") stats.product += 1;
}

function pageAlreadyCrawled(pages, url) {
  const key = crawlCanonicalUrlKey(url);
  return pages.some((p) => crawlCanonicalUrlKey(p.url) === key);
}

function visitKeyForUrl(url) {
  return crawlCanonicalUrlKey(url) || canonicalUrlKey(url) || url;
}

function isRequestedAdditionalUrl(url, additionalPageUrls = []) {
  return additionalPageUrls.some((requested) => urlsEquivalent(url, requested));
}

function notifyPageCrawl(onPageCrawled, event) {
  if (typeof onPageCrawled !== "function") return;
  try {
    onPageCrawled(event);
  } catch (error) {
    console.log(`onPageCrawled callback failed: ${error.message}`);
  }
}

/**
 * Navigate to a URL robustly and give JS-rendered themes a chance to paint
 * their real content before we read the DOM.
 *
 * Returns { ok, thin, reason }:
 *   ok   - navigation reached the page (even if lenient retry was needed)
 *   thin - the page loaded but rendered very little real content (likely a
 *          JS-render or bot wall); the caller should mark it "could not be
 *          fully assessed" and avoid confident absence findings.
 * The previous behaviour (waitUntil "domcontentloaded", 15s, no JS wait) made
 * JS-heavy stores look empty, which produced confident-but-wrong "missing
 * section" findings. We now allow more time, wait for the network/content to
 * settle, and retry once leniently before giving up.
 */
async function resilientGoto(page, url, { timeout = 45000 } = {}) {
  let reached = false;
  let reason = "";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    reached = true;
  } catch (err) {
    reason = (err && err.message) || "navigation error";
    // Retry once leniently — many timeouts are slow third-party scripts, not a
    // failure to deliver the document.
    try {
      await page.goto(url, { waitUntil: "commit", timeout: Math.round(timeout / 2) });
      reached = true;
      reason = "recovered via lenient retry";
    } catch (err2) {
      return { ok: false, thin: true, reason: (err2 && err2.message) || reason };
    }
  }

  // Give JS-rendered content a chance to paint. Best-effort: settle the network,
  // then wait briefly for a real content node (product grid / sections / main).
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    /* networkidle can legitimately never fire on chatty stores — ignore */
  }
  try {
    await page.waitForSelector(
      "main, [class*='product' i], [class*='collection' i], [class*='section' i], [id*='section' i]",
      { timeout: 6000 }
    );
  } catch {
    /* no recognisable content node appeared in time */
  }

  // Force lazy-loaded sections to render. Many Shopify themes only mount
  // below-the-fold sections (benefits strips, testimonials, brand story) when
  // they scroll into view via IntersectionObserver / lazy images. Without this
  // pass those sections never paint, so the crawl reads them as "missing" when
  // they actually exist — the core "home not crawled properly" failure. We step
  // down the full page, let each step settle, then return to the top.
  try {
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const step = Math.max(400, Math.floor(window.innerHeight * 0.85));
      let y = 0;
      const maxScroll = () =>
        Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
      // Cap iterations so a page that grows on scroll can't loop forever.
      for (let i = 0; i < 40 && y < maxScroll(); i++) {
        window.scrollTo(0, y);
        y += step;
        await sleep(250);
      }
      window.scrollTo(0, maxScroll());
      await sleep(400);
      window.scrollTo(0, 0);
      await sleep(200);
    });
    // Let anything triggered by the scroll finish loading.
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      /* ignore */
    }
  } catch {
    /* scrolling is best-effort */
  }

  // Heuristic thin-crawl check: very little rendered text usually means the
  // theme rendered client-side and we caught it empty, or a bot wall.
  let thin = false;
  try {
    const textLen = await page.evaluate(() => (document.body?.innerText || "").trim().length);
    thin = textLen < 600;
    if (thin && !reason) reason = `thin render (${textLen} chars of visible text)`;
  } catch {
    /* evaluate failed — leave thin as-is */
  }

  return { ok: reached, thin, reason };
}

function emitCrawlStarted(onPageCrawled, startUrl, url, additionalPageKeys, order) {
  notifyPageCrawl(onPageCrawled, {
    status: "crawling",
    url,
    pageKey: visitKeyForUrl(url),
    pageType: queueUrlType(startUrl, url, additionalPageKeys),
    order
  });
}

function emitCrawlFinished(onPageCrawled, signal, order, additionalPageUrls = []) {
  notifyPageCrawl(onPageCrawled, {
    status: "done",
    url: signal.url,
    pageKey: visitKeyForUrl(signal.url),
    title: signal.title || "",
    pageType: signal.pageType || "general",
    order,
    requestedAsAdditional: isRequestedAdditionalUrl(signal.url, additionalPageUrls),
    themeInfo: signal.themeInfo || null
  });
}

async function fetchPageSignals(startUrl, url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
  });
  if (!res.ok) {
    return { ok: false, status: res.status, shopifyDetected: false, signal: null };
  }
  const html = await res.text();
  const shopifyDetected =
    detectShopifyFromHtml(html) || detectShopifyFromResponseHeaders(res.headers);
  const signal = extractSignals(url, html);
  signal.screenshotPath = "";
  signal.aboveFoldScreenshotPath = "";
  signal.sectionScreenshots = {};
  return { ok: true, shopifyDetected, signal };
}

async function ensureAdditionalPagesCrawled({
  startUrl,
  additionalPageUrls = [],
  additionalPageKeys = new Set(),
  pages,
  visited,
  stats,
  onPageCrawled,
  targets = resolveCrawlTargets()
}) {
  let shopifyDetected = false;

  for (const requestedUrl of additionalPageUrls) {
    if (pageAlreadyCrawled(pages, requestedUrl)) continue;

    const key = canonicalUrlKey(requestedUrl);
    if (key) visited.add(key);

    console.log(`Fetching requested additional page: ${requestedUrl}`);
    emitCrawlStarted(
      onPageCrawled,
      startUrl,
      requestedUrl,
      additionalPageKeys,
      pages.length + 1
    );

    try {
      const { ok, shopifyDetected: detected, signal, status } = await fetchPageSignals(
        startUrl,
        requestedUrl
      );
      if (!ok) {
        console.log(`HTTP ${status} for additional page: ${requestedUrl}`);
        continue;
      }
      if (detected) {
        shopifyDetected = true;
        console.log(`Shopify store detected at additional page: ${requestedUrl}`);
      }
      if (signal.challengePage) {
        console.log(`Bot challenge on additional page, skipping: ${requestedUrl}`);
        continue;
      }
      pages.push(signal);
      applyCrawlStats(signal, stats);
      emitCrawlFinished(onPageCrawled, signal, pages.length, additionalPageUrls);
      console.log(`Successfully fetched additional page: ${requestedUrl} (${signal.pageType})`);
    } catch (error) {
      console.log(`Failed to fetch additional page: ${requestedUrl} - ${error.message}`);
    }
  }

  return { shopifyDetected };
}

async function ensureAdditionalPagesCrawledWithBrowser({
  startUrl,
  additionalPageUrls = [],
  additionalPageKeys = new Set(),
  pages,
  visited,
  stats,
  page,
  screenshotDir,
  sectionScreenshotDir,
  onPageCrawled,
  targets = resolveCrawlTargets()
}) {
  let shopifyDetected = false;

  for (const requestedUrl of additionalPageUrls) {
    if (pageAlreadyCrawled(pages, requestedUrl)) continue;

    const key = canonicalUrlKey(requestedUrl);
    if (key) visited.add(key);

    console.log(`Crawling requested additional page: ${requestedUrl}`);
    emitCrawlStarted(
      onPageCrawled,
      startUrl,
      requestedUrl,
      additionalPageKeys,
      pages.length + 1
    );

    try {
      const nav = await resilientGoto(page, requestedUrl, { timeout: 45000 });
      if (!nav.ok) console.log(`Navigation failed for additional page ${requestedUrl}: ${nav.reason}`);
      const html = await page.content();
      const detected = detectShopifyFromHtml(html);
      if (detected) {
        shopifyDetected = true;
        console.log(`Shopify store detected at additional page: ${requestedUrl}`);
      }

      const runtimeHints = await detectRuntimeHints(page);
      const signal = extractSignals(requestedUrl, html, runtimeHints);
      signal.screenshotPath = await saveScreenshotIfEnabled(
        page,
        signal,
        pages.length,
        screenshotDir
      );
      signal.aboveFoldScreenshotPath = await saveAboveFoldScreenshotIfEnabled(
        page,
        signal,
        pages.length,
        screenshotDir
      );
      signal.sectionScreenshots = await saveSectionScreenshotsIfEnabled(
        page,
        signal,
        pages.length,
        sectionScreenshotDir || screenshotDir
      );
      if (signal.challengePage) {
        console.log(`Bot challenge on additional page, skipping: ${requestedUrl}`);
        continue;
      }
      signal.crawlThin = Boolean(nav && nav.thin);
      if (nav && nav.reason) signal.crawlReason = nav.reason;
      pages.push(signal);
      applyCrawlStats(signal, stats);
      emitCrawlFinished(onPageCrawled, signal, pages.length, additionalPageUrls);
      console.log(`Successfully crawled additional page: ${requestedUrl} (${signal.pageType})`);
    } catch (error) {
      console.log(`Failed to crawl additional page: ${requestedUrl} - ${error.message}`);
    }
  }

  return { shopifyDetected };
}

function detectShopifyFromHtml(html) {
  return /shopify|cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme|fonts\.shopifycdn\.com|x-shopify-/i.test(
    String(html || "")
  );
}

function detectShopifyFromResponseHeaders(headers) {
  if (!headers) return false;
  if (headers.get("shopify-complexity-score") || headers.get("shopify-complexity-score-v2")) {
    return true;
  }
  const linkHeader = headers.get("link") || "";
  if (/cdn\.shopify\.com/i.test(linkHeader)) return true;
  const cookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : String(headers.get("set-cookie") || "")
          .split(/,(?=\s*[^;]+=)/)
          .filter(Boolean);
  return cookies.some((c) => /_shopify/i.test(c));
}

/** Lightweight probe — works when Playwright only sees bot-challenge HTML. */
export async function probeShopifyStore(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml"
      },
      redirect: "follow"
    });
    if (detectShopifyFromResponseHeaders(res.headers)) return true;
    const html = await res.text();
    return detectShopifyFromHtml(html);
  } catch {
    return false;
  }
}

export function inferShopifyFromCrawledPages(pages = []) {
  return pages.some(
    (p) =>
      detectShopifyFromHtml(p?.textSnippet || "") ||
      Boolean(p?.themeInfo?.schemaName) ||
      Boolean(p?.themeName) ||
      /\/cdn\/shop\//i.test(p?.url || "")
  );
}

const FETCH_CRAWL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function extractSitemapLocs(xml) {
  return [...String(xml || "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) =>
    m[1].trim().replace(/&amp;/g, "&")
  );
}

/** Read Shopify sitemap index + product/collection child sitemaps (robots.txt allows these). */
async function discoverUrlsFromSitemap(startUrl, limits = { collections: 2, products: 2 }) {
  const origin = new URL(startUrl).origin;
  const collections = [];
  const products = [];

  try {
    const rootRes = await fetch(`${origin}/sitemap.xml`, {
      headers: { "user-agent": FETCH_CRAWL_UA, accept: "application/xml,text/xml" }
    });
    if (!rootRes.ok) return { collections, products };

    const rootXml = await rootRes.text();
    const rootLocs = extractSitemapLocs(rootXml);
    const childSitemaps = rootLocs.filter((loc) => /sitemap_.*\.xml/i.test(loc));

    const locs = childSitemaps.length ? [] : rootLocs;
    for (const childUrl of childSitemaps.slice(0, 6)) {
      try {
        const childRes = await fetch(childUrl, {
          headers: { "user-agent": FETCH_CRAWL_UA, accept: "application/xml,text/xml" }
        });
        if (!childRes.ok) continue;
        locs.push(...extractSitemapLocs(await childRes.text()));
      } catch {
        // ignore child sitemap failures
      }
    }

    for (const loc of locs) {
      if (
        /\/collections\//i.test(loc) &&
        !/\/collections\/[^/]+\/products\//i.test(loc) &&
        !/sort_by|[?&]filter|[+]|%2b/i.test(loc)
      ) {
        collections.push(loc);
      } else if (/\/products\/[^/]+$/i.test(loc) && !loc.includes("?")) {
        products.push(loc);
      }
    }
  } catch {
    // ignore sitemap discovery errors
  }

  return {
    collections: [...new Set(collections)].slice(0, limits.collections),
    products: [...new Set(products)].slice(0, limits.products)
  };
}

/**
 * When Playwright only sees Cloudflare challenges, plain HTTP fetch often still works
 * (allowed in robots.txt for products/collections). Fills home + collection + product pages.
 */
async function supplementCrawlWithFetch({
  startUrl,
  pages: initialPages = [],
  maxPages,
  crawlOptions = {},
  targets = resolveCrawlTargets(),
  reason = "browser crawl blocked"
}) {
  const onPageCrawled = crawlOptions.onPageCrawled;
  const additionalPageUrls = Array.isArray(crawlOptions.additionalPageUrls)
    ? crawlOptions.additionalPageUrls.filter(Boolean)
    : [];
  const additionalPageKeys = buildAdditionalPageKeySet(additionalPageUrls);

  const pages = [...initialPages];
  const existingKeys = new Set(
    pages.map((p) => crawlCanonicalUrlKey(p.url)).filter(Boolean)
  );
  const stats = { home: 0, collection: 0, product: 0 };
  for (const p of pages) applyCrawlStats(p, stats);

  const origin = new URL(startUrl).origin;
  const fromSitemap = await discoverUrlsFromSitemap(startUrl, {
    collections: targets.each * 2,
    products: targets.each * 3
  });

  const candidates = [
    startUrl,
    `${origin}/collections/all`,
    ...fromSitemap.collections,
    ...fromSitemap.products,
    ...additionalPageUrls
  ];

  let shopifyDetected = inferShopifyFromCrawledPages(pages) || (await probeShopifyStore(startUrl));
  const crawlNotes = [`HTTP fetch fallback used (${reason}).`];

  for (const url of [...new Set(candidates)]) {
    if (pages.length >= maxPages) break;

    const pageType = classifyPage(url);
    if (pageType === "general" && stats.home >= 1) continue;
    if (pageType === "collection" && stats.collection >= targets.each) continue;
    if (pageType === "product" && stats.product >= targets.each) continue;

    const key = crawlCanonicalUrlKey(url);
    if (!key || existingKeys.has(key)) continue;

    console.log(`Fetch fallback: ${url}`);
    emitCrawlStarted(onPageCrawled, startUrl, url, additionalPageKeys, pages.length + 1);

    try {
      const { ok, shopifyDetected: detected, signal, status } = await fetchPageSignals(
        startUrl,
        url
      );
      if (!ok) {
        console.log(`Fetch fallback HTTP ${status}: ${url}`);
        continue;
      }
      if (detected) shopifyDetected = true;

      if (signal.challengePage) {
        console.log(`Fetch fallback bot challenge, skipping: ${url}`);
        notifyPageCrawl(onPageCrawled, {
          status: "blocked",
          url,
          pageKey: visitKeyForUrl(url),
          pageType: queueUrlType(startUrl, url, additionalPageKeys),
          order: pages.length + 1,
          title: "Blocked by bot protection (not crawled)"
        });
        continue;
      }

      pages.push(signal);
      existingKeys.add(key);
      applyCrawlStats(signal, stats);
      emitCrawlFinished(onPageCrawled, signal, pages.length, additionalPageUrls);
      console.log(`Fetch fallback OK: ${url} (${signal.pageType})`);
    } catch (error) {
      console.log(`Fetch fallback failed: ${url} - ${error.message}`);
    }
  }

  return { pages, shopifyDetected, crawlNotes };
}

function safeName(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function saveScreenshotIfEnabled(page, signal, index, screenshotDir) {
  if (!screenshotDir) return "";
  try {
    await mkdir(screenshotDir, { recursive: true });
    const fileName = `${String(index + 1).padStart(2, "0")}-${safeName(
      signal.pageType || "page"
    )}-${safeName(new URL(signal.url).pathname || "home")}.png`;
    const fullPath = path.join(screenshotDir, fileName);
    await page.screenshot({ path: fullPath, fullPage: true });
    return fullPath;
  } catch {
    return "";
  }
}

async function saveAboveFoldScreenshotIfEnabled(page, signal, index, screenshotDir) {
  if (!screenshotDir || !signal?.aboveFoldModule?.selector) return "";
  try {
    await mkdir(screenshotDir, { recursive: true });
    const fileName = `${String(index + 1).padStart(2, "0")}-abovefold-${safeName(
      signal.pageType || "page"
    )}.png`;
    const fullPath = path.join(screenshotDir, fileName);
    const locator = page.locator(signal.aboveFoldModule.selector).first();
    if ((await locator.count()) === 0) return "";
    await locator.screenshot({ path: fullPath });
    return fullPath;
  } catch {
    return "";
  }
}

async function saveSectionScreenshotsIfEnabled(page, signal, index, screenshotDir) {
  if (!screenshotDir) return {};

  // Selectors here are intentionally permissive and theme-agnostic. Each
  // section uses several alternative selectors so we still capture the right
  // element on themes that name things differently.
  const sectionSelectorsByPageType = {
    general: {
      announcement:
        "[data-section-type*='announcement'], [id*='shopify-section-announcement'], [class*='announcement' i], [class*='utility-bar' i], [class*='top-bar' i], [class*='promo-bar' i], [class*='notification-bar' i]",
      header: "header, [role='banner'], [data-section-type='header'], [id*='shopify-section-header']",
      hero:
        "[data-section-type*='slideshow'], [data-section-type*='hero'], [data-section-type*='banner'], [data-section-type*='image-banner'], section[class*='hero' i], section[class*='banner' i], .hero, .banner, .slideshow",
      trust:
        "[class*='trust' i], [class*='usp' i], [class*='value-prop' i], [class*='benefits' i], [class*='features-bar' i], [class*='icon-row' i], [class*='perks' i], [class*='guarantee' i], [class*='why-choose' i], [class*='shop-promise' i]",
      featured:
        "[data-section-type*='featured'], [data-section-type*='collection'], section[class*='featured' i], [class*='best-seller' i], [class*='shop-by' i], [class*='category' i], section[class*='collection-list' i]",
      footer: "footer, [role='contentinfo'], [data-section-type='footer']"
    },
    collection: {
      heading: "main h1, [class*='collection-hero' i] h1, [class*='collection-header' i] h1, [class*='collection' i] h1",
      intro:
        "[class*='collection-hero' i], [class*='collection-description' i], [class*='collection-banner' i], [id*='collection-description']",
      filterSort:
        "facet-filters-form, filter-form, [data-filter], [data-filters], [data-collection-filter], [class*='filter' i], [class*='facet' i], select[name*='sort' i], [data-sort], [class*='sort' i]",
      productGrid:
        "[class*='product-grid' i], [id*='product-grid' i], [class*='collection-grid' i], [class*='product-list' i], main [class*='product-card' i]"
    },
    product: {
      titlePriceCta:
        "h1, [class*='product-title' i], [class*='product__title' i], form[action*='/cart/add'], button[name='add']",
      media:
        "[class*='product-media' i], [class*='product__media' i], [class*='product-gallery' i], [class*='gallery' i], [class*='product-images' i]",
      trust:
        "[class*='shipping' i], [class*='warranty' i], [class*='guarantee' i], [class*='returns' i], [class*='delivery' i], [class*='product-trust' i]",
      upsell:
        "product-recommendations, [data-product-recommendations], [class*='related' i], [class*='recommend' i], [class*='you-may-like' i], [class*='cross-sell' i], [class*='upsell' i], [class*='recently-viewed' i]"
    }
  };

  const byType =
    sectionSelectorsByPageType[signal.pageType] || sectionSelectorsByPageType.general;
  const entries = Object.entries(byType);
  const result = {};

  for (const [sectionKey, selector] of entries) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      const fileName = `${String(index + 1).padStart(2, "0")}-section-${safeName(
        signal.pageType || "general"
      )}-${safeName(sectionKey)}.png`;
      const fullPath = path.join(screenshotDir, fileName);
      await locator.screenshot({ path: fullPath });
      result[sectionKey] = fullPath;
    } catch {
      // Ignore section-level screenshot failures and continue.
    }
  }

  return result;
}

async function crawlStoreWithFetch(
  startUrl,
  maxPages,
  initialQueue = [startUrl],
  additionalPageUrls = [],
  crawlOptions = {}
) {
  const targets = resolveCrawlTargets(crawlOptions);
  const onPageCrawled = crawlOptions.onPageCrawled;
  const additionalPageKeys = buildAdditionalPageKeySet(additionalPageUrls);
  const queue = [];
  const queued = new Set();
  const stats = { home: 0, collection: 0, product: 0 };
  enqueueByPriority(queue, queued, startUrl, startUrl, additionalPageKeys, stats, targets);
  initialQueue.forEach((u) =>
    enqueueByPriority(queue, queued, startUrl, u, additionalPageKeys, stats, targets)
  );
  const visited = new Set();
  const pages = [];
  let shopifyDetected = await probeShopifyStore(startUrl);

  console.log(
    `Starting fetch-based crawl for: ${startUrl} (target: ${targets.each} collections + ${targets.each} products)`
  );

  const crawlGuard = { blockedAttempts: 0, maxBlockedAttempts: 2, productUrlsBlocked: false };

  while (queue.length && pages.length < maxPages) {
    sortQueueByPriority(queue, startUrl, additionalPageKeys, stats, targets);
    const next = queue.shift();
    const visitKey = visitKeyForUrl(next);
    if (!next || (visitKey ? visited.has(visitKey) : visited.has(next))) continue;
    queued.delete(next);
    if (visitKey) visited.add(visitKey);
    else visited.add(next);

    console.log(`Fetching: ${next}`);
    emitCrawlStarted(onPageCrawled, startUrl, next, additionalPageKeys, pages.length + 1);

    try {
      if (pageAlreadyCrawled(pages, next)) {
        console.log(`Skipping duplicate page (already crawled): ${next}`);
        continue;
      }
      const { ok, shopifyDetected: detected, signal, status } = await fetchPageSignals(
        startUrl,
        next
      );

      if (!ok) {
        console.log(`HTTP ${status} for: ${next}`);
        continue;
      }

      if (detected) {
        shopifyDetected = true;
        console.log(`Shopify store detected at: ${next}`);
      }

      if (signal.challengePage) {
        console.log(`Bot challenge page, skipping: ${next}`);
        notifyPageCrawl(onPageCrawled, {
          status: "blocked",
          url: next,
          pageKey: visitKeyForUrl(next),
          pageType: queueUrlType(startUrl, next, additionalPageKeys),
          order: pages.length + 1,
          title: "Blocked by bot protection (not crawled)"
        });
        if (handleBotProtectionOnCrawl(crawlGuard, next, queue, queued)) {
          console.log("Stopping fetch crawl: repeated bot protection");
          break;
        }
        continue;
      }

      pages.push(signal);
      applyCrawlStats(signal, stats);
      emitCrawlFinished(onPageCrawled, signal, pages.length, additionalPageUrls);

      console.log(
        `Successfully fetched: ${next} (${signal.pageType}) [collections=${stats.collection}, products=${stats.product}]`
      );

      enqueueDiscoveredLinks(queue, queued, startUrl, signal, stats, additionalPageKeys, targets);
    } catch (error) {
      console.log(`Failed to fetch: ${next} - ${error.message}`);
    }
  }

  const additionalResult = await ensureAdditionalPagesCrawled({
    startUrl,
    additionalPageUrls,
    additionalPageKeys,
    pages,
    visited,
    stats,
    onPageCrawled,
    targets
  });
  if (additionalResult?.shopifyDetected) shopifyDetected = true;

  console.log(`Fetch crawl completed: ${pages.length} pages, shopifyDetected: ${shopifyDetected}`);

  if (!shopifyDetected && inferShopifyFromCrawledPages(pages)) {
    shopifyDetected = true;
  }

  let crawlNotes = crawlGuard.productUrlsBlocked
    ? ["Product pages were blocked by bot protection in browser; HTTP fetch may still be used."]
    : [];

  if (pages.length < maxPages) {
    const supplemented = await supplementCrawlWithFetch({
      startUrl,
      pages,
      maxPages,
      crawlOptions: { ...crawlOptions, additionalPageUrls },
      targets,
      reason: "fetch crawl needed more pages"
    });
    if (supplemented.pages.length > pages.length) {
      pages.length = 0;
      pages.push(...supplemented.pages);
      shopifyDetected = shopifyDetected || supplemented.shopifyDetected;
      crawlNotes = [...crawlNotes, ...supplemented.crawlNotes];
    }
  }

  // Optional Playwright pass for screenshots AND runtime probes (sticky header,
  // floating chat button). This upgrades certain feature signals from
  // "uncertain" to high-confidence even in fetch-first mode.
  if (process.env.AUDIT_SECTION_SCREENSHOT_DIR) {
    try {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      const picked = [];
      const addFirstOfType = (type) => {
        const item = pages.find((p) => p.pageType === type);
        if (item && !picked.includes(item)) picked.push(item);
      };
      addFirstOfType("general");
      addFirstOfType("collection");
      addFirstOfType("product");

      for (let i = 0; i < picked.length; i += 1) {
        const signal = picked[i];
        try {
          await page.goto(signal.url, { waitUntil: "domcontentloaded", timeout: 12000 });

          // On collection / home pages, attempt a true browser-level hover over
          // the first product card BEFORE evaluating. Real :hover pseudo-class
          // styles only apply when the actual mouse cursor is over an element,
          // which page.hover() simulates; dispatched mouse events do NOT trigger
          // CSS :hover. This is what makes us reliably detect image-swap and
          // reveal-on-hover quick-add buttons.
          if (signal.pageType !== "product") {
            try {
              const firstCard = await page.$(
                "[class*='product-card' i], [class*='product-item' i], [class*='grid-product' i], [class*='card-product' i], [class*='product__card' i], [class*='product-grid__item' i], li.grid__item[class*='product' i]"
              );
              if (firstCard) {
                await firstCard.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
                await firstCard.hover({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(450);
              }
            } catch {
              // ignore — hover is best-effort
            }
          }

          // Runtime probes upgrade confidence for the picked pages.
          const runtimeHints = await detectRuntimeHints(page);

          // Apply product-card hover hints back into the feature matrix
          if (runtimeHints && runtimeHints.productCardHoverTested) {
            const pch = signal.featureDetection?.features?.productCardHover;
            if (pch) {
              if (runtimeHints.productCardHoverChanges === true) {
                pch.present = true;
                pch.confidence = "high";
                pch.evidence = [
                  ...(pch.evidence || []),
                  "runtime: hover changed card image / element opacity / visibility"
                ];
              } else if (runtimeHints.productCardHoverChanges === false) {
                // We tested AND nothing changed — likely truly absent on this card.
                // But don't override an earlier "true" — keep whichever is more confident.
                if (pch.present !== true) {
                  pch.present = false;
                  pch.confidence = "medium";
                  pch.evidence = [
                    ...(pch.evidence || []),
                    "runtime: hover produced no visible change"
                  ];
                }
              }
            }
            const qa = signal.featureDetection?.features?.productCardQuickAdd;
            if (qa && runtimeHints.quickAddRevealedOnHover === true) {
              qa.present = true;
              qa.confidence = "high";
              qa.evidence = [
                ...(qa.evidence || []),
                "runtime: quick-add button revealed on card hover"
              ];
            }
          }

          if (runtimeHints && runtimeHints.stickyHeaderTested) {
            const sh = signal.featureDetection?.features?.stickyHeader;
            if (sh) {
              if (runtimeHints.stickyHeader === true) {
                sh.present = true;
                sh.confidence = "high";
                sh.evidence = [
                  ...(sh.evidence || []),
                  "runtime: header stayed pinned after scroll"
                ];
              } else if (runtimeHints.stickyHeader === false) {
                sh.present = false;
                sh.confidence = "high";
                sh.evidence = [
                  ...(sh.evidence || []),
                  "runtime: header scrolled off"
                ];
              }
              signal.flags.hasStickyHeaderHint = sh.present === true;
              signal.flags.hasStickyHeaderDetected = sh.present === true;
              signal.flags.confirmedNoStickyHeader = sh.present === false;
            }
          }
          if (runtimeHints && runtimeHints.hasFloatingChatButton) {
            const lc = signal.featureDetection?.features?.liveChat;
            if (lc && lc.present !== true) {
              lc.present = true;
              lc.confidence = "medium";
              lc.evidence = [
                ...(lc.evidence || []),
                "runtime: fixed-position chat-launcher-like button detected"
              ];
              signal.flags.hasLiveChat = true;
            }
          }

          signal.aboveFoldScreenshotPath = await saveAboveFoldScreenshotIfEnabled(
            page,
            signal,
            i,
            process.env.AUDIT_SECTION_SCREENSHOT_DIR
          );
          signal.sectionScreenshots = await saveSectionScreenshotsIfEnabled(
            page,
            signal,
            i,
            process.env.AUDIT_SECTION_SCREENSHOT_DIR
          );
        } catch {
          // Ignore individual page capture errors in fallback pass.
        }
      }

      await browser.close();
    } catch {
      // If lightweight screenshot pass fails, keep fetch-only text audit results.
    }
  }

  return { shopifyDetected, pages, crawlNotes };
}

export async function crawlStore(startUrl, maxPages = 8, options = {}) {
  const additionalPageUrls = Array.isArray(options.additionalPageUrls)
    ? options.additionalPageUrls.filter(Boolean)
    : [];
  const crawlOptions = {
    onPageCrawled: options.onPageCrawled,
    pagesPerType: options.pagesPerType,
    additionalPageUrls
  };
  const targets = resolveCrawlTargets(crawlOptions);

  console.log(`Starting crawl for: ${startUrl}`);
  console.log(`Additional URLs: ${additionalPageUrls.length}`);
  console.log(`Balanced crawl target: ${targets.each} collection(s) + ${targets.each} product(s)`);

  const probedShopify = await probeShopifyStore(startUrl);
  if (probedShopify) {
    console.log(`Shopify confirmed via storefront probe: ${startUrl}`);
  }

  if (process.env.AUDIT_USE_FETCH_ONLY === "1") {
    const queue = [startUrl, ...additionalPageUrls];
    const uniqueQueue = Array.from(new Set(queue));
    const fetchResult = await crawlStoreWithFetch(
      uniqueQueue[0],
      maxPages,
      uniqueQueue,
      additionalPageUrls,
      crawlOptions
    );
    return {
      ...fetchResult,
      shopifyDetected: Boolean(fetchResult.shopifyDetected || probedShopify)
    };
  }

  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1365, height: 900 }
    });
    const page = await context.newPage();

    const additionalPageKeys = buildAdditionalPageKeySet(additionalPageUrls);
    const queue = [];
    const queued = new Set();
    const stats = { home: 0, collection: 0, product: 0 };
    enqueueByPriority(queue, queued, startUrl, startUrl, additionalPageKeys, stats, targets);
    additionalPageUrls.forEach((u) =>
      enqueueByPriority(queue, queued, startUrl, u, additionalPageKeys, stats, targets)
    );
    const visited = new Set();
    const pages = [];
    let shopifyDetected = probedShopify;
    const screenshotDir = process.env.AUDIT_SCREENSHOT_DIR || "";
    const sectionScreenshotDir =
      process.env.AUDIT_SECTION_SCREENSHOT_DIR || process.env.AUDIT_SCREENSHOT_DIR || "";

    console.log(`Queue length: ${queue.length}, maxPages: ${maxPages}`);

    const crawlGuard = { blockedAttempts: 0, maxBlockedAttempts: 2, productUrlsBlocked: false };

    while (queue.length && pages.length < maxPages) {
      sortQueueByPriority(queue, startUrl, additionalPageKeys, stats, targets);
      const next = queue.shift();
      const visitKey = visitKeyForUrl(next);
      if (!next || (visitKey ? visited.has(visitKey) : visited.has(next))) continue;
      queued.delete(next);
      if (visitKey) visited.add(visitKey);
      else visited.add(next);

      console.log(`Crawling: ${next}`);
      emitCrawlStarted(crawlOptions.onPageCrawled, startUrl, next, additionalPageKeys, pages.length + 1);

      try {
        if (pageAlreadyCrawled(pages, next)) {
          console.log(`Skipping duplicate page (already crawled): ${next}`);
          continue;
        }

        const nav = await resilientGoto(page, next, { timeout: 45000 });
        if (!nav.ok) {
          console.log(`Navigation failed for ${next}: ${nav.reason}`);
        } else if (nav.thin) {
          console.log(`Thin render for ${next}: ${nav.reason} — findings will be gated`);
        }
        const html = await page.content();

        if (detectShopifyFromHtml(html)) {
          shopifyDetected = true;
          console.log(`Shopify store detected at: ${next}`);
        }

        const runtimeHints = await detectRuntimeHints(page);
        const signal = extractSignals(next, html, runtimeHints);

        if (signal.challengePage) {
          console.log(`Bot challenge page, skipping: ${next}`);
          notifyPageCrawl(crawlOptions.onPageCrawled, {
            status: "blocked",
            url: next,
            pageKey: visitKeyForUrl(next),
            pageType: queueUrlType(startUrl, next, additionalPageKeys),
            order: pages.length + 1,
            title: "Blocked by bot protection (not crawled)"
          });
          if (handleBotProtectionOnCrawl(crawlGuard, next, queue, queued)) {
            console.log("Stopping browser crawl: repeated bot protection");
            break;
          }
          continue;
        }
        signal.screenshotPath = await saveScreenshotIfEnabled(
          page,
          signal,
          pages.length,
          screenshotDir
        );
        signal.aboveFoldScreenshotPath = await saveAboveFoldScreenshotIfEnabled(
          page,
          signal,
          pages.length,
          screenshotDir
        );
        signal.sectionScreenshots = await saveSectionScreenshotsIfEnabled(
          page,
          signal,
          pages.length,
          sectionScreenshotDir
        );
        signal.crawlThin = Boolean(nav && nav.thin);
        if (nav && nav.reason) signal.crawlReason = nav.reason;
        pages.push(signal);
        applyCrawlStats(signal, stats);
        emitCrawlFinished(crawlOptions.onPageCrawled, signal, pages.length, additionalPageUrls);

        console.log(
          `Successfully crawled: ${next} (${signal.pageType}) [collections=${stats.collection}, products=${stats.product}]`
        );

        enqueueDiscoveredLinks(queue, queued, startUrl, signal, stats, additionalPageKeys, targets);
      } catch (error) {
        console.log(`Failed to crawl: ${next} - ${error.message}`);
      }
    }

    const additionalResult = await ensureAdditionalPagesCrawledWithBrowser({
      startUrl,
      additionalPageUrls,
      additionalPageKeys,
      pages,
      visited,
      stats,
      page,
      screenshotDir,
      sectionScreenshotDir,
      onPageCrawled: crawlOptions.onPageCrawled,
      targets
    });
    if (additionalResult?.shopifyDetected) shopifyDetected = true;

    await browser.close();
    console.log(`Crawl completed: ${pages.length} pages, shopifyDetected: ${shopifyDetected}`);
    const crawlNotes = [];
    if (crawlGuard.productUrlsBlocked) {
      crawlNotes.push(
        "Product pages were blocked by bot protection; audit used home/collection evidence only."
      );
    }
    if (!shopifyDetected && inferShopifyFromCrawledPages(pages)) {
      shopifyDetected = true;
    }
    if (!shopifyDetected && probedShopify) {
      shopifyDetected = true;
    }

    const needsFetchFallback =
      pages.length === 0 ||
      (crawlGuard.productUrlsBlocked && stats.product < targets.each) ||
      stats.collection < 1;

    if (needsFetchFallback && pages.length < maxPages) {
      const supplemented = await supplementCrawlWithFetch({
        startUrl,
        pages,
        maxPages,
        crawlOptions: { ...crawlOptions, additionalPageUrls },
        targets,
        reason:
          pages.length === 0
            ? "Playwright saw bot challenges on all pages"
            : "product pages blocked in browser; using HTTP fetch"
      });
      pages.length = 0;
      pages.push(...supplemented.pages);
      shopifyDetected = shopifyDetected || supplemented.shopifyDetected;
      crawlNotes.push(...supplemented.crawlNotes);
      console.log(`After fetch fallback: ${pages.length} page(s) available for audit`);
    }

    return { shopifyDetected, pages, crawlNotes };
  } catch (error) {
    console.log(`Browser crawl failed, falling back to fetch: ${error.message}`);
    const queue = [startUrl, ...additionalPageUrls];
    const uniqueQueue = Array.from(new Set(queue));
    const fetchResult = await crawlStoreWithFetch(
      uniqueQueue[0],
      maxPages,
      uniqueQueue,
      additionalPageUrls,
      crawlOptions
    );
    return {
      ...fetchResult,
      shopifyDetected: Boolean(
        fetchResult.shopifyDetected || probedShopify || inferShopifyFromCrawledPages(fetchResult.pages)
      )
    };
  }
}