/**
 * Theme-agnostic Shopify feature detection.
 *
 * Why this module exists
 * ----------------------
 * Different Shopify themes (Dawn, Sense, Refresh, Studio, Crave, Impulse, Motion,
 * Symmetry, Empire, Prestige, Warehouse, Booster, Debutify, Turbo, Avenue,
 * Streamline, Palo Alto, Hyper, Origin, etc.) and the thousands of third-party
 * themes all use different class names and DOM structures for the same UI
 * features. A "sticky header" can be `header.sticky`, `.site-header--sticky`,
 * `[data-sticky-header]`, a class added on scroll via JS, or just CSS
 * `position: sticky` on a custom element.
 *
 * To detect features accurately across themes we therefore use multiple
 * independent strategies per feature and combine them into a confidence score.
 *
 * Detection result shape
 * ----------------------
 * Every detector returns:
 *   {
 *     present:    true | false | null,        // null = could not determine
 *     confidence: "high" | "medium" | "low",  // strength of the signal
 *     evidence:   string[]                    // which signals matched, for debug
 *   }
 *
 * Confidence rules:
 *   - high   : two or more independent strong signals OR one definitive signal
 *              (e.g. successful runtime test, exact JS-API global, recognised
 *              app script src)
 *   - medium : one strong signal OR multiple weak signals
 *   - low    : a single weak/heuristic signal only
 *
 * `present: null` is used when we have no evidence either way — we explicitly
 * do NOT treat absence of signal as "feature missing". This is what eliminates
 * the false positives where the audit report says "no zoom detected, add zoom"
 * when in fact the theme uses an unusual zoom implementation.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function classListString($, $el) {
  if (!$el || !$el.length) return "";
  return ($el.attr("class") || "").toLowerCase();
}

function attrIncludesAny($el, attrName, needles = []) {
  const value = ($el.attr(attrName) || "").toLowerCase();
  if (!value) return false;
  return needles.some((n) => value.includes(n.toLowerCase()));
}

function anyMatches($, selectors = []) {
  for (const sel of selectors) {
    try {
      if ($(sel).length) return true;
    } catch {
      // bad selector → ignore
    }
  }
  return false;
}

function countMatches($, selectors = []) {
  let total = 0;
  for (const sel of selectors) {
    try {
      total += $(sel).length;
    } catch {
      // ignore
    }
  }
  return total;
}

function htmlContainsAny(html, needles = []) {
  if (!html) return false;
  return needles.some((n) => html.toLowerCase().includes(n.toLowerCase()));
}

function textContainsAny(text, patterns = []) {
  if (!text) return false;
  return patterns.some((p) => p.test(text));
}

function classOrAttrLooseMatch($, keywords = [], { attrs = ["class", "id"] } = {}) {
  // Look at attributes loosely across all elements. Keywords are matched as
  // case-insensitive substrings inside any of the given attributes.
  // We deliberately scan all elements (not just sections) so theme variations
  // with custom containers are still caught.
  let found = false;
  $("*").each((_, el) => {
    if (found) return;
    if (!el.attribs) return;
    for (const attr of attrs) {
      const val = el.attribs[attr];
      if (!val) continue;
      const lower = String(val).toLowerCase();
      if (keywords.some((k) => lower.includes(k))) {
        found = true;
        return;
      }
    }
  });
  return found;
}

function combineConfidence(strongCount, weakCount) {
  if (strongCount >= 2) return "high";
  if (strongCount === 1 && weakCount >= 1) return "high";
  if (strongCount === 1) return "medium";
  if (weakCount >= 2) return "medium";
  if (weakCount === 1) return "low";
  return null;
}

function resultFromSignals(strong = [], weak = []) {
  const strongCount = strong.length;
  const weakCount = weak.length;
  const confidence = combineConfidence(strongCount, weakCount);
  if (!confidence) {
    return { present: null, confidence: "low", evidence: [] };
  }
  return {
    present: true,
    confidence,
    evidence: [...strong, ...weak]
  };
}

function notPresent() {
  return { present: false, confidence: "high", evidence: [] };
}

function unknown() {
  return { present: null, confidence: "low", evidence: [] };
}

// ---------------------------------------------------------------------------
// Theme detection from Shopify.theme (schema_name = base theme, e.g. Dawn)
// ---------------------------------------------------------------------------

function readJsonStringField(obj, key) {
  const value = obj?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function extractShopifyThemeObject(html) {
  if (!html) return null;
  const match = html.match(/Shopify\.theme\s*=\s*(\{[\s\S]*?\})\s*;/i);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractLooseThemeFieldsFromHtml(html) {
  if (!html) return null;
  const themeBlock = html.match(/Shopify\.theme\s*=\s*\{[\s\S]*?\}/i)?.[0] || html;
  const schemaName = themeBlock.match(/"schema_name"\s*:\s*"([^"]+)"/i)?.[1]?.trim() || "";
  const instanceName = themeBlock.match(/"name"\s*:\s*"([^"]+)"/i)?.[1]?.trim() || "";
  const schemaVersion =
    themeBlock.match(/"schema_version"\s*:\s*"([^"]+)"/i)?.[1]?.trim() || "";
  const role = themeBlock.match(/"role"\s*:\s*"([^"]+)"/i)?.[1]?.trim() || "";
  const idMatch = themeBlock.match(/"id"\s*:\s*(\d+)/i);
  const themeStoreMatch = themeBlock.match(/"theme_store_id"\s*:\s*(\d+)/i);

  if (!schemaName && !instanceName && !idMatch) return null;

  return {
    schemaName,
    instanceName,
    schemaVersion,
    themeStoreId: themeStoreMatch?.[1] ?? "",
    role,
    id: idMatch?.[1] ?? "",
    source: "Shopify.theme.loose"
  };
}

function themeInfoFromPageUrl(pageUrl = "") {
  if (!pageUrl) return null;
  try {
    const u = new URL(pageUrl);
    const previewThemeId = u.searchParams.get("preview_theme_id");
    if (!previewThemeId) return null;
    return {
      schemaName: "",
      instanceName: "",
      schemaVersion: "",
      themeStoreId: "",
      role: "preview",
      id: previewThemeId,
      previewThemeId,
      source: "preview_theme_id"
    };
  } catch {
    return null;
  }
}

/** Full theme metadata from storefront HTML (Shopify.theme preferred). */
export function detectThemeInfo(html, pageUrl = "") {
  const shopifyTheme = extractShopifyThemeObject(html);
  if (shopifyTheme) {
    const schemaName = readJsonStringField(shopifyTheme, "schema_name");
    const instanceName = readJsonStringField(shopifyTheme, "name");
    const schemaVersion = readJsonStringField(shopifyTheme, "schema_version");
    return {
      schemaName,
      instanceName,
      schemaVersion,
      themeStoreId: shopifyTheme.theme_store_id ?? "",
      role: readJsonStringField(shopifyTheme, "role"),
      id: shopifyTheme.id ?? "",
      previewThemeId: "",
      source: "Shopify.theme"
    };
  }

  const loose = extractLooseThemeFieldsFromHtml(html);
  if (loose) return { ...loose, previewThemeId: "" };

  const legacyPatterns = [
    { key: "theme_name", pattern: /"theme_name"\s*:\s*"([^"]+)"/i },
    {
      key: "meta",
      pattern: /<meta[^>]+name=["']theme-name["'][^>]+content=["']([^"']+)["']/i
    }
  ];
  for (const { key, pattern } of legacyPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return {
        schemaName: key === "theme_name" ? match[1].trim() : "",
        instanceName: key === "meta" ? match[1].trim() : match[1].trim(),
        schemaVersion: "",
        themeStoreId: "",
        role: "",
        id: "",
        previewThemeId: "",
        source: key
      };
    }
  }

  return themeInfoFromPageUrl(pageUrl);
}

/** Primary theme label for prompts and UI — prefers schema_name (e.g. Dawn). */
export function detectThemeName(html) {
  const info = detectThemeInfo(html);
  if (!info) return "";
  return info.schemaName || info.instanceName || "";
}

export function formatThemeForApi(themeInfo) {
  if (!themeInfo) {
    return {
      displayName: "Not clearly detected",
      schemaName: "",
      instanceName: "",
      schemaVersion: "",
      themeStoreId: "",
      role: "",
      previewThemeId: "",
      source: ""
    };
  }

  const schemaName = themeInfo.schemaName || "";
  const instanceName = themeInfo.instanceName || "";
  const previewThemeId = String(themeInfo.previewThemeId || themeInfo.id || "").trim();
  let displayName = schemaName || instanceName || "";
  if (!displayName && previewThemeId && themeInfo.source === "preview_theme_id") {
    displayName = `Theme preview (ID ${previewThemeId})`;
  }
  if (!displayName) displayName = "Not clearly detected";

  return {
    displayName,
    schemaName,
    instanceName,
    schemaVersion: themeInfo.schemaVersion || "",
    themeStoreId: themeInfo.themeStoreId ?? "",
    role: themeInfo.role || "",
    previewThemeId,
    source: themeInfo.source || ""
  };
}

export function pickStoreThemeFromPages(pages = []) {
  for (const page of pages) {
    if (page?.themeInfo?.schemaName || page?.themeInfo?.instanceName) {
      return page.themeInfo;
    }
    if (page?.themeName) {
      return {
        schemaName: page.themeName,
        instanceName: "",
        schemaVersion: "",
        themeStoreId: "",
        role: "",
        id: "",
        source: "legacy"
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Individual feature detectors
// ---------------------------------------------------------------------------

function detectStickyHeader($, html, runtimeHints = {}) {
  const strong = [];
  const weak = [];

  // Runtime probe (most reliable when available)
  if (runtimeHints.stickyHeader === true) {
    strong.push("runtime: header stayed pinned after scroll");
  } else if (runtimeHints.stickyHeader === false && runtimeHints.stickyHeaderTested) {
    // Page scrolled, header moved away → strong evidence of NOT sticky.
    return { present: false, confidence: "high", evidence: ["runtime: header scrolled off"] };
  }

  // CSS position hints (theme-agnostic — based on actual computed CSS keywords)
  const headerEl = $("header, [role='banner'], [data-section-type='header'], #shopify-section-header, [id*='shopify-section-header']").first();
  const headerClass = classListString($, headerEl);

  if (/\b(sticky|fixed|pinned|is-sticky|header--sticky|header-sticky|sticky-header|sticky-nav|nav-sticky)\b/.test(headerClass)) {
    strong.push("header class contains sticky/fixed keyword");
  }
  if (headerEl.length && headerEl.attr("data-sticky") !== undefined) {
    strong.push("header has data-sticky attribute");
  }
  if (headerEl.length && headerEl.attr("data-sticky-header") !== undefined) {
    strong.push("header has data-sticky-header attribute");
  }
  // Many themes use a wrapper element with these data-* attributes
  if ($("[data-sticky-header], [data-header-sticky], [data-sticky-nav]").length) {
    strong.push("element with data-sticky-header attribute present");
  }
  if (headerEl.length && /(sticky|fixed)/i.test(headerEl.attr("data-header-type") || "")) {
    strong.push("header data-header-type indicates sticky");
  }

  // Inline style on header
  const headerStyle = (headerEl.attr("style") || "").toLowerCase();
  if (/position\s*:\s*(sticky|fixed)/.test(headerStyle)) {
    strong.push("header inline style position: sticky/fixed");
  }

  // CSS rules in stylesheet block (looser, weaker)
  if (/header[^{]*\{[^}]*position\s*:\s*(sticky|fixed)/i.test(html)) {
    weak.push("CSS rule for header with position sticky/fixed");
  }
  if (/\.(header|site-header|shopify-section-header)[^{]*--?sticky/i.test(html)) {
    weak.push("CSS selector targeting sticky header modifier");
  }
  if (/data-sticky-header/i.test(html)) {
    weak.push("data-sticky-header attribute present in source");
  }

  // Common Shopify 2.0 schema setting
  if (/"name"\s*:\s*"sticky_header"|"id"\s*:\s*"sticky_header"|sticky_header_type/i.test(html)) {
    weak.push("section schema mentions sticky_header setting");
  }

  // JS class-toggling pattern (very common in custom themes)
  if (/classList\.(add|toggle)\(['"`](is-)?sticky/i.test(html)) {
    weak.push("JS toggles a sticky class on scroll");
  }

  const result = resultFromSignals(strong, weak);
  if (result.present === null && runtimeHints.stickyHeaderTested) {
    // We tested at runtime and found no stickiness, with no static hints either.
    return { present: false, confidence: "medium", evidence: ["runtime test: header not sticky"] };
  }
  return result;
}

function detectAnnouncementBar($, html) {
  const strong = [];
  const weak = [];

  // Direct semantic / Shopify 2.0 patterns
  if (anyMatches($, [
    "[data-section-type='announcement-bar']",
    "[data-section-type*='announcement']",
    "#shopify-section-announcement-bar",
    "[id*='shopify-section-announcement']"
  ])) {
    strong.push("section type announcement-bar present");
  }

  // Explicit class name "announcement-bar" / "announcement" — used by Dawn and most themes.
  // (The word "announcement" in a class is unambiguous → strong.)
  // Note: *= is substring match (case-insensitive with `i` flag) so it matches
  // "AnnouncementBar", "announcement-bar", "announcementBar", etc.
  if (anyMatches($, [
    "[class*='announcement' i]",
    "[id*='announcement' i]"
  ])) {
    strong.push("explicit announcement class present");
  }

  // Class/id loose match (covers utility-bar, top-bar, promo-bar, notification-bar, etc.)
  if (classOrAttrLooseMatch($, [
    "announcement",
    "utility-bar",
    "top-bar",
    "promo-bar",
    "notification-bar",
    "ticker-bar",
    "info-bar",
    "header-promo",
    "marquee-bar"
  ])) {
    weak.push("element matches announcement/utility/promo/top bar pattern");
  }

  // Marquee element (often used for scrolling announcement)
  if ($("marquee").length || $("[class*='marquee']").length) {
    weak.push("marquee element / class present");
  }

  return resultFromSignals(strong, weak);
}

function detectHeroSection($) {
  const strong = [];
  const weak = [];

  // Shopify 2.0 schema-based
  if (anyMatches($, [
    "[data-section-type*='slideshow']",
    "[data-section-type*='hero']",
    "[data-section-type*='banner']",
    "[data-section-type*='image-banner']",
    "[data-section-type*='image-with-text']"
  ])) {
    strong.push("section data-type indicates hero/slideshow/banner");
  }

  // Explicit, unambiguous hero/banner class names → strong (case-insensitive substring)
  if (anyMatches($, [
    "[class*='hero' i]",
    "[class*='page-hero' i]",
    "[class*='pageHero' i]",
    "[class*='homepage-hero' i]",
    "[class*='hero-image' i]",
    "[class*='hero-banner' i]",
    "[class*='main-banner' i]",
    "[class*='ImageWithText' i]"
  ])) {
    strong.push("element class contains hero/banner pattern");
  }

  // Loose class/id match
  if (classOrAttrLooseMatch($, [
    "hero",
    "banner",
    "slideshow",
    "carousel",
    "main-banner",
    "homepage-hero",
    "intro-banner",
    "header-banner"
  ])) {
    weak.push("element class/id contains hero/banner/slideshow");
  }

  // Headline above-fold heuristic
  const firstMain = $("main").first();
  const firstChild = firstMain.children().first();
  if (firstChild.length && firstChild.find("h1, h2").first().length) {
    weak.push("main first section contains a top-level heading");
  }

  return resultFromSignals(strong, weak);
}

function detectTrustSignals($, text) {
  const strong = [];
  const weak = [];

  // Semantic Shopify 2.0 patterns
  if (anyMatches($, [
    "[data-section-type*='multicolumn']",
    "[data-section-type*='icon']",
    "[data-section-type*='usp']",
    "[data-section-type*='value-prop']",
    "[data-section-type*='features']"
  ])) {
    weak.push("section type suggests icon/feature row");
  }

  // Explicit, unambiguous class names → strong
  // Note: *= is case-insensitive substring (with `i`) so it matches PascalCase too
  // ("FeatureList", "ValueProps", "TrustStrip", etc.)
  if (anyMatches($, [
    "[class*='value-prop' i]",
    "[class*='valueprop' i]",
    "[class*='usp-bar' i]",
    "[class*='usp-strip' i]",
    "[class*='usp-item' i]",
    "[class*='trust-strip' i]",
    "[class*='trust-bar' i]",
    "[class*='trust-badge' i]",
    "[class*='trust-signal' i]",
    "[class*='feature-row' i]",
    "[class*='feature-list' i]",
    "[class*='featurelist' i]",
    "[class*='shop-promise' i]",
    "[class*='shopify-promise' i]"
  ])) {
    strong.push("explicit value-prop / usp / trust / feature-row class present");
  }

  if (classOrAttrLooseMatch($, [
    "trust",
    "usp",
    "value-prop",
    "value-props",
    "guarantee",
    "guarantees",
    "perks",
    "perk",
    "benefits",
    "benefit",
    "features-bar",
    "feature-bar",
    "icon-row",
    "icon-block",
    "icon-bar",
    "iconlist",
    "reasons-to",
    "why-us",
    "why-choose",
    "shop-promise",
    "shopify-promise",
    "advantages",
    "selling-points",
    "feature-icons",
    "marketing-bar",
    "callout-collection",
    "trusted-by"
  ])) {
    weak.push("element matches trust/usp/value-prop/benefits/icon-row pattern");
  }

  // Text-content heuristic (very common phrases on trust strips)
  if (textContainsAny(text, [
    /\bfree shipping\b/i,
    /\bfree (returns?|exchanges?)\b/i,
    /\bmoney[- ]back guarantee\b/i,
    /\bsatisfaction guarantee/i,
    /\bsecure checkout\b/i,
    /\bsecure payments?\b/i,
    /\b\d+[- ]day (returns?|guarantee|warranty)\b/i,
    /\blifetime warranty\b/i,
    /\bshop with confidence\b/i,
    /\bwhy choose us\b/i,
    /\btrusted by [\d,]+ /i
  ])) {
    weak.push("page text contains trust-strip language (shipping/returns/warranty/secure)");
  }

  // Multiple trust phrases on the same page → upgrade to strong
  const trustPhraseMatches = (text.match(/\b(free shipping|free returns?|money[- ]back guarantee|secure checkout|secure payments?|\d+[- ]day returns?|lifetime warranty)\b/gi) || []).length;
  if (trustPhraseMatches >= 3) {
    strong.push(`${trustPhraseMatches} distinct trust phrases (shipping/returns/secure/etc.) on the page`);
  }

  // Payment-icon strip pattern (Visa/MasterCard/etc. icons usually appear together)
  const paymentBrandPattern = /\b(visa|mastercard|american[ -]?express|amex|paypal|apple[ -]?pay|google[ -]?pay|shop[ -]?pay|klarna|afterpay|sezzle)\b/gi;
  const paymentMatches = (text.match(paymentBrandPattern) || []).length;
  if (paymentMatches >= 3) {
    strong.push(`${paymentMatches} payment-brand mentions present (Visa / MasterCard / PayPal / etc.)`);
  } else if (paymentMatches >= 1) {
    weak.push("payment-brand mention present");
  }

  return resultFromSignals(strong, weak);
}

function detectProductMediaZoom($, html, url) {
  // Only meaningful on product pages
  if (!/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  // Standard data attributes used by many themes / lightbox libraries
  const strongSelectors = [
    "[data-zoom]",
    "[data-zoom-image]",
    "[data-product-zoom]",
    "[data-image-zoom]",
    "[data-pswp]",
    "[data-photoswipe]",
    "[data-fancybox]",
    "[data-lightbox]",
    "[data-glightbox]",
    "[data-magnify]",
    "[data-drift-zoom]",
    "[data-easyzoom]",
    "[data-magnific-popup]",
    "[data-mfp-src]",
    "[data-mfp]",
    "[class*='mfp-' i]",                  // magnific-popup naming convention
    "[class*='pswp' i]",                  // photoswipe naming convention
    "[class~='photoswipe' i]",
    "[class*='product-single__photo--zoom' i]",
    "[class*='product__photo-zoom' i]",
    "[aria-label*='zoom' i]",
    "[aria-label*='enlarge' i]",
    "[aria-label*='expand image' i]",
    "[aria-label*='view larger' i]",
    "[aria-label*='full screen' i]",
    "button.product__media-toggle",
    ".product__media-icon--lightbox",
    "product-modal",
    "[is='product-modal']",
    "modal-opener[class*='product__modal' i]"
  ];
  if (anyMatches($, strongSelectors)) {
    strong.push("element matches zoom/lightbox/magnify data-attribute or aria-label");
  }

  // Loose class match (catches a huge range of theme-specific names)
  if (classOrAttrLooseMatch($, [
    "zoom",
    "lightbox",
    "light-box",
    "magnify",
    "magnifier",
    "fancybox",
    "photoswipe",
    "pswp",
    "glightbox",
    "drift-zoom",
    "easyzoom",
    "image-enlarge",
    "media-zoom",
    "gallery-zoom",
    "product-zoom",
    "pinch-zoom",
    "media-modal",
    "image-modal",
    "media-expand",
    "expand-image"
  ])) {
    weak.push("element class contains zoom/lightbox/magnify pattern");
  }

  // Library hint in HTML/JS source
  if (htmlContainsAny(html, [
    "photoswipe",
    "PhotoSwipe",
    "fancybox",
    "Fancybox",
    "glightbox",
    "GLightbox",
    "drift-zoom",
    "Drift(",
    "easyzoom",
    "EasyZoom",
    "magnific-popup",
    "magnificPopup",
    "image-magnify-lightbox",
    "product__media-zoom",
    "ProductMediaZoom",
    "productMediaModal"
  ])) {
    weak.push("HTML/JS source references a known zoom library or component");
  }

  // Icon hint (zoom/magnifier glyphs)
  if ($("svg [class*='zoom'], svg [class*='magnify'], svg [id*='zoom'], svg [id*='magnify'], [class*='icon-zoom'], [class*='icon-magnify']").length) {
    weak.push("zoom/magnify icon present");
  }

  return resultFromSignals(strong, weak);
}

function detectQuickView($, html, text) {
  const strong = [];
  const weak = [];

  const strongSelectors = [
    "[data-quick-view]",
    "[data-quickview]",
    "[data-quick-add]",
    "[data-quickadd]",
    "[data-quick-shop]",
    "[data-quickshop]",
    "[data-quick-view-button]",
    "[data-quick-view-id]",
    "[data-quick-view-handle]",
    "[data-quick-view-url]",
    "[data-qv-handle]",
    "[data-qv-trigger]",
    "[data-qv-id]",
    "quick-view",
    "quick-add-modal",
    "[is='quick-view']",
    "modal-opener[data-modal*='quick' i]"
  ];
  if (anyMatches($, strongSelectors)) {
    strong.push("element matches quick-view/quick-add data attribute or custom element");
  }

  // Explicit, unambiguous class names → strong
  if (anyMatches($, [
    "[class*='quick-view' i]",
    "[class*='quickview' i]",
    "[class*='quick-shop' i]",
    "[class*='quickshop' i]",
    "[class*='quick-add' i]",
    "[class*='quickadd' i]",
    "[class*='qv-trigger' i]",
    "[class*='qv-button' i]",
    "[class*='js-quick' i]"
  ])) {
    strong.push("explicit quick-view/quick-shop/quick-add class present");
  }

  if (classOrAttrLooseMatch($, [
    "quick-view",
    "quickview",
    "quick-add",
    "quickadd",
    "quick-shop",
    "quickshop",
    "product-card__quick",
    "card__quick",
    "product-quick-view"
  ])) {
    weak.push("element class matches quick-view/quick-add/quick-shop pattern");
  }

  // Button text on collection cards
  if (textContainsAny(text, [
    /\bquick view\b/i,
    /\bquick shop\b/i,
    /\bquick add\b/i,
    /\bquickview\b/i
  ])) {
    weak.push("page text includes Quick view / Quick add / Quick shop label");
  }

  if (htmlContainsAny(html, ["quickView", "quickAdd", "QuickShop", "quick_view", "quick_add"])) {
    weak.push("HTML/JS source references a quickView/quickAdd identifier");
  }

  return resultFromSignals(strong, weak);
}

function detectWishlist($, html, text) {
  const strong = [];
  const weak = [];

  if (anyMatches($, [
    "[data-wishlist]",
    "[data-wishlist-trigger]",
    "[data-add-to-wishlist]",
    "[data-favorite]",
    "[data-save-product]",
    "[data-swym]",
    "[data-product-handle][class*='wishlist' i]"
  ])) {
    strong.push("element has wishlist/favorite data attribute");
  }

  // Explicit, unambiguous class names → strong
  if (anyMatches($, [
    "[class*='wishlist-add' i]",
    "[class*='wishlist-btn' i]",
    "[class*='wishlist-button' i]",
    "[class*='wishlist-icon' i]",
    "[class*='add-to-wishlist' i]",
    "[class*='btn-wishlist' i]",
    "[class*='save-for-later' i]"
  ])) {
    strong.push("explicit wishlist / save-for-later class present");
  }

  if (classOrAttrLooseMatch($, [
    "wishlist",
    "favourite",
    "favorite",
    "fav-icon",
    "save-for-later",
    "heart-icon",
    "wishlist-icon",
    "add-to-wishlist",
    "btn-wishlist"
  ])) {
    weak.push("element class matches wishlist/favourite/heart pattern");
  }

  // Known wishlist app scripts
  if (htmlContainsAny(html, [
    "swym",                      // Swym Wishlist Plus
    "wishlistplus",
    "growave",
    "smartwish",
    "hulkapps-wishlist",
    "wishlistking",
    "wishlistify"
  ])) {
    strong.push("known wishlist app script present in source");
  }

  if (textContainsAny(text, [
    /\badd to wishlist\b/i,
    /\bsave to wishlist\b/i,
    /\bsave for later\b/i,
    /\badd to favourites?\b/i,
    /\badd to favorites?\b/i
  ])) {
    weak.push("page text includes wishlist/favourite call-to-action");
  }

  return resultFromSignals(strong, weak);
}

function detectLiveChat(html) {
  const strong = [];

  // Known chat widgets / vendor scripts
  const chatVendors = [
    { name: "Tawk.to", needles: ["embed.tawk.to", "Tawk_API", "tawk.to/chat"] },
    { name: "Intercom", needles: ["widget.intercom.io", "intercomSettings", "Intercom("] },
    { name: "Zendesk Chat", needles: ["zopim", "static.zdassets.com", "zE("] },
    { name: "Drift", needles: ["js.driftt.com", "driftt.com", "drift.com/embed"] },
    { name: "LiveChat", needles: ["cdn.livechatinc.com", "__lc"] },
    { name: "Freshchat", needles: ["wchat.freshchat.com", "fcWidget"] },
    { name: "HubSpot Chat", needles: ["js.hs-scripts.com", "js.hsforms.net", "hubspotutk"] },
    { name: "Crisp", needles: ["client.crisp.chat", "$crisp"] },
    { name: "Olark", needles: ["static.olark.com", "olark("] },
    { name: "Gorgias", needles: ["config.gorgias.chat", "gorgias-chat"] },
    { name: "Tidio", needles: ["code.tidio.co", "tidioChatApi"] },
    { name: "JivoChat", needles: ["code.jivosite.com"] },
    { name: "Chatra", needles: ["call.chatra.io", "ChatraID"] },
    { name: "Re:amaze", needles: ["cdn.reamaze.com"] }
  ];

  for (const vendor of chatVendors) {
    if (htmlContainsAny(html, vendor.needles)) {
      strong.push(`live chat vendor: ${vendor.name}`);
      break;
    }
  }

  return resultFromSignals(strong, []);
}

function detectReviews($, html, text) {
  const strong = [];
  const weak = [];

  // Known reviews-app fingerprints
  const reviewApps = [
    { name: "Judge.me", needles: ["judge.me", "jdgm-widget", "jdgm-rev", "judgeme"] },
    { name: "Yotpo", needles: ["yotpo", "staticw2.yotpo.com", "yotpo-main-widget"] },
    { name: "Stamped.io", needles: ["stamped.io", "stamped-main-widget"] },
    { name: "Loox", needles: ["loox.io", "loox-rating"] },
    { name: "Okendo", needles: ["okendo", "okendoReviews"] },
    { name: "Fera", needles: ["fera.ai"] },
    { name: "Junip", needles: ["junip.co"] },
    { name: "Opinew", needles: ["opinew"] },
    { name: "Reviews.io", needles: ["reviews.io", "reviewsio"] },
    { name: "Ali Reviews", needles: ["alireviews"] },
    { name: "Rivyo", needles: ["rivyo"] },
    { name: "Shopify Product Reviews", needles: ["spr-container", "spr-badge", "shopify_product_reviews"] }
  ];
  for (const app of reviewApps) {
    if (htmlContainsAny(html, app.needles)) {
      strong.push(`reviews app: ${app.name}`);
      break;
    }
  }

  // AggregateRating schema
  if (/"@type"\s*:\s*"AggregateRating"/i.test(html)) {
    strong.push("AggregateRating schema present");
  }

  // Loose class match
  if (classOrAttrLooseMatch($, [
    "review",
    "rating",
    "stars",
    "star-rating",
    "rating-stars",
    "product-review"
  ])) {
    weak.push("element class matches review/rating/stars pattern");
  }

  if (textContainsAny(text, [
    /★/,
    /\b\d(\.\d)?\s*out of\s*5\b/i,
    /\b\d+\s+reviews?\b/i,
    /\b\d+\s+ratings?\b/i,
    /verified\s+purchase/i
  ])) {
    weak.push("page text contains star rating / review-count language");
  }

  return resultFromSignals(strong, weak);
}

function detectSearchBar($) {
  const strong = [];
  const weak = [];

  if ($("input[type='search']").length || $("form[action*='/search']").length || $("[role='search']").length) {
    strong.push("search input / search form / role=search present");
  }
  if (classOrAttrLooseMatch($, [
    "predictive-search",
    "search-bar",
    "site-search",
    "header-search",
    "header__search",
    "search-form",
    "search-modal"
  ])) {
    weak.push("element class matches predictive-search/site-search/header-search");
  }
  if ($("[data-predictive-search]").length || $("predictive-search").length) {
    strong.push("predictive search component present");
  }

  return resultFromSignals(strong, weak);
}

function detectMegaMenu($, html) {
  const strong = [];
  const weak = [];

  if (anyMatches($, [
    "[data-mega-menu]",
    "[data-megamenu]",
    "mega-menu",
    "[is='mega-menu']",
    "[class*='mega-menu' i]",
    "[class*='megamenu' i]",
    "[class*='mega-nav' i]"
  ])) {
    strong.push("explicit mega-menu class/attribute present");
  }
  if (classOrAttrLooseMatch($, ["mega-menu", "megamenu", "mega-nav", "header__mega", "menu-mega"])) {
    weak.push("element class matches mega-menu/mega-nav/menu-mega");
  }
  if (htmlContainsAny(html, ["megaMenu", "mega_menu", "MegaMenu"])) {
    weak.push("HTML/JS references mega menu identifier");
  }
  // Multi-level submenu with dropdown panel — common mega-menu skeleton
  if (
    $("[class*='has-submenu' i], [class*='has-mega' i], [class*='has-dropdown' i]").length &&
    $("[class*='submenu' i], [class*='dropdown' i], [class*='subnav' i]").length
  ) {
    strong.push("nav has both has-submenu trigger and dropdown panel");
  }

  return resultFromSignals(strong, weak);
}

function detectVariantSwatches($, html, url) {
  if (!/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  if (anyMatches($, [
    "[data-swatch]",
    "[data-swatch-color]",
    "[data-color-swatch]",
    "[data-option-color]",
    "[data-variant-swatch]",
    "input[type='radio'][name^='options['][data-color]"
  ])) {
    strong.push("element has swatch / color data attribute");
  }

  // Explicit, unambiguous swatch class names → strong
  if (anyMatches($, [
    "[class~='swatch' i]",
    "[class*='swatch--' i]",
    "[class*='swatch__' i]",
    "[class*='color-swatch' i]",
    "[class*='colour-swatch' i]",
    "[class*='variant-swatch' i]",
    "[class*='product-swatch' i]"
  ])) {
    strong.push("explicit swatch class present");
  }

  if (classOrAttrLooseMatch($, [
    "swatch",
    "swatches",
    "color-swatch",
    "colour-swatch",
    "variant-swatch",
    "variant-color",
    "swatch-element",
    "product-form__swatch",
    "swatch--color"
  ])) {
    weak.push("element class matches swatch/variant-color pattern");
  }

  // Radio buttons whose label has inline background-color style (common swatch trick)
  if (
    $("input[type='radio'][name*='options'] + label[style*='background']")
      .length ||
    $("label[style*='background-color']").length
  ) {
    weak.push("radio + label with inline background-color (color swatches)");
  }

  return resultFromSignals(strong, weak);
}

function detectCartDrawer($, html, text) {
  const strong = [];
  const weak = [];

  if (anyMatches($, [
    "[data-cart-drawer]",
    "cart-drawer",
    "[is='cart-drawer']",
    "[id*='cart-drawer']",
    "[id*='CartDrawer']"
  ])) {
    strong.push("cart-drawer custom element or data attribute present");
  }

  if (classOrAttrLooseMatch($, [
    "cart-drawer",
    "drawer-cart",
    "mini-cart",
    "minicart",
    "side-cart",
    "cart-aside",
    "cart-slideout",
    "cart-flyout",
    "drawer__cart",
    "ajax-cart"
  ])) {
    weak.push("element class matches cart-drawer/mini-cart/side-cart pattern");
  }

  if (htmlContainsAny(html, ["theme.settings.cart_type", "cart_type:'drawer'", '"cart_type":"drawer"'])) {
    strong.push("theme cart_type setting is drawer");
  }

  // If we explicitly see cart_type:'page' it's a page-style cart — treat as NOT drawer
  if (htmlContainsAny(html, ['"cart_type":"page"', "cart_type:'page'"])) {
    return { present: false, confidence: "high", evidence: ["theme cart_type set to page"] };
  }

  return resultFromSignals(strong, weak);
}

function detectStickyAddToCart($, url) {
  if (!/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  if (anyMatches($, ["[data-sticky-add-to-cart]", "[data-sticky-atc]", "sticky-add-to-cart"])) {
    strong.push("sticky add-to-cart custom element / data attribute present");
  }
  if (classOrAttrLooseMatch($, [
    "sticky-add-to-cart",
    "sticky-atc",
    "sticky-form",
    "atc-sticky",
    "floating-cart",
    "floating-atc",
    "mobile-add-to-cart",
    "mobile-atc",
    "add-to-cart-bar",
    "product-bar",
    "buy-bar"
  ])) {
    weak.push("element class matches sticky/floating add-to-cart pattern");
  }
  return resultFromSignals(strong, weak);
}

function detectStockIndicator($, text, url) {
  if (!/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  if (textContainsAny(text, [
    /\b(in|low) stock\b/i,
    /\bout of stock\b/i,
    /\bsold out\b/i,
    /\bonly\s+\d+\s+left\b/i,
    /\b\d+\s+in stock\b/i,
    /\bavailable now\b/i,
    /\bback in stock\b/i
  ])) {
    weak.push("page text contains in-stock / low-stock / sold-out language");
  }

  if (classOrAttrLooseMatch($, [
    "inventory",
    "stock-level",
    "availability",
    "in-stock",
    "out-of-stock",
    "stock-indicator",
    "stock-message"
  ])) {
    weak.push("element class matches inventory/stock/availability pattern");
  }

  if ($("[data-inventory], [data-stock]").length) {
    strong.push("element has data-inventory / data-stock attribute");
  }

  return resultFromSignals(strong, weak);
}

function detectNewsletterSignup($, text) {
  const strong = [];
  const weak = [];

  if ($("form[action*='customer_posted_at']").length ||
      $("form[action*='/contact#newsletter']").length ||
      $("input[name='contact[email]']").length ||
      $("input[name='customer[email]']").length) {
    strong.push("Shopify newsletter form / customer email input present");
  }

  if (classOrAttrLooseMatch($, [
    "newsletter",
    "subscribe-form",
    "email-signup",
    "footer__newsletter"
  ])) {
    weak.push("element class matches newsletter/subscribe-form pattern");
  }

  if (textContainsAny(text, [
    /\bsubscribe to our newsletter\b/i,
    /\bsign up to get\b/i,
    /\bjoin our (newsletter|mailing list|list)\b/i,
    /\bbe the first to know\b/i,
    /\b\d+%\s*off your first order\b/i
  ])) {
    weak.push("page text contains newsletter / subscribe / first-order-discount language");
  }

  return resultFromSignals(strong, weak);
}

function detectBreadcrumbs($, html) {
  const strong = [];
  const weak = [];

  // The word "breadcrumb" in a class/aria/id is unambiguous → strong.
  if (anyMatches($, [
    "[aria-label='Breadcrumb' i]",
    "nav[aria-label*='breadcrumb' i]",
    "ol.breadcrumb",
    "ol[class*='breadcrumb' i]",
    "ul[class*='breadcrumb' i]",
    "nav[class*='breadcrumb' i]",
    "[class*='breadcrumb' i]",
    "[id*='breadcrumb' i]"
  ])) {
    strong.push("element matches breadcrumb class/aria/id pattern");
  }

  if (/"@type"\s*:\s*"BreadcrumbList"/i.test(html)) {
    strong.push("BreadcrumbList schema present");
  }

  return resultFromSignals(strong, weak);
}

function detectFiltering($, url, text) {
  if (!/\/collections\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  // Shopify 2.0 standard
  if (anyMatches($, [
    "facet-filters-form",
    "filter-form",
    "[data-filters]",
    "[data-filter]",
    "[data-collection-filter]",
    "input[name^='filter.']",
    "form[id*='filter']"
  ])) {
    strong.push("Shopify facet/filter form present");
  }

  if (classOrAttrLooseMatch($, [
    "filter",
    "filters",
    "facet",
    "facets",
    "refinement",
    "refinements",
    "collection-filters",
    "filters-panel"
  ])) {
    weak.push("element class matches filter/facet/refinement");
  }

  if (textContainsAny(text, [/\bfilter by\b/i, /\brefine by\b/i, /\bshop by\b/i])) {
    weak.push("page text contains 'filter by' / 'refine by' / 'shop by'");
  }

  return resultFromSignals(strong, weak);
}

function detectSort($, url, text) {
  if (!/\/collections\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  if ($("select[name='sort_by'], select[name*='sort'], [data-sort], [data-sort-by]").length) {
    strong.push("sort select / data-sort attribute present");
  }
  if (classOrAttrLooseMatch($, ["sort-by", "collection-sort", "sort-menu", "sort-dropdown"])) {
    weak.push("element class matches sort dropdown pattern");
  }
  if (textContainsAny(text, [/\bsort by\b/i, /\bsorted by\b/i])) {
    weak.push("page text contains 'sort by'");
  }
  return resultFromSignals(strong, weak);
}

function detectProductVideo($, html, url) {
  if (!/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  if ($("video, video-source, [is='video']").length) {
    strong.push("native <video> element present");
  }
  if ($("iframe[src*='youtube' i], iframe[src*='vimeo' i], [data-media-type='video']").length) {
    strong.push("YouTube/Vimeo iframe or data-media-type=video present");
  }
  if (classOrAttrLooseMatch($, [
    "product-video",
    "media--video",
    "product__media--video",
    "video-player",
    "product-gallery__video"
  ])) {
    weak.push("element class matches product-video / media-video pattern");
  }
  if (htmlContainsAny(html, ['"media_type":"video"', '"media_type": "video"'])) {
    strong.push("product media JSON contains media_type: video");
  }
  return resultFromSignals(strong, weak);
}

function detectSizeGuide($, text, url) {
  if (!/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  if ($("[data-size-guide], [data-size-chart], [data-fit-guide]").length) {
    strong.push("data-size-guide / size-chart / fit-guide attribute present");
  }
  if (classOrAttrLooseMatch($, [
    "size-guide",
    "size-chart",
    "fit-guide",
    "sizing-guide",
    "size-chart-modal"
  ])) {
    weak.push("element class matches size-guide/size-chart");
  }
  if (textContainsAny(text, [/\bsize (guide|chart)\b/i, /\bfit guide\b/i, /\bsizing chart\b/i])) {
    weak.push("page text contains 'size guide' / 'size chart' / 'fit guide'");
  }
  return resultFromSignals(strong, weak);
}

function detectRelatedProducts($, html, url) {
  if (!/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  if (anyMatches($, [
    "product-recommendations",
    "[data-product-recommendations]",
    "[data-related-products]",
    "[data-recommendations]",
    "[id*='related-products' i]"
  ])) {
    strong.push("product-recommendations custom element / data attribute present");
  }

  // Explicit, unambiguous class names → strong
  if (anyMatches($, [
    "[class*='related-products' i]",
    "[class*='related-product' i]",
    "[class*='you-may-like' i]",
    "[class*='you-may-also-like' i]",
    "[class*='you-might-like' i]",
    "[class*='complete-the-look' i]",
    "[class*='frequently-bought' i]",
    "[class*='cross-sell' i]",
    "[class*='upsell' i]"
  ])) {
    strong.push("explicit related-products / cross-sell / upsell class present");
  }

  if (classOrAttrLooseMatch($, [
    "related-product",
    "related-products",
    "you-may-like",
    "you-might-like",
    "recommendation",
    "recommendations",
    "cross-sell",
    "upsell",
    "complete-the-look",
    "frequently-bought",
    "similar-products"
  ])) {
    weak.push("element class matches related/cross-sell/upsell/recommendations pattern");
  }

  // Heading text — "You may also like", "Related products", "Customers also bought" etc.
  const headings = $("h1, h2, h3, h4").map((_, el) => $(el).text().trim()).get().join(" | ");
  if (/\b(you\s+may\s+(also\s+)?like|related\s+products?|customers\s+also\s+(bought|viewed)|complete\s+the\s+look|frequently\s+bought|recommended\s+for\s+you)\b/i.test(headings)) {
    weak.push("page heading text matches related/recommendations language");
  }

  if (htmlContainsAny(html, ["/recommendations/products", "shopify-recommendations"])) {
    strong.push("Shopify product recommendations API in source");
  }
  return resultFromSignals(strong, weak);
}

function detectRecentlyViewed($, html) {
  const strong = [];
  const weak = [];

  if ($("[data-recently-viewed], recently-viewed-products, [is='recently-viewed']").length) {
    strong.push("data-recently-viewed element present");
  }

  // Explicit, unambiguous class names → strong
  if (anyMatches($, [
    "[class*='recently-viewed' i]",
    "[class*='recently_viewed' i]",
    "[id*='recently-viewed' i]",
    "[id*='recentlyViewed' i]"
  ])) {
    strong.push("explicit recently-viewed class/id present");
  }

  if (classOrAttrLooseMatch($, ["recently-viewed", "recently_viewed", "history-viewed", "viewed-products"])) {
    weak.push("element class matches recently-viewed");
  }
  if (htmlContainsAny(html, ["recentlyViewed", "recently_viewed", "RecentlyViewed"])) {
    weak.push("HTML/JS references recently viewed identifier");
  }

  // Heading text — "Recently viewed"
  const headings = $("h1, h2, h3, h4").map((_, el) => $(el).text().trim()).get().join(" | ");
  if (/\brecently\s+viewed\b/i.test(headings)) {
    weak.push("page heading text says 'Recently viewed'");
  }

  return resultFromSignals(strong, weak);
}

function detectMobileMenuToggle($) {
  const strong = [];
  const weak = [];

  // <button> has implicit role=button, so aria-label='Menu' alone is sufficient
  if ($("button[aria-label*='menu' i], button[aria-label*='navigation' i], button[aria-label*='nav' i], [aria-label*='menu' i][role='button'], button[aria-controls*='menu' i], button[aria-controls*='nav' i], summary[aria-expanded]").length) {
    strong.push("button with menu aria-label/aria-controls present");
  }
  // Explicit, unambiguous class names → strong
  if (anyMatches($, [
    "[class*='hamburger' i]",
    "[class*='menu-toggle' i]",
    "[class*='mobile-menu' i]",
    "[class*='mobile-nav' i]",
    "[class*='nav-toggle' i]",
    "[class*='burger' i]",
    "[class*='header__icon--menu' i]"
  ])) {
    strong.push("explicit hamburger / menu-toggle / mobile-nav class present");
  }
  if (classOrAttrLooseMatch($, [
    "hamburger",
    "menu-toggle",
    "mobile-nav",
    "mobile-menu",
    "nav-toggle",
    "drawer-toggle",
    "menu-icon",
    "burger"
  ])) {
    weak.push("element class matches hamburger/menu-toggle/mobile-nav");
  }
  return resultFromSignals(strong, weak);
}

function detectCurrencySelector($, html) {
  const strong = [];
  const weak = [];

  if ($("[name='currency'], [data-currency-selector], [data-currency]").length) {
    strong.push("currency select / data-currency present");
  }
  if (classOrAttrLooseMatch($, ["currency-selector", "currency-picker", "currency-form", "currency-switcher"])) {
    weak.push("element class matches currency-selector/picker");
  }
  if (/<form[^>]+action=["'][^"']*\/localization[^"']*["']/i.test(html)) {
    weak.push("localization form present");
  }
  return resultFromSignals(strong, weak);
}

function detectLanguageSelector($, html) {
  const strong = [];
  const weak = [];

  if ($("[name='locale_code'], [data-locale-selector], localization-form").length) {
    strong.push("locale_code select / localization-form present");
  }
  if (classOrAttrLooseMatch($, [
    "locale",
    "language-selector",
    "language-switcher",
    "lang-switcher"
  ])) {
    weak.push("element class matches language-selector/switcher/locale");
  }
  if (/<form[^>]+action=["'][^"']*\/locale[^"']*["']/i.test(html)) {
    weak.push("locale form action present");
  }
  return resultFromSignals(strong, weak);
}

function detectFreeShippingBar($, text) {
  const strong = [];
  const weak = [];

  if (classOrAttrLooseMatch($, [
    "free-shipping-bar",
    "shipping-bar",
    "shipping-progress",
    "cart-progress",
    "shipping-rewards",
    "shipping-meter",
    "free-shipping-progress"
  ])) {
    strong.push("element class matches free-shipping-bar / shipping-progress");
  }
  // Progressive ("$X away from free shipping") language is unambiguous → strong
  if (textContainsAny(text, [
    /you[']?re\s+\$?\d+(\.\d{1,2})?\s+away from free shipping/i,
    /spend\s+\$?\d+\s+more for free shipping/i,
    /unlock free shipping/i,
    /\$?\d+\s+to\s+(unlock|qualify for|get)\s+free shipping/i
  ])) {
    strong.push("page text contains progressive free-shipping language");
  }
  // Generic "free shipping over $X" or "free worldwide shipping over $X" — weak alone, but
  // promotes when combined with announcement-bar-style placement.
  if (textContainsAny(text, [
    /free\s+(worldwide\s+|domestic\s+|us\s+|international\s+)?shipping\s+(on\s+orders\s+)?over\s+\$?\d+/i,
    /free\s+shipping\s+on\s+all\s+orders/i
  ])) {
    weak.push("page text mentions free-shipping-over-threshold");
  }
  return resultFromSignals(strong, weak);
}

function detectLazyLoading($) {
  const strong = [];
  const weak = [];
  const lazyImgs = $("img[loading='lazy']").length;
  if (lazyImgs > 0) {
    strong.push(`${lazyImgs} <img loading="lazy"> elements`);
  }
  if ($("img[data-src], img[data-srcset], img.lazyload").length) {
    weak.push("data-src / lazyload-class images present");
  }
  return resultFromSignals(strong, weak);
}

function detectSchemaMarkup($, html) {
  const strong = [];
  if ($("script[type='application/ld+json']").length) {
    strong.push(`${$("script[type='application/ld+json']").length} JSON-LD schema blocks`);
  }
  if (/"@type"\s*:\s*"Product"/i.test(html)) strong.push("Product schema present");
  if (/"@type"\s*:\s*"Organization"/i.test(html)) strong.push("Organization schema present");
  return resultFromSignals(strong, []);
}

function detectAccessibilityBasics($) {
  const lang = $("html").attr("lang");
  const hasLang = Boolean(lang && lang.trim());
  const imgs = $("img");
  const imgCount = imgs.length;
  const imgsWithAlt = imgs.filter((_, el) => {
    const alt = el.attribs?.alt;
    return alt !== undefined && alt !== null;
  }).length;
  const altCoverageRatio = imgCount ? imgsWithAlt / imgCount : 1;
  const h1Count = $("h1").length;
  const skipLinkPresent = Boolean(
    $("a[href^='#'][class*='skip' i], a.skip-link, a[href='#main'], a[href='#main-content']").length
  );
  const hasAriaLabels = $("[aria-label], [aria-labelledby]").length > 0;

  return {
    hasLangAttr: hasLang,
    altCoverageRatio,
    imgCount,
    imgsWithoutAlt: imgCount - imgsWithAlt,
    h1Count,
    skipLinkPresent,
    hasAriaLabels
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run every detector and return a structured feature matrix.
 *
 * @param {CheerioAPI} $          Loaded cheerio root
 * @param {string}     html       Original HTML string
 * @param {string}     url        Page URL (used to scope product/collection checks)
 * @param {object}     runtimeHints Optional output from runtime probes (Playwright)
 * @param {string}     text       Cleaned body text (already extracted by caller)
 */

// ---------------------------------------------------------------------------
// Collection / product-card level detectors
//
// Pure static-HTML detection is unreliable for these because they often only
// reveal themselves on :hover. We therefore look at THREE complementary
// signals:
//   1. CSS rules in <style> blocks that target product-card selectors with
//      :hover { ... } (covers image-swap, overlay reveal).
//   2. Hidden / opacity-0 / scale-0 quick-add buttons inside cards — the
//      "ready to reveal on hover" pattern.
//   3. Runtime probe (set by Playwright in crawler.js) — actually hovers the
//      first card and reports whether ANY visible DOM mutation occurred.
//
// When 1, 2, or 3 fires we treat the feature as present. This addresses the
// merchant's specific complaint that the audit claimed "no hover state" or
// "no quick view" when both clearly existed.
// ---------------------------------------------------------------------------

function looksLikeProductCardSelector(selector) {
  return /(product[- _]?card|product[- _]?item|product[- _]?grid|grid[- _]?product|collection[- _]?card|product[- _]?tile|card[- _]?product|product__media|product-block)/i.test(selector);
}

function detectProductCardHover($, html, url, runtimeHints = {}) {
  // Skip on PDPs (this is about COLLECTION grid hover behaviour).
  if (/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  // (3) Runtime probe — strongest signal possible
  if (runtimeHints.productCardHoverChanges === true) {
    strong.push("runtime: hovering a product card revealed new content / image change");
  } else if (
    runtimeHints.productCardHoverChanges === false &&
    runtimeHints.productCardHoverTested === true
  ) {
    return { present: false, confidence: "high", evidence: ["runtime: hover produced no visible change"] };
  }

  // (1) CSS rules in <style> blocks
  let inlineHoverHits = 0;
  $("style").each((_, el) => {
    const css = $(el).html() || "";
    const ruleRegex = /([^{}]+):hover\s*[,>+~][^{]*\{[^}]*\}|([^{}]+):hover\s*\{[^}]*\}/g;
    let m;
    while ((m = ruleRegex.exec(css)) !== null) {
      const selector = m[1] || m[2] || "";
      if (looksLikeProductCardSelector(selector)) {
        inlineHoverHits += 1;
      }
    }
  });
  if (inlineHoverHits >= 2) {
    strong.push(`${inlineHoverHits} CSS :hover rules target product-card selectors`);
  } else if (inlineHoverHits === 1) {
    weak.push("a CSS :hover rule targets a product-card selector");
  }

  // Also scan the raw HTML (in case styles are external; sometimes the
  // critical-CSS preload includes a hint).
  if (/product[- _]?(card|item|grid)[^{]{0,80}:hover[^{]*\{[^}]*\b(opacity|transform|visibility|display|scale|translate|background)/i.test(html)) {
    weak.push("inline HTML references a hover transition on a product card");
  }

  // (2) Reveal-on-hover elements nested inside cards
  const cardScopes = $("[class*='product-card' i], [class*='product-item' i], [class*='grid-product' i], [class*='card-product' i], [class*='product__card' i], [class*='product-block' i], [class*='product-grid__item' i], li[class*='product' i].grid__item, [class*='collection__products'] [class*='card' i]");
  let cardsWithHoverChildren = 0;
  cardScopes.each((_, card) => {
    const $card = $(card);
    const hoverEls = $card.find(
      "[class*='hover' i], [class*='quick-add' i], [class*='quickadd' i], [class*='quick-view' i], [class*='quickview' i], [class*='quick-shop' i], [class*='card__hover' i], [class*='card-hover' i], [class*='show-on-hover' i], [class*='visible-on-hover' i], [data-show-on-hover], [class*='secondary-image' i], [class*='hover-image' i], [class*='product-card__image--secondary' i], [class*='media--secondary' i]"
    );
    if (hoverEls.length) cardsWithHoverChildren += 1;
  });
  if (cardsWithHoverChildren >= 2) {
    strong.push(`${cardsWithHoverChildren} product cards contain hover-only / secondary-image / quick-add elements`);
  } else if (cardsWithHoverChildren === 1) {
    weak.push("at least one product card contains a hover-only / secondary-image element");
  }

  // Two stacked <img> tags inside cards = classic image-swap pattern
  if ($("[class*='product-card' i] img + img, [class*='product-item' i] img + img, [class*='card__media' i] img + img, [class*='product-grid__item' i] img + img").length >= 1) {
    weak.push("product card has two stacked images (image-swap on hover pattern)");
  }

  return resultFromSignals(strong, weak);
}

function detectProductCardQuickAdd($, html, url, runtimeHints = {}) {
  if (/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  if (runtimeHints.quickAddRevealedOnHover === true) {
    strong.push("runtime: quick-add button revealed on card hover");
  }

  // Look for quick-add / quick-view buttons NESTED inside product card containers.
  const cardScopes = $("[class*='product-card' i], [class*='product-item' i], [class*='grid-product' i], [class*='card-product' i], [class*='product__card' i], [class*='product-grid__item' i], li[class*='product' i].grid__item");
  let cardsWithQuickAdd = 0;
  cardScopes.each((_, card) => {
    const $card = $(card);
    const qa = $card.find(
      "[class*='quick-add' i], [class*='quickadd' i], [class*='quick-view' i], [class*='quickview' i], [class*='quick-shop' i], [class*='quickshop' i], [class*='qv-trigger' i], [class*='qv-button' i], [data-quick-add], [data-quickadd], [data-quick-view], [data-quickview], [data-quick-shop], [data-quickshop], [data-qv-handle], [data-quick-view-button], quick-add-modal, quick-add"
    );
    if (qa.length) cardsWithQuickAdd += 1;
  });
  if (cardsWithQuickAdd >= 2) {
    strong.push(`${cardsWithQuickAdd} product cards include a quick-add / quick-view button`);
  } else if (cardsWithQuickAdd === 1) {
    weak.push("at least one product card includes a quick-add / quick-view button");
  }

  // Dawn-style modal at page level (cards open it)
  if ($("quick-add-modal, quick-add, product-form-component[data-quick-add]").length) {
    strong.push("page-level quick-add custom element present");
  }

  return resultFromSignals(strong, weak);
}

function detectProductCardBadges($, url) {
  if (/\/products\//i.test(url || "")) return unknown();

  const strong = [];
  const weak = [];

  const cardScopes = $("[class*='product-card' i], [class*='product-item' i], [class*='grid-product' i], [class*='card-product' i], [class*='product__card' i], [class*='product-grid__item' i], li[class*='product' i].grid__item");
  if (!cardScopes.length) return unknown();

  let cardsWithBadge = 0;
  const badgeKinds = new Set();
  cardScopes.each((_, card) => {
    const $card = $(card);
    const badges = $card.find(
      "[class*='badge' i], [class*='ribbon' i], [class*='flag' i], [class*='card__badge' i], [class*='product-card__badge' i], [class*='product-tag' i], [class*='product-label' i], [class*='sale-badge' i], [class*='on-sale' i], [class*='best-seller' i], [class*='bestseller' i], [class*='sold-out' i]"
    );
    if (badges.length) {
      cardsWithBadge += 1;
      badges.each((_, b) => {
        const t = ($(b).text() || "").trim().toLowerCase();
        if (/\b(sale|on sale|-\d+%|\d+% ?off|save|new|best ?seller|trending|top choice|sold out|coming soon|hot|popular|exclusive)\b/.test(t)) {
          badgeKinds.add(t.slice(0, 30));
        }
      });
    }
  });

  if (cardsWithBadge >= 3 && badgeKinds.size >= 2) {
    strong.push(`${cardsWithBadge} cards have badges across ${badgeKinds.size} distinct kinds`);
  } else if (cardsWithBadge >= 1) {
    weak.push(`${cardsWithBadge} card(s) contain badge / tag elements`);
  }

  return resultFromSignals(strong, weak);
}

function detectSalePriceDisplay($, url) {
  const strong = [];
  const weak = [];

  if ($("s, del, [class*='compare-at' i], [class*='compare_at' i], [class*='price--was' i], [class*='strike' i], [class*='original-price' i], [class*='was-price' i], [class*='regular-price' i].on-sale").length) {
    strong.push("strike-through / compare-at price element present");
  }
  if ($("[class*='discount' i], [class*='save' i], [class*='savings' i], [class*='price__sale' i], [class*='price--on-sale' i]").length) {
    weak.push("discount / savings element present");
  }
  return resultFromSignals(strong, weak);
}

function detectAnnouncementBarWithCta($) {
  const candidates = $("[class*='announcement' i], [data-section-type*='announcement']");
  if (!candidates.length) return unknown();
  let withLink = 0;
  candidates.each((_, el) => {
    if ($(el).find("a[href]:not([href='#']):not([href=''])").length) withLink += 1;
  });
  if (withLink >= 1) {
    return { present: true, confidence: "high", evidence: [`${withLink} announcement bar(s) include a clickable CTA link`] };
  }
  // bar exists but has no CTA link — that's a real, observable finding
  return { present: false, confidence: "high", evidence: ["announcement bar present but contains no clickable CTA"] };
}

export function detectFeatures($, html, url, runtimeHints = {}, text = "") {
  const features = {
    stickyHeader:           detectStickyHeader($, html, runtimeHints),
    announcementBar:        detectAnnouncementBar($, html),
    announcementBarWithCta: detectAnnouncementBarWithCta($),
    heroSection:            detectHeroSection($),
    trustSignals:           detectTrustSignals($, text),
    productMediaZoom:       detectProductMediaZoom($, html, url),
    quickView:              detectQuickView($, html, text),
    productCardQuickAdd:    detectProductCardQuickAdd($, html, url, runtimeHints),
    productCardHover:       detectProductCardHover($, html, url, runtimeHints),
    productCardBadges:      detectProductCardBadges($, url),
    salePriceDisplay:       detectSalePriceDisplay($, url),
    wishlist:               detectWishlist($, html, text),
    liveChat:               detectLiveChat(html),
    reviews:                detectReviews($, html, text),
    searchBar:              detectSearchBar($),
    megaMenu:               detectMegaMenu($, html),
    variantSwatches:        detectVariantSwatches($, html, url),
    cartDrawer:             detectCartDrawer($, html, text),
    stickyAddToCart:        detectStickyAddToCart($, url),
    stockIndicator:         detectStockIndicator($, text, url),
    newsletterSignup:       detectNewsletterSignup($, text),
    breadcrumbs:            detectBreadcrumbs($, html),
    filtering:              detectFiltering($, url, text),
    sort:                   detectSort($, url, text),
    productVideo:           detectProductVideo($, html, url),
    sizeGuide:              detectSizeGuide($, text, url),
    relatedProducts:        detectRelatedProducts($, html, url),
    recentlyViewed:         detectRecentlyViewed($, html),
    mobileMenuToggle:       detectMobileMenuToggle($),
    currencySelector:       detectCurrencySelector($, html),
    languageSelector:       detectLanguageSelector($, html),
    freeShippingBar:        detectFreeShippingBar($, text),
    lazyLoading:            detectLazyLoading($),
    schemaMarkup:           detectSchemaMarkup($, html)
  };

  const accessibility = detectAccessibilityBasics($);

  return { features, accessibility };
}

/**
 * Group features by present/absent/uncertain for prompt construction.
 *
 * Aggregation rule across multiple pages of the same area: a feature is
 * counted as PRESENT if it is detected with high confidence on at least one
 * relevant page (e.g. zoom on at least one product page). It is ABSENT only
 * if every relevant page checked confirms it's missing. Otherwise it goes to
 * UNCERTAIN.
 */
export function aggregateFeatureMatrix(pages = []) {
  const featureKeys = [
    "stickyHeader",
    "announcementBar",
    "announcementBarWithCta",
    "heroSection",
    "trustSignals",
    "productMediaZoom",
    "quickView",
    "productCardQuickAdd",
    "productCardHover",
    "productCardBadges",
    "salePriceDisplay",
    "wishlist",
    "liveChat",
    "reviews",
    "searchBar",
    "megaMenu",
    "variantSwatches",
    "cartDrawer",
    "stickyAddToCart",
    "stockIndicator",
    "newsletterSignup",
    "breadcrumbs",
    "filtering",
    "sort",
    "productVideo",
    "sizeGuide",
    "relatedProducts",
    "recentlyViewed",
    "mobileMenuToggle",
    "currencySelector",
    "languageSelector",
    "freeShippingBar",
    "lazyLoading",
    "schemaMarkup"
  ];

  const matrix = {
    present: [],     // confidence high → feature exists
    likelyPresent: [], // confidence medium → probably exists
    uncertain: [],   // could not tell → don't make assertions either way
    absent: []       // confirmed missing → safe to recommend adding
  };

  for (const key of featureKeys) {
    const samples = pages
      .map((p) => p?.featureDetection?.features?.[key])
      .filter(Boolean);

    if (!samples.length) {
      matrix.uncertain.push({ key, evidence: [], reason: "not tested" });
      continue;
    }

    // Highest confidence wins for "present"
    const highPositive = samples.find((s) => s.present === true && s.confidence === "high");
    if (highPositive) {
      matrix.present.push({ key, evidence: highPositive.evidence.slice(0, 4) });
      continue;
    }

    const mediumPositive = samples.find((s) => s.present === true && s.confidence === "medium");
    if (mediumPositive) {
      matrix.likelyPresent.push({ key, evidence: mediumPositive.evidence.slice(0, 4) });
      continue;
    }

    const lowPositive = samples.find((s) => s.present === true && s.confidence === "low");
    if (lowPositive) {
      // Single weak signal — keep in uncertain bucket; recommendation should be "validate", not "add"
      matrix.uncertain.push({ key, evidence: lowPositive.evidence.slice(0, 4), reason: "weak single signal" });
      continue;
    }

    const allConfirmedAbsent = samples.every((s) => s.present === false);
    const anyConfirmedAbsent = samples.some((s) => s.present === false && s.confidence === "high");

    if (allConfirmedAbsent && anyConfirmedAbsent) {
      matrix.absent.push({ key, evidence: ["confirmed missing across all checked pages"] });
      continue;
    }

    matrix.uncertain.push({ key, evidence: [], reason: "no signal" });
  }

  return matrix;
}

/**
 * Human-friendly labels for features (used in the prompt and in post-processing).
 */
export const FEATURE_LABELS = {
  stickyHeader:           "Sticky header (header stays visible on scroll)",
  announcementBar:        "Top announcement / promo bar",
  announcementBarWithCta: "Announcement bar contains a clickable CTA link",
  heroSection:            "Above-the-fold hero / banner section",
  trustSignals:           "Trust / USP / value-prop strip (shipping, returns, warranty icons)",
  productMediaZoom:       "Product image zoom / lightbox / magnify",
  quickView:              "Quick view / quick add / quick shop on product cards",
  productCardQuickAdd:    "Quick-add / quick-view button on collection product cards",
  productCardHover:       "Product-card hover state (image swap, overlay, reveal)",
  productCardBadges:      "Badges on product cards (Sale, New, Best-seller, etc.)",
  salePriceDisplay:       "Strike-through old price + new price + savings on sale items",
  wishlist:               "Wishlist / save-for-later",
  liveChat:               "Live chat widget",
  reviews:                "Customer reviews / star ratings",
  searchBar:              "Search bar (predictive or standard)",
  megaMenu:               "Mega menu navigation",
  variantSwatches:        "Variant / colour swatches on product page",
  cartDrawer:             "Cart drawer (slide-out cart) vs cart page",
  stickyAddToCart:        "Sticky / floating add-to-cart on product page",
  stockIndicator:         "Stock / inventory indicator on product page",
  newsletterSignup:       "Newsletter signup form",
  breadcrumbs:            "Breadcrumb navigation",
  filtering:              "Collection filtering / facets",
  sort:                   "Collection sort dropdown",
  productVideo:           "Product video in gallery",
  sizeGuide:              "Size guide / size chart",
  relatedProducts:        "Related / recommended / cross-sell products",
  recentlyViewed:         "Recently viewed products",
  mobileMenuToggle:       "Mobile hamburger menu",
  currencySelector:       "Currency selector",
  languageSelector:       "Language selector",
  freeShippingBar:        "Free-shipping progress bar",
  lazyLoading:            "Image lazy loading",
  schemaMarkup:           "Structured data / schema markup"
};

/**
 * Keywords that, if seen in an LLM recommendation, indicate it is asking the
 * merchant to ADD/IMPLEMENT that feature (vs. optimise an existing one).
 * Used by auditService.js to strip false-positive recommendations.
 */
export const ADD_FEATURE_PHRASES = {
  stickyHeader:           ["sticky header", "make the header sticky", "add sticky navigation", "implement sticky header"],
  productMediaZoom:       ["image zoom", "product zoom", "zoom functionality", "add zoom", "implement zoom", "add a lightbox", "lightbox functionality", "image magnifier"],
  quickView:              ["quick view", "quick shop", "quick add", "implement quickview", "add quickview", "add quick view", "quick-view functionality", "quick view feature"],
  productCardQuickAdd:    ["quick-add functionality", "quick add on product cards", "quick add functionality", "add quick-add", "implement quick-add", "quick-add buttons on product cards", "quick view on product cards", "add quick view on product cards"],
  productCardHover:       ["hover-state animations", "hover state animations", "add hover state", "add hover effects", "hover effects for product cards", "card hover effects", "hover animation on product cards", "secondary image on hover", "image swap on hover"],
  productCardBadges:      ["product badges", "badges on cards", "card badges", "best-seller badge", "new arrival badge", "add badges"],
  salePriceDisplay:       ["sale price display", "show discounted prices", "add sale indicators", "strike-through price", "discount indicators", "sale and discount indicators", "clear pricing with sale", "discount labelling"],
  wishlist:               ["wishlist", "add to favorites", "favourite button", "save for later"],
  liveChat:               ["live chat", "chat widget", "implement chat", "add chat"],
  reviews:                ["review system", "customer reviews", "star ratings", "add reviews", "install reviews app", "review widget", "reviews app like"],
  searchBar:              ["search bar", "site search", "implement search"],
  megaMenu:               ["mega menu", "mega-menu", "implement mega menu"],
  variantSwatches:        ["color swatch", "colour swatch", "variant swatches", "show swatches", "color/variant options directly on collection", "colour/variant options directly on collection", "variant options on collection grid", "color options on cards"],
  cartDrawer:             ["cart drawer", "slide-out cart", "mini cart", "ajax cart"],
  stickyAddToCart:        ["sticky add to cart", "floating add to cart", "sticky atc"],
  stockIndicator:         ["stock indicator", "inventory indicator", "low stock", "stock level"],
  newsletterSignup:       ["newsletter signup", "email capture", "subscribe form"],
  breadcrumbs:            ["breadcrumbs", "breadcrumb navigation"],
  filtering:              ["add filtering", "implement filtering", "implement filters", "add filters"],
  sort:                   ["add sorting", "implement sorting", "sort dropdown", "add sort"],
  productVideo:           ["product video", "video demonstration", "add video"],
  sizeGuide:              ["size guide", "size chart", "fit guide"],
  relatedProducts:        ["related products", "cross-sell", "upsell", "you may also like", "recommendation widget"],
  recentlyViewed:         ["recently viewed", "recently-viewed", "recently viewed products"],
  mobileMenuToggle:       ["hamburger menu", "mobile menu toggle"],
  freeShippingBar:        ["free shipping bar", "shipping progress"],
  announcementBar:        ["announcement bar", "promo bar"],
  trustSignals:           ["trust badges", "trust strip", "usp strip", "value prop strip", "trust signals", "payment method security badges", "shipping guarantee icons"]
};
