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

    // Free-shipping phrasing varies a lot. Allow qualifier words between "free"
    // and "shipping" ("free U.S. ground shipping", "free express shipping",
    // "free worldwide shipping over $100") — the old /\bfree shipping\b/ missed
    // all of these, which is why benefit/announcement bars were not registering.
    const freeShippingRe = /\bfree\b[\w.&'’\- ]{0,25}\bshipping\b/i;
    const guaranteeRe = /\b(?:\d+[- ]?days?\s+)?(?:money[- ]back\s+|satisfaction\s+)?(?:guarantee|warranty)\b|\b\d+[- ]?days?\s+(?:returns?|guarantee)\b|\brisk[- ]free\b/i;

    // Text-content heuristic (very common phrases on trust strips)
    if (textContainsAny(text, [
      freeShippingRe,
      /\bfree (returns?|exchanges?)\b/i,
      guaranteeRe,
      /\bsecure checkout\b/i,
      /\bsecure payments?\b/i,
      /\blifetime warranty\b/i,
      /\bshop with confidence\b/i,
      /\bwhy choose us\b/i,
      /\btrusted by [\d,]+ /i
    ])) {
      weak.push("page text contains trust-strip language (shipping/returns/warranty/secure)");
    }

    // Announcement / benefit bars almost always PAIR free shipping with a
    // guarantee. That co-occurrence is a reliable trust-strip signal on its own,
    // so treat it as strong (covers stores whose strip uses custom class names).
    const hasFreeShipping = freeShippingRe.test(text);
    const hasGuarantee = guaranteeRe.test(text);
    if (hasFreeShipping && hasGuarantee) {
      strong.push("free-shipping + guarantee pair present (trust/benefit strip)");
    }

    // Multiple trust phrases on the same page → upgrade to strong
    const trustPhraseMatches = (text.match(/\bfree\b[\w.&'’\- ]{0,25}\bshipping\b|\bfree returns?\b|\bmoney[- ]back guarantee\b|\bsecure checkout\b|\bsecure payments?\b|\b\d+[- ]?days?\s+(?:returns?|guarantee)\b|\blifetime warranty\b|\brisk[- ]free\b/gi) || []).length;
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

  // Featured product showcase on the home page — a curated "best sellers",
  // "most loved", "shop by", "featured" grid/section. Absence is hard to prove
  // (soft content), so this NEVER returns a high-confidence false — it returns
  // present / likelyPresent / null, keeping it out of the matrix's `absent`
  // bucket so the audit can't wrongly recommend "add a featured collection".
  function detectFeaturedProducts($, html, url) {
    // Home / general pages only (PDP and collection have product grids by nature).
    if (/\/products\/|\/collections\//i.test(url || "")) return unknown();
    const strong = [];
    const weak = [];

    if (anyMatches($, [
      "[class*='featured-collection' i]",
      "[class*='featured-product' i]",
      "[class*='best-seller' i]",
      "[class*='bestseller' i]",
      "[class*='product-showcase' i]",
      "[class*='shop-by' i]",
      "[data-section-type*='featured-collection' i]",
      "[data-section-type*='featured-product' i]"
    ])) {
      strong.push("featured-collection / best-sellers / shop-by section class present");
    }

    // Heading text typical of a homepage product showcase. Many themes put the
    // section title in a styled <div>/<strong> with a *__heading / *-title class
    // rather than a real <h_> tag (e.g. berootedin's "shop by Concern"), so scan
    // heading/title-classed elements and short bold text too — not just h1-h4.
    const headings = $(
      "h1, h2, h3, h4, h5, h6, [class*='heading' i], [class*='title' i], [class*='subheading' i], [class*='section-title' i], strong, b"
    )
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t && t.length <= 60) // heading-like only; skip long bold paragraphs
      .join(" | ");
    if (/\b(best ?sellers?|most ?loved|fan favou?rites?|featured (?:products?|collection)|shop (?:by|the|our)|top picks|recommended (?:for you|products?|kits?)|our (?:products?|range|collection)|trending|customer favou?rites?)\b/i.test(headings)) {
      strong.push("homepage heading indicates a featured / best-sellers / shop-by product section");
    }

    // A product grid living in main content (links to /products/) is a showcase.
    // Exclude links inside overlays/drawers (predictive search, cart, modal,
    // popup) and header/footer — a search drawer's suggested products are not a
    // homepage showcase.
    const overlaySel =
      "[class*='predictive' i], [class*='search-drawer' i], [class*='search-modal' i], [class*='drawer' i], [class*='modal' i], [class*='popup' i], [class*='cart' i], header, footer, nav, [hidden], [aria-hidden='true']";
    const productLinks = $(
      "main a[href*='/products/'], [class*='product-grid' i] a[href*='/products/'], [class*='product-card' i] a[href*='/products/']"
    ).filter((_, a) => $(a).closest(overlaySel).length === 0).length;
    if (productLinks >= 3) {
      weak.push(`${productLinks} product links in a homepage section (product showcase)`);
    }

    return resultFromSignals(strong, weak);
  }

  // Brand story / mission / founder narrative. Soft content → NEVER returns a
  // high-confidence false (absence of signal does not prove the brand has no
  // story), so it stays out of the matrix's `absent` bucket.
  function detectBrandStory($, text, html) {
    const strong = [];
    const weak = [];

    if (anyMatches($, [
      "[class*='brand-story' i]", "[class*='our-story' i]", "[class*='our-mission' i]",
      "[class*='brand-mission' i]", "[class*='about-section' i]", "[class*='about-us' i]",
      "[class*='about-brand' i]", "[class*='founder' i]", "[class*='mission-statement' i]",
      "[class*='brand-intro' i]",
      "[data-section-type*='about' i]", "[data-section-type*='story' i]", "[data-section-type*='mission' i]"
    ])) {
      strong.push("dedicated about/story/mission/founder section class present");
    }

    const headings = $("h1, h2, h3, h4").map((_, el) => $(el).text().trim()).get().join(" | ");
    if (/\b(our\s+(story|mission|values|philosophy|journey|promise)|about\s+us|who\s+we\s+are|meet\s+(the|our)\s+(team|founder|makers?)|why\s+we\s+(started|began)|the\s+story\s+behind|what\s+we\s+stand\s+for)\b/i.test(headings)) {
      strong.push("section heading uses brand-story / mission / founder language");
    }

    if (textContainsAny(text, [
      /\bour\s+mission\s+is\b/i,
      /\bcommitted to (sustainable|ethical|responsible|reducing|delivering)\b/i,
      /\bfounded in\s+\d{4}\b/i,
      /\bwe\s+(believe|started|began|founded|are\s+committed|created)\b/i,
      /\bour\s+(passion|journey|promise|philosophy|values|story)\b/i,
      /\bthe\s+story\s+behind\b/i,
      /\bwhy\s+we\s+(made|created|built)\s+it\b/i
    ])) {
      weak.push("page text contains brand-mission / founding-story language");
    }

    if ($("a[href*='/pages/about' i], a[href*='/pages/our-story' i], a[href*='/pages/story' i], a[href*='/pages/mission' i]").length) {
      weak.push("link to an About / Our Story / Mission page present");
    }

    return resultFromSignals(strong, weak);
  }

  // ---- Retention / AOV opportunity detectors --------------------------------
  // These let the audit RECOMMEND a high-value lever when it is genuinely
  // missing (previously impossible — no detector existed, so the checkpoint
  // never reached "confirmed missing"). Each returns present on a clear signal,
  // and confirmed-absent ONLY on the page type where the feature would live and
  // only when that page was actually crawled. All the signals are server-
  // rendered in Shopify (native selling plans, bundle sections, tiered-price
  // tables), so a confirmed-absent verdict is reliable rather than a runtime
  // guess — unlike hover/back-to-top, which stay uncertain when unseen.

  function detectSubscription($, html, text, url) {
    const strong = [];
    const weak = [];
    if (anyMatches($, [
      "[name='selling_plan']", "[data-selling-plan]", "[data-selling-plan-id]",
      "[class*='selling-plan' i]", "[id*='selling-plan' i]",
      "[class*='subscription' i]", "[data-recharge]", "[class*='recharge' i]",
      "[class*='seal-subscriptions' i]", "[class*='skio' i]", "[class*='appstle' i]",
      "[class*='subscriptions-' i]"
    ])) {
      strong.push("subscription / selling-plan widget present");
    }
    if (/selling_plan_groups|sellingPlanGroups|"selling_plan"/i.test(html)) {
      strong.push("product data exposes selling plans (subscription)");
    }
    if (textContainsAny(text, [
      /\bsubscribe (?:&|and) save\b/i,
      /\bsubscribe\b[^\n]{0,20}\bsave\b/i,
      /\bdeliver(?:y)? every\b/i,
      /\bevery \d+ (?:days|weeks|months)\b/i,
      /\bone[- ]time purchase\b/i,
      /\bsubscription\b/i
    ])) {
      weak.push("page text references subscription / subscribe-and-save");
    }
    if (strong.length || weak.length) return resultFromSignals(strong, weak);
    // Selling plans render server-side on the PDP. Crawled a product page with
    // none → genuinely absent → safe to recommend adding subscriptions.
    if (/\/products\//i.test(url || "")) return notPresent();
    return unknown();
  }

  function detectProductBundle($, html, text, url) {
    const strong = [];
    const weak = [];
    if (anyMatches($, [
      "[class*='bundle' i]", "[id*='bundle' i]", "[data-bundle]",
      "[class*='kit-builder' i]", "[class*='build-your-own' i]", "[class*='build-a-box' i]",
      "[class*='frequently-bought' i]", "[class*='bought-together' i]", "[class*='product-set' i]",
      "[class*='fast-bundle' i]", "[class*='unlimited-bundle' i]"
    ])) {
      strong.push("bundle / kit / bought-together section present");
    }
    if (textContainsAny(text, [
      /\bbundle (?:&|and) save\b/i,
      /\bbuild your own\b/i,
      /\bbuild a (?:box|kit|bundle)\b/i,
      /\bfrequently bought together\b/i,
      /\bcomplete (?:the|your) (?:set|kit|routine|look)\b/i,
      /\bstarter (?:kit|set|pack|bundle)\b/i,
      /\b(?:save|get) \d+% when you (?:buy|bundle)\b/i,
      /\bbuy (?:the )?(?:set|bundle|kit)\b/i,
      /\bbundle\b/i
    ])) {
      weak.push("page text references a bundle / kit / starter-set offer");
    }
    if ($("a[href*='bundle' i], a[href*='starter-kit' i], a[href*='kit' i][href*='/products/'], a[href*='set' i][href*='/products/']").length) {
      weak.push("link to a bundle / kit / set product");
    }
    // Multi-pack variants ("510 g x 2 pcs", "pack of 2", "3-pack", "combo",
    // "value pack") ARE a bundle/volume offer, and a "Combos" collection in the
    // nav is a bundle hub. Many Indian/FMCG stores (e.g. MyFitness) do bundling
    // entirely this way — without this the detector wrongly reports "no bundles".
    const MULTIPACK = /\b(?:x\s?\d+\s?(?:pcs?|packs?|units?)|\d+\s?(?:pcs?|units?)\s?(?:pack)?|pack of \d+|\d+[-\s]?pack|multi[-\s]?pack|combo|value pack|family pack|set of \d+|\bduo\b|\btrio\b|\d+\s?x\b)\b/i;
    const optionText = $("select option, [class*='variant' i], [class*='swatch' i], label, .product-form__input")
      .map((_, el) => $(el).text() || "").get().join(" | ");
    if (MULTIPACK.test(optionText) || MULTIPACK.test(text)) {
      strong.push("multi-pack / combo variant offered (e.g. 'x 2 pcs', 'pack of N', 'combo')");
    }
    if ($("a[href*='/collections/combo' i], a[href*='/collections/bundle' i], a[href*='/collections/value' i]").length ||
        /\bcombos?\b/i.test($("nav, header, [role='navigation']").text() || "")) {
      strong.push("Combos / bundles collection present in navigation");
    }
    if (strong.length || weak.length) return resultFromSignals(strong, weak);
    if (/\/products\//i.test(url || "")) return notPresent();
    return unknown();
  }

  function detectQuantityBreaks($, html, text, url) {
    if (!/\/products\//i.test(url || "")) return unknown(); // tiered pricing lives on the PDP
    const strong = [];
    const weak = [];
    if (anyMatches($, [
      "[class*='quantity-break' i]", "[class*='volume-discount' i]", "[class*='tiered-pric' i]",
      "[class*='qty-break' i]", "[class*='bulk-discount' i]", "[data-volume-discount]",
      "[class*='quantity-discount' i]", "[class*='price-break' i]"
    ])) {
      strong.push("quantity-break / volume-discount table present");
    }
    if (textContainsAny(text, [
      /\bbuy \d+,? (?:get|save)\b/i,
      /\bvolume discount\b/i,
      /\bbulk (?:discount|pricing|savings?)\b/i,
      /\bsave \d+% when you buy \d+\b/i,
      /\bbuy more,? save more\b/i,
      /\bquantity discount\b/i
    ])) {
      weak.push("page text references quantity breaks / volume discounts");
    }
    // Multi-pack variants ("x 2 pcs", "pack of 2", "3-pack", "combo") are a
    // quantity/volume incentive expressed through variants — count them as
    // present so we don't falsely report "no volume pricing" (e.g. MyFitness).
    const MULTIPACK = /\b(?:x\s?\d+\s?(?:pcs?|packs?|units?)|pack of \d+|\d+[-\s]?pack|multi[-\s]?pack|combo|value pack|family pack|set of \d+|\bduo\b|\btrio\b)\b/i;
    const optionText = $("select option, [class*='variant' i], [class*='swatch' i], label, .product-form__input")
      .map((_, el) => $(el).text() || "").get().join(" | ");
    if (MULTIPACK.test(optionText)) {
      strong.push("multi-pack / combo variant offered (volume pricing via variants)");
    }
    if (strong.length || weak.length) return resultFromSignals(strong, weak);
    return notPresent();
  }

  // Guided selling (quiz / product finder). POSITIVE-ONLY: quizzes are often
  // embedded via JS/iframe (Octane AI, etc.) so a static "not found" is not
  // proof of absence — and recommending a quiz to every store would be noise.
  // So this only marks PRESENT (suppressing a false "add a quiz"), never absent.
  function detectGuidedSelling($, html, text, url) {
    if (/\/products\/|\/collections\//i.test(url || "")) return unknown();
    const strong = [];
    const weak = [];
    if (anyMatches($, [
      "[class*='quiz' i]", "[id*='quiz' i]", "[class*='product-finder' i]",
      "[class*='recommendation-quiz' i]", "[data-quiz]", "[class*='octane' i]"
    ])) {
      strong.push("quiz / product-finder element present");
    }
    if ($("a[href*='quiz' i], a[href*='finder' i], a[href*='find-your' i], a[href*='help-me-choose' i]").length) {
      strong.push("link to a quiz / product-finder page");
    }
    if (textContainsAny(text, [
      /\btake (?:the|our) quiz\b/i,
      /\bfind your (?:perfect|ideal|right)\b/i,
      /\bhelp me choose\b/i,
      /\bwhich (?:one|product|cream|formula) is right for (?:you|me)\b/i
    ])) {
      weak.push("page text invites a guided 'find your product' / quiz flow");
    }
    return resultFromSignals(strong, weak); // present or unknown, never absent
  }

  // ---- Product-page decision-point reassurance detectors --------------------
  // These surface "add X when missing" for high-value PDP persuasion elements
  // that previously had checkpoints but no detector (so they were never
  // recommended). All signals are server-rendered text/markup, so a
  // confirmed-absent verdict on a crawled product page is reliable.

  function detectProductFaq($, text, html, url) {
    if (!/\/products\//i.test(url || "")) return unknown();
    const strong = [];
    const weak = [];
    if (anyMatches($, [
      "[class*='faq' i]", "[id*='faq' i]", "[data-faq]", "[class*='accordion' i][class*='faq' i]"
    ])) {
      strong.push("FAQ section / accordion present on the product page");
    }
    if (/FAQPage|"@type"\s*:\s*"Question"|itemtype=["'][^"']*\/Question/i.test(html)) {
      strong.push("FAQPage / Question structured data present");
    }
    const headings = $("h2, h3, h4, summary, [class*='accordion__title' i], [class*='accordion-title' i]")
      .map((_, el) => $(el).text().trim()).get().join(" | ");
    if (/\b(frequently asked questions|faqs?|common questions|questions (?:&|and) answers|q\s*&\s*a)\b/i.test(headings)) {
      strong.push("heading indicates a FAQ / Q&A block");
    }
    if (strong.length || weak.length) return resultFromSignals(strong, weak);
    return notPresent(); // crawled a PDP with no FAQ → recommend adding one
  }

  function detectFreeShipCallout($, text, html, url) {
    if (!/\/products\//i.test(url || "")) return unknown();
    const strong = [];
    const weak = [];
    if (textContainsAny(text, [
      /\bfree\b[\w.&'’\- ]{0,25}\bshipping\b/i,
      /\bfree (?:returns?|delivery)\b/i,
      /\bships? free\b/i,
      /\bfree shipping over\b/i
    ])) {
      strong.push("free-shipping reassurance present on the product page");
    }
    if (strong.length || weak.length) return resultFromSignals(strong, weak);
    return notPresent(); // PDP doesn't surface a free-shipping callout → recommend
  }

  function detectReturnsGuarantee($, text, html, url) {
    if (!/\/products\//i.test(url || "")) return unknown();
    const strong = [];
    const weak = [];
    if (textContainsAny(text, [
      /\bmoney[- ]back guarantee\b/i,
      /\b\d+[- ]?day(?:s)?\s+(?:money[- ]back\s+)?(?:guarantee|returns?|trial)\b/i,
      /\b(?:free|easy|hassle[- ]free)\s+returns?\b/i,
      /\bsatisfaction guarantee(?:d)?\b/i,
      /\brefund policy\b/i,
      /\brisk[- ]free\b/i,
      /\breturn policy\b/i
    ])) {
      strong.push("returns / refund / money-back-guarantee reassurance present on the product page");
    }
    if (strong.length || weak.length) return resultFromSignals(strong, weak);
    return notPresent(); // PDP doesn't surface returns/guarantee reassurance → recommend
  }

  function detectUrgency($, text, html, url) {
    if (!/\/products\//i.test(url || "")) return unknown(); // urgency near the PDP CTA
    const strong = [];
    const weak = [];
    if (anyMatches($, [
      "[class*='countdown' i]", "[class*='timer' i]", "[data-countdown]",
      "[class*='urgency' i]", "[class*='shipping-timer' i]", "[class*='order-within' i]"
    ])) {
      strong.push("urgency / countdown element present near the CTA");
    }
    if (textContainsAny(text, [
      /\btoday only\b/i,
      /\border within\b/i,
      /\border in the next\b/i,
      /\bships? today if\b/i,
      /\bends (?:in|soon|tonight)\b/i,
      /\blimited[- ]time\b/i,
      /\bhurry\b/i,
      /\bselling fast\b/i,
      /\balmost gone\b/i,
      /\bwhile supplies last\b/i,
      /\bonly\s+(?:a\s+)?few\s+left\b/i,
      /\bfew\s+left\b/i,
      /\bonly\s+\d+\s+left\b/i,
      /\b\d+\s+left in stock\b/i,
      /\b(?:low|limited)\s+stock\b/i,
      /\balmost sold out\b/i,
      /\bselling out\b/i,
      /\bgoing fast\b/i
    ])) {
      strong.push("urgency / scarcity copy present near the CTA");
    }
    if (strong.length || weak.length) return resultFromSignals(strong, weak);
    return notPresent(); // PDP has no urgency trigger → recommend (optional lever)
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

    // Quick VIEW = a modal/drawer that PREVIEWS the product without leaving the
    // listing. This is a DIFFERENT feature from quick-ADD (add-to-cart from the
    // card, handled by detectProductCardQuickAdd). We deliberately do NOT match
    // quick-add tokens here — otherwise an add-to-cart-from-card store (e.g.
    // MyFitness) is falsely reported as having quick view, both crediting it as
    // a strength and wrongly stripping the legitimate "add quick view" rec.
    const strongSelectors = [
      "[data-quick-view]",
      "[data-quickview]",
      "[data-quick-view-button]",
      "[data-quick-view-id]",
      "[data-quick-view-handle]",
      "[data-quick-view-url]",
      "[data-qv-handle]",
      "[data-qv-trigger]",
      "[data-qv-id]",
      "quick-view",
      "[is='quick-view']",
      "[class*='quick-view' i]",
      "[class*='quickview' i]",
      "[class*='qv-trigger' i]",
      "[class*='qv-button' i]",
      "[class*='product-quick-view' i]",
      "modal-opener[data-modal*='quick-view' i]"
    ];
    if (anyMatches($, strongSelectors)) {
      strong.push("element matches quick-VIEW (preview modal) data attribute/class");
    }

    // "quick shop" usually denotes a preview modal but is occasionally used for
    // add-to-cart → weak only, so it cannot flip the verdict by itself.
    if (anyMatches($, [
      "[class*='quick-shop' i]",
      "[class*='quickshop' i]",
      "[data-quick-shop]",
      "[data-quickshop]"
    ])) {
      weak.push("quick-shop class/attribute present (often a preview modal)");
    }

    if (textContainsAny(text, [/\bquick view\b/i, /\bquickview\b/i])) {
      weak.push("page text includes a 'Quick view' label");
    }

    if (htmlContainsAny(html, ["quickView", "quick_view", "QuickView"])) {
      weak.push("HTML/JS source references a quickView identifier");
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

    if (strong.length || weak.length) {
      return resultFromSignals(strong, weak);
    }
    // On product pages, no sticky-ATC markup is a high-confidence absence —
    // required for p.sticky_buy / CONFIRMED MISSING in the standards matrix.
    return notPresent();
  }

  function detectBackToTop($, html, text) {
    const strong = [];
    const weak = [];

    if (anyMatches($, [
      "a[href='#top' i]",
      "a[href='#Top']",
      "a[href*='#top' i]",
      "[class*='back-to-top' i]",
      "[class*='back_to_top' i]",
      "[class*='backtotop' i]",
      "[class*='scroll-to-top' i]",
      "[class*='scroll-top' i]",
      "[class*='scrolltop' i]",
      "[class*='go-to-top' i]",
      "[class*='to-top' i]",
      "[id*='back-to-top' i]",
      "[id*='back_to_top' i]",
      "[id*='scroll-to-top' i]",
      "[aria-label*='back to top' i]",
      "[aria-label*='scroll to top' i]",
      "[data-back-to-top]",
      "[data-scroll-top]"
    ])) {
      strong.push("back-to-top link or control present in DOM");
    }

    if (htmlContainsAny(html, ["back-to-top", "back_to_top", "BackToTop", "scroll-to-top", "scrollToTop", "scroll-top", "goToTop"])) {
      weak.push("page source contains back-to-top class/id pattern");
    }

    $("a, button, [role='button']").each((_, el) => {
      const label = ($(el).text() || $(el).attr("aria-label") || "").replace(/\s+/g, " ").trim();
      if (/\bback to top\b/i.test(label)) {
        strong.push(`back-to-top control: "${label.slice(0, 40)}"`);
      }
    });

    if (textContainsAny(text, [/\bback to top\b/i])) {
      weak.push("page text contains 'back to top'");
    }

    if (strong.length || weak.length) {
      return resultFromSignals(strong, weak);
    }
    // A back-to-top control is almost always injected by JS on scroll and is
    // NOT in the static initial HTML. Returning high-confidence "absent" here
    // would put it in the matrix's `absent` bucket and actively tell the model
    // to recommend adding one — even on themes that already have it. Without a
    // runtime probe we genuinely cannot tell, so return unknown (uncertain),
    // which keeps it out of "confirmed missing" and out of the recommendation.
    return unknown();
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

  function detectBackInStockNotify($, html, text) {
    const strong = [];
    const weak = [];

    if (anyMatches($, [
      "[data-back-in-stock]",
      "[data-bis-trigger]",
      "[data-notify-me]",
      "[data-notify-when-available]",
      "[data-restock-alert]",
      "[data-product-notify]",
      "[data-waitlist]",
      "button[class*='notify' i][class*='stock' i]",
      "button[class*='back-in-stock' i]",
      "button[class*='back_in_stock' i]",
      "[class*='back-in-stock' i] button",
      "[class*='notify-me' i]",
      "[class*='notifyme' i]",
      "[class*='restock-alert' i]",
      "[id*='notify-me' i]",
      "[aria-label*='notify' i][aria-label*='stock' i]",
      "[aria-label*='back in stock' i]"
    ])) {
      strong.push("notify-when-available control / data attribute present");
    }

    if (classOrAttrLooseMatch($, [
      "back-in-stock",
      "back_in_stock",
      "backinstock",
      "notify-me",
      "notifyme",
      "notify-when-available",
      "out-of-stock-notify",
      "restock-alert",
      "restock-notify",
      "bis-form",
      "product-notify",
      "stock-notification",
      "email-when-available",
      "waitlist-form",
      "sold-out-notify"
    ])) {
      weak.push("element class matches back-in-stock / notify-me pattern");
    }

    // Known back-in-stock / notify-me app scripts and widgets
    if (htmlContainsAny(html, [
      "back-in-stock",
      "back_in_stock",
      "BackInStock",
      "backInStock",
      "notify-me",
      "notifyMe",
      "NotifyMe",
      "bis-modal",
      "BISModal",
      "restockrocket",
      "restock-rocket",
      "instocknotify",
      "preorder-globo",
      "swym-back-in-stock",
      "klaviyo.com/back-in-stock",
      "klaviyo-bis",
      "appikon-back-in-stock",
      "amp-back-in-stock",
      "wolf-back-in-stock",
      "stoq-back-in-stock",
      "notify-when-available",
      "restockalert",
      "bis-app",
      "backinstockapp"
    ])) {
      strong.push("known back-in-stock / notify-me app script or markup present");
    }

    $("button, a[class*='button' i], a[class*='btn' i], [role='button']").each((_, el) => {
      const label = ($(el).text() || $(el).attr("aria-label") || "").replace(/\s+/g, " ").trim();
      if (!label) return;
      if (
        /\bnotify me\b/i.test(label) ||
        /\bnotify when (?:available|back in stock|in stock|restocked)\b/i.test(label) ||
        /\bemail when (?:available|back in stock|in stock|restocked)\b/i.test(label) ||
        /\bget notified when\b/i.test(label)
      ) {
        strong.push(`notify-when-available CTA: "${label.slice(0, 60)}"`);
      }
    });

    if (textContainsAny(text, [
      /\bnotify me when\b/i,
      /\bnotify when available\b/i,
      /\bnotify when (?:it's |it is )?back in stock\b/i,
      /\bout[- ]of[- ]stock notification\b/i,
      /\bemail when (?:available|back in stock|in stock|restocked)\b/i,
      /\bget notified when\b/i,
      /\brestock (?:alert|notification)\b/i,
      /\bjoin the waitlist\b/i,
      /\bnotify me\b/i
    ])) {
      weak.push("page text contains notify-when-available / back-in-stock signup language");
    }

    // "Back in stock" alone is ambiguous (stock status copy) — only count when
    // paired with notify / email / alert context on the same page.
    if (
      /\bback in stock\b/i.test(text) &&
      /\b(notify|email|alert|sign up|signup|subscribe|available)\b/i.test(text)
    ) {
      weak.push("page text pairs 'back in stock' with notify / email capture language");
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

    // Shopify 2.0 standard facet form.
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

    // Faceted-filter links (theme-agnostic): hrefs carrying filter.* / ?filter
    // query params are an unambiguous Shopify filtering signal regardless of theme.
    if ($("a[href*='filter.'], a[href*='?filter'], a[href*='&filter'], a[href*='filter.v']").length) {
      strong.push("faceted filter links (filter.* query params) present");
    }

    // Category-refinement list: a sidebar/aside/nav-style block that links out to
    // several category collections (e.g. Hyper's "All Categories" list). Many
    // themes implement "filtering" as category refinement rather than a facet form.
    let categoryRefine = false;
    $("aside, [class*='facet' i], [class*='filter' i], [class*='categor' i], [class*='refine' i], [class*='sidebar' i], [class*='collection-nav' i]").each((_, el) => {
      if (categoryRefine) return;
      const $el = $(el);
      // ignore header/nav/mega-menu chrome
      if ($el.closest("header, nav, [class*='mega-menu' i], [class*='drawer' i], [class*='modal' i]").length) return;
      const collLinks = $el.find("a[href*='/collections/']").length;
      if (collLinks >= 4) categoryRefine = true;
    });
    if (!categoryRefine && /all categories/i.test(text || "")) {
      // "All Categories" heading paired with multiple category links anywhere in main.
      const collLinks = $("main a[href*='/collections/'], [role='main'] a[href*='/collections/']").length;
      if (collLinks >= 4) categoryRefine = true;
    }
    if (categoryRefine) {
      strong.push("category-refinement list (multiple category links) present");
    }

    // A visible filter toggle/button (mobile-style filter panels).
    if ($("button[aria-label*='filter' i], [class*='filter-toggle' i], [class*='filters-toggle' i], button:contains('Filter'), summary:contains('Filter')").length) {
      weak.push("filter toggle / button present");
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

    if (textContainsAny(text, [/\bfilter by\b/i, /\brefine by\b/i, /\bshop by\b/i, /\ball categories\b/i])) {
      weak.push("page text contains 'filter by' / 'refine by' / 'shop by' / 'all categories'");
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
    // Sort links carrying ?sort_by= are an unambiguous Shopify sort signal.
    if ($("a[href*='sort_by='], a[href*='?sort'], a[href*='&sort']").length) {
      strong.push("sort links (sort_by query param) present");
    }
    if (classOrAttrLooseMatch($, ["sort-by", "collection-sort", "sort-menu", "sort-dropdown", "sorting"])) {
      weak.push("element class matches sort dropdown pattern");
    }
    if ($("button[aria-label*='sort' i], [class*='sort-toggle' i], summary:contains('Sort')").length) {
      weak.push("sort toggle / button present");
    }
    if (textContainsAny(text, [/\bsort by\b/i, /\bsorted by\b/i, /\bsort:\b/i])) {
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
    if (textContainsAny(text, [
      /\bsize (guide|chart)\b/i, /\bfit guide\b/i, /\bsizing chart\b/i,
      /\bfind your (size|fit)\b/i, /\bsize finder\b/i, /\btrue to size\b/i,
      /\bmeasurements?\b/i, /\bsizing (info|guide|help)\b/i
    ])) {
      weak.push("page text contains size-guide / fit / measurement language");
    }
    if (strong.length || weak.length) return resultFromSignals(strong, weak);

    // No size-guide signal. Only treat this as a genuine ABSENCE (worth
    // recommending) when the product is clearly apparel/wearable — a size guide
    // is the top apparel lever but irrelevant to, say, a candle or a lamp. For
    // non-apparel products we stay 'unknown' so it isn't recommended.
    const apparel = textContainsAny(text, [
      /\b(shirt|t-?shirt|tee|polo|dress|jean|denim|trouser|pant|chino|short(s)?|skirt|jacket|coat|blazer|sweater|sweatshirt|hoodie|knit|top|blouse|kurta|kurti|saree|lehenga|co-?ord|jumpsuit|legging|activewear|lingerie|bra|underwear|swimwear|footwear|shoe|sneaker|apparel|clothing|garment|outfit|fit)\b/i
    ]);
    return apparel ? notPresent() : unknown();
  }

  function detectPressStrip($, text, html, url) {
    // Home/site-level credibility strip ("As seen on / As featured in", press
    // logo bar, "bestseller on Amazon/Flipkart", "trusted by"). Present if shown.
    const strong = [];
    const weak = [];

    const headings = $("h1,h2,h3,h4,[class*='title' i],[class*='heading' i]")
      .map((_, el) => $(el).text().trim()).get().join(" | ");
    if (/\b(as seen (on|in)|as featured (on|in)|featured in|in the press|press features?|as recommended (by|in))\b/i.test(headings + " " + text)) {
      strong.push("'As seen on / featured in' press section present");
    }
    if (classOrAttrLooseMatch($, [
      "logo-list", "logo-bar", "logos-bar", "press-logos", "as-seen", "as-seen-on",
      "featured-in", "press-bar", "brands-bar", "marquee-logos", "trust-logos"
    ])) {
      weak.push("press / logo-bar element class present");
    }
    if (/\b(bestseller|best[- ]selling)\b[^.]{0,30}\b(amazon|flipkart|myntra)\b/i.test(text)) {
      strong.push("marketplace bestseller credibility shown on page");
    }
    if (strong.length || weak.length) return resultFromSignals(strong, weak);

    // No on-page press/credibility strip. Only flag this as a genuine gap when
    // the store actually HAS credibility to show — a claim in its own copy/meta
    // (bestseller, as-seen, award, "trusted by", large customer/review counts).
    // Otherwise (a brand-new store with no press) it isn't a real omission.
    const metaDesc =
      ($('meta[name="description"]').attr("content") || "") + " " +
      ($('meta[property="og:description"]').attr("content") || "") + " " +
      ($("title").first().text() || "");
    const claimCorpus = `${metaDesc} ${text}`.toLowerCase();
    const hasCredibilityClaim = /\b(bestseller|best[- ]selling|as seen (on|in)|featured (in|on)|award[- ]winning|#1|trusted by|as recommended|\d[\d,]*\+?\s*(happy )?(customers|reviews|orders|sold)|rated \d(\.\d)?\s*\/\s*5)/.test(claimCorpus);
    return hasCredibilityClaim ? notPresent() : unknown();
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

    // (3) Runtime probe — strongest signal possible.
    // A positive result is always trustworthy: a theme whose cards respond to
    // mouseenter/mouseover (JS listeners) clearly has hover behaviour.
    if (runtimeHints.productCardHoverChanges === true || runtimeHints.quickAddRevealedOnHover === true) {
      strong.push("runtime: hovering a product card revealed new content / image change");
    } else if (
      runtimeHints.productCardHoverChanges === false &&
      runtimeHints.productCardHoverTested === true &&
      runtimeHints.productCardHoverRealHover === true
    ) {
      // Only conclude "no hover state" when a REAL browser hover (page.hover,
      // which actually triggers the CSS :hover pseudo-class) produced no change.
      // Most themes implement the secondary-image swap / overlay purely in CSS
      // :hover, which synthetic MouseEvents CANNOT trigger — so a "no change"
      // from a synthetic-event probe is NOT evidence of absence and must fall
      // through to the static heuristics below instead of asserting absence.
      return { present: false, confidence: "high", evidence: ["runtime: real hover produced no visible change"] };
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

    // Theme-agnostic pass: a "card" = a container that holds a product link.
    // If such cards already carry MULTIPLE product images (variant thumbnails or
    // a stacked secondary image) and/or an on-hover action overlay ("View",
    // "Quick view", card action buttons), then alternate-image / hover feedback
    // already exists — recommending "add a secondary hover image" is redundant.
    // This catches themes (e.g. Hyper) whose card markup the selectors above miss.
    let multiImageCards = 0;
    let overlayActionCards = 0;
    const seen = new Set();
    $("a[href*='/products/' i]").each((_, a) => {
      const $card = $(a).closest(
        "li, [class*='card' i], [class*='product' i], [class*='grid__item' i], [class*='column' i], article, .grid-item"
      );
      if (!$card.length) return;
      const node = $card.get(0);
      if (seen.has(node)) return;
      seen.add(node);
      const imgCount = $card.find("img").length;
      if (imgCount >= 2) multiImageCards += 1;
      const overlay = $card.find(
        "[class*='overlay' i], [class*='card__actions' i], [class*='product-card__actions' i], [class*='card-actions' i], [class*='actions' i], [class*='hover' i], [class*='quick' i]"
      );
      const hasViewText = $card
        .find("a, button, span")
        .toArray()
        .some((el) => /\b(view|quick view|quick shop|view details|view product)\b/i.test($(el).text() || ""));
      if (overlay.length || hasViewText) overlayActionCards += 1;
    });
    if (multiImageCards >= 2 && overlayActionCards >= 2) {
      strong.push(`${multiImageCards} cards carry multiple images and ${overlayActionCards} expose a hover/overlay action (alternate-image + reveal pattern)`);
    } else if (multiImageCards >= 2) {
      weak.push(`${multiImageCards} product cards already carry multiple product images (alternate-image pattern)`);
    } else if (overlayActionCards >= 2) {
      weak.push(`${overlayActionCards} product cards expose a hover/overlay action`);
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
      featuredProducts:       detectFeaturedProducts($, html, url),
      brandStory:             detectBrandStory($, text, html),
      subscription:           detectSubscription($, html, text, url),
      productBundle:          detectProductBundle($, html, text, url),
      quantityBreaks:         detectQuantityBreaks($, html, text, url),
      guidedSelling:          detectGuidedSelling($, html, text, url),
      productFaq:             detectProductFaq($, text, html, url),
      freeShipCallout:        detectFreeShipCallout($, text, html, url),
      returnsGuarantee:       detectReturnsGuarantee($, text, html, url),
      urgency:                detectUrgency($, text, html, url),
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
      backToTop:              detectBackToTop($, html, text),
      stockIndicator:         detectStockIndicator($, text, url),
      backInStockNotify:      detectBackInStockNotify($, html, text),
      newsletterSignup:       detectNewsletterSignup($, text),
      breadcrumbs:            detectBreadcrumbs($, html),
      filtering:              detectFiltering($, url, text),
      sort:                   detectSort($, url, text),
      productVideo:           detectProductVideo($, html, url),
      sizeGuide:              detectSizeGuide($, text, url),
      pressStrip:             detectPressStrip($, text, html, url),
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
    /** Only aggregate these features from pages where they are meaningful. */
    const FEATURE_PAGE_TYPES = {
      featuredProducts: ["general"],
      brandStory: ["general"],
      guidedSelling: ["general"],
      subscription: ["product"],
      productBundle: ["product"],
      quantityBreaks: ["product"],
      productFaq: ["product"],
      freeShipCallout: ["product"],
      returnsGuarantee: ["product"],
      urgency: ["product"],
      stickyAddToCart: ["product"],
      stockIndicator: ["product"],
      productMediaZoom: ["product"],
      sizeGuide: ["product"],
      pressStrip: ["general"],
      productVideo: ["product"],
      backInStockNotify: ["product", "collection"],
      filtering: ["collection"],
      sort: ["collection"],
      productCardHover: ["collection"],
      productCardQuickAdd: ["collection"],
      productCardBadges: ["collection"],
      salePriceDisplay: ["collection", "product"],
      variantSwatches: ["product", "collection"]
    };

    const featureKeys = [
      "stickyHeader",
      "announcementBar",
      "announcementBarWithCta",
      "heroSection",
      "trustSignals",
      "featuredProducts",
      "brandStory",
      "subscription",
      "productBundle",
      "quantityBreaks",
      "guidedSelling",
      "productFaq",
      "freeShipCallout",
      "returnsGuarantee",
      "urgency",
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
      "backToTop",
      "stockIndicator",
      "backInStockNotify",
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
      const pageTypes = FEATURE_PAGE_TYPES[key];
      const relevantPages = pageTypes
        ? pages.filter((p) => pageTypes.includes(p.pageType || "general"))
        : pages;

      const samples = relevantPages
        .map((p) => p?.featureDetection?.features?.[key])
        .filter(Boolean);

      if (!samples.length) {
        matrix.uncertain.push({
          key,
          evidence: [],
          reason: pageTypes ? `not tested on ${pageTypes.join("/")} page(s)` : "not tested"
        });
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
    quickView:              "Quick view (modal product preview from cards)",
    productCardQuickAdd:    "Quick-add (add to cart directly from collection cards)",
    featuredProducts:       "Featured / best-sellers / shop-by product section on home",
    brandStory:             "Brand story / mission / founder narrative",
    subscription:           "Subscription / subscribe-and-save (replenishment)",
    productBundle:          "Product bundle / kit / set offer",
    quantityBreaks:         "Quantity breaks / volume discounts (buy more, save more)",
    guidedSelling:          "Guided selling — quiz / product finder",
    productFaq:             "Product-page FAQ / objection-handling block",
    freeShipCallout:        "Free-shipping reassurance near the product CTA",
    returnsGuarantee:       "Returns / money-back-guarantee reassurance on the product page",
    urgency:                "Urgency trigger near the product CTA",
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
    backToTop:              "Back-to-top link (footer / scroll helper)",
    stockIndicator:         "Stock / inventory indicator on product page",
    backInStockNotify:      "Back-in-stock / notify-me-when-available email capture",
    newsletterSignup:       "Newsletter signup form",
    breadcrumbs:            "Breadcrumb navigation",
    filtering:              "Collection filtering / facets",
    sort:                   "Collection sort dropdown",
    productVideo:           "Product video in gallery",
    sizeGuide:              "Size guide / size chart",
    pressStrip:             "Press / credibility strip (as-seen-on / bestseller logos)",
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
    quickView:              ["quick view", "quickview", "quick-view", "add quick view", "implement quick view", "quick view modal", "product preview modal", "preview modal", "quick view feature", "quick-view functionality"],
    productCardQuickAdd:    ["quick add", "quickadd", "quick-add", "add quick add", "implement quick add", "quick-add button", "quick add to cart", "add to cart from collection", "add to cart on cards", "quick add functionality", "quick-add functionality"],
    productCardHover:       ["hover-state animations", "hover state animations", "add hover state", "add hover effects", "hover effects for product cards", "card hover effects", "hover animation on product cards", "secondary image on hover", "secondary product image", "image swap on hover", "on mouse hover", "appears on mouse hover", "hover interaction", "hover interactions", "hover feedback", "visual feedback or additional information on hover", "feedback on hover", "hover-interactive product card", "hover-interactive product cards"],
    productCardBadges:      ["product badges", "badges on cards", "card badges", "best-seller badge", "new arrival badge", "add badges"],
    salePriceDisplay:       ["sale price display", "show discounted prices", "add sale indicators", "strike-through price", "discount indicators", "sale and discount indicators", "clear pricing with sale", "discount labelling"],
    wishlist:               ["wishlist", "add to favorites", "favourite button", "save for later"],
    liveChat:               ["live chat", "chat widget", "implement chat", "add chat"],
    reviews:                ["review system", "customer reviews", "star ratings", "add reviews", "install reviews app", "review widget", "reviews app like"],
    searchBar:              ["search bar", "site search", "implement search"],
    megaMenu:               ["mega menu", "mega-menu", "implement mega menu"],
    variantSwatches:        ["color swatch", "colour swatch", "variant swatches", "show swatches", "color/variant options directly on collection", "colour/variant options directly on collection", "variant options on collection grid", "color options on cards"],
    cartDrawer:             ["cart drawer", "slide-out cart", "mini cart", "ajax cart"],
    stickyAddToCart:        ["sticky add to cart", "floating add to cart", "sticky atc", "sticky buy bar", "floating product bar"],
    backToTop:              ["back to top", "back-to-top link", "scroll to top"],
    stockIndicator:         ["stock indicator", "inventory indicator", "low stock", "stock level"],
    backInStockNotify:      [
      "notify me",
      "back in stock",
      "back-in-stock",
      "out-of-stock notification",
      "notify when available",
      "email when available",
      "restock alert",
      "notify when back in stock"
    ],
    newsletterSignup:       ["newsletter signup", "email capture", "subscribe form"],
    breadcrumbs:            ["breadcrumbs", "breadcrumb navigation"],
    filtering:              ["add filtering", "implement filtering", "implement filters", "add filters"],
    sort:                   ["add sorting", "implement sorting", "sort dropdown", "add sort"],
    productVideo:           ["product video", "video demonstration", "add video"],
    sizeGuide:              ["size guide", "size chart", "fit guide"],
    pressStrip:             ["press strip", "as seen on", "as featured in", "featured in", "credibility strip", "press logos", "press mentions", "logos of press", "trust strip", "as-seen-on"],
    relatedProducts:        ["related products", "cross-sell", "cross sell", "upsell", "you may also like", "recommendation widget", "customers also bought", "complete the look", "complete your kit", "complementary products", "frequently bought together", "recommended products section"],
    recentlyViewed:         ["recently viewed", "recently-viewed", "recently viewed products"],
    mobileMenuToggle:       ["hamburger menu", "mobile menu toggle"],
    freeShippingBar:        ["free shipping bar", "shipping progress"],
    announcementBar:        ["announcement bar", "promo bar"],
    trustSignals:           ["trust badges", "trust strip", "usp strip", "value prop strip", "value proposition strip", "value proposition", "benefits strip", "benefits row", "benefit strip", "icon-based benefits", "icon based benefits", "benefits section", "trust signals", "trust signal section", "payment method security badges", "shipping guarantee icons"],
    featuredProducts:       ["featured collection", "featured products", "best sellers section", "best-sellers section", "best seller section", "best sellers", "best-sellers", "recommended products", "recommended products section", "recommended kits", "product showcase", "shop by category section", "featured product section", "featured product showcase", "showcase top-performing products", "showcase recommended products", "top-performing products"],
    brandStory:             ["brand story", "brand's story", "brand mission", "brand's mission", "brand mission narrative", "mission narrative", "brand narrative", "founder story", "founder's story", "founder background", "meet our team", "meet the team", "meet the founder", "our story section", "introduce the brand", "brand's design philosophy", "mission and values section", "founder/mission section", "founder or mission section"],
    subscription:           ["subscription option", "subscribe and save", "subscribe & save", "subscribe-and-save", "subscription model", "subscription program", "subscription offering", "recurring delivery", "recurring order", "auto-replenish", "auto replenishment", "selling plan", "offer subscriptions", "add a subscription", "subscription or volume"],
    productBundle:          ["product bundle", "bundle offer", "bundle option", "bundle and save", "build your own bundle", "build-a-box", "build your own box", "create a bundle", "kit option", "offer bundles", "bundle products", "starter bundle", "bundle model", "bundling strategy", "bundle deals", "combo offer", "combo deals", "gift set option"],
    quantityBreaks:         ["quantity break", "quantity breaks", "volume discount", "volume discounts", "volume discount model", "volume discount mechanism", "volume discount strategy", "volume discount program", "volume-based pricing", "volume-based purchasing", "tiered pricing", "tiered discount", "bulk discount", "bulk pricing", "buy more save more", "quantity discount", "quantity-based pricing", "quantity-based incentive", "quantity-based discount"],
    guidedSelling:          ["product quiz", "quiz", "product finder", "guided selling", "help me choose", "find your perfect", "recommendation quiz", "which product is right"],
    productFaq:             ["faq section", "faqs", "frequently asked questions", "customer faqs", "product faq", "q&a section", "questions and answers", "objection-handling section"],
    freeShipCallout:        ["free shipping callout", "free-shipping callout", "highlight free shipping", "free shipping near", "surface free shipping", "free shipping messaging near"],
    returnsGuarantee:       ["returns information", "return policy", "money-back guarantee", "money back guarantee", "guarantee near", "returns and refund", "satisfaction guarantee", "highlight the guarantee", "refund policy"],
    urgency:                ["urgency trigger", "urgency triggers", "urgency cue", "countdown timer", "scarcity messaging", "limited-time", "today only", "order within", "create urgency", "add urgency"]
  };

  /**
   * Phrases that indicate the report claims a feature is absent / missing.
   * Used by enforceAbsenceClaims() — the symmetric backstop to the presence
   * evidence guard (enforceEvidenceOnBullets).
   */
  export const ABSENCE_CLAIM_PHRASES = {
    newsletterSignup: [
      /\bno newsletter\b/i,
      /\bnewsletter (?:signup|form|section)? (?:is )?(?:missing|absent|not present)\b/i,
      /\bno email capture\b/i,
      /\blacks (?:a )?(?:newsletter|email signup|email capture|subscribe form)\b/i,
      /\bwithout (?:a )?(?:newsletter|email signup|email capture)\b/i,
      /\bdoes not (?:have|offer|include) (?:a )?(?:newsletter|email signup|email capture)\b/i,
      /\b(?:missing|absent|no) (?:newsletter|email capture|email signup)\b/i
    ],
    trustSignals: [
      /\bno trust (?:signals?|badges?|strip|bar|icons?)\b/i,
      /\btrust (?:signals?|badges?|strip|bar) (?:is |are )?(?:missing|absent|not present)\b/i,
      /\blacks (?:a )?(?:trust|usp|value[- ]prop|benefits) (?:strip|row|bar|signals?|section)\b/i,
      /\bno (?:visible )?(?:usp|value[- ]prop|benefits) (?:strip|row|bar|section)\b/i,
      /\b(?:missing|absent|no) (?:trust signals?|trust badges?|usp strip|value prop)\b/i
    ],
    reviews: [
      /\bno (?:customer )?reviews?\b/i,
      /\bno star ratings?\b/i,
      /\breviews? (?:is |are )?(?:missing|absent|not present)\b/i,
      /\blacks (?:customer )?reviews?\b/i,
      /\b(?:missing|absent|no) (?:review|rating|star rating)\b/i
    ],
    searchBar: [
      /\bno search (?:bar|functionality)\b/i,
      /\bsearch (?:bar|functionality) (?:is )?(?:missing|absent|not present)\b/i,
      /\blacks (?:a )?search\b/i
    ],
    heroSection: [
      /\bno hero (?:section|banner)\b/i,
      /\bhero (?:section|banner) (?:is )?(?:missing|absent|not present)\b/i
    ],
    filtering: [
      /\bno filters?\b/i,
      /\bfilters? (?:is |are )?(?:missing|absent|not present|not available)\b/i,
      /\blacks (?:collection )?filters?\b/i
    ],
    sort: [
      /\bno sort(?:ing)?\b/i,
      /\bsort(?:ing)? (?:is )?(?:missing|absent|not present|not available)\b/i
    ],
    productMediaZoom: [
      /\bno (?:image |product )?zoom\b/i,
      /\b(?:image |product )?zoom (?:is )?(?:missing|absent|not present)\b/i
    ],
    cartDrawer: [
      /\bno cart drawer\b/i,
      /\bcart drawer (?:is )?(?:missing|absent|not present)\b/i
    ],
    stickyHeader: [
      /\bno sticky header\b/i,
      /\bsticky header (?:is )?(?:missing|absent|not present)\b/i
    ],
    backToTop: [
      /\bno back[- ]to[- ]top\b/i,
      /\bback[- ]to[- ]top (?:link )?(?:is )?(?:missing|absent|not present)\b/i,
      /\blacks (?:a )?back[- ]to[- ]top\b/i
    ],
    stickyAddToCart: [
      /\bno sticky (?:add to cart|atc|buy bar)\b/i,
      /\bsticky (?:add to cart|atc|buy bar) (?:is )?(?:missing|absent|not present)\b/i,
      /\blacks (?:a )?(?:sticky add to cart|floating add to cart|sticky buy bar)\b/i
    ],
    megaMenu: [
      /\bno mega menu\b/i,
      /\bmega menu (?:is )?(?:missing|absent|not present)\b/i
    ],
    breadcrumbs: [
      /\bno breadcrumbs?\b/i,
      /\bbreadcrumbs? (?:is |are )?(?:missing|absent|not present)\b/i
    ],
    backInStockNotify: [
      /\bno (?:back[- ]in[- ]stock|notify[- ]me|restock) (?:notify|alert|notification|signup|form|capture)\b/i,
      /\b(?:missing|absent|no) (?:notify me|back[- ]in[- ]stock|out[- ]of[- ]stock notification)\b/i,
      /\blacks (?:a )?(?:notify[- ]me|back[- ]in[- ]stock|restock alert)\b/i,
      /\bdoes not (?:offer|have|include) (?:notify[- ]me|back[- ]in[- ]stock)\b/i
    ]
  };

  /** Section-type absence claims (inventory-based, not featureDetection keys). */
  export const ABSENCE_SECTION_PHRASES = {
    brandStory: [
      /\bno brand (?:story|mission|narrative)\b/i,
      /\blacks (?:a )?(?:brand story|founder story|brand mission|about section)\b/i,
      /\b(?:missing|absent|no) (?:brand story|founder story|brand mission)\b/i
    ],
    newsletter: [
      /\bno newsletter\b/i,
      /\bnewsletter (?:section )?(?:is )?(?:missing|absent)\b/i
    ],
    benefits: [
      /\bno benefits (?:row|section|strip)\b/i,
      /\b(?:missing|absent|no) (?:benefits|value prop|usp) (?:row|section|strip)\b/i
    ]
  };

  /** Placement / visibility critiques — keep these even when the feature exists elsewhere. */
  const PLACEMENT_CRITIQUE =
    /\b(near|next to|beside|above|below|under|at the|by the|close to|adjacent|within|directly (?:above|below|under)|above the fold|below the fold|buy box|add[- ]to[- ]cart|product title|collection cards?|product cards?|hero area|not visible|hard to find|not (?:shown|displayed|visible) (?:near|at|by|on)|(?:far|away) from|missing from the|not (?:near|by|at) the)\b/i;

  function pageFeaturePresent(page, featureKey) {
    const f =
      page?.observed?.features?.[featureKey] ||
      page?.featureDetection?.features?.[featureKey];
    if (!f || f.present !== true) return false;
    return f.confidence === "high" || f.confidence === "medium";
  }

  function pageHasSectionType(page, sectionType) {
    const sections = page?.observed?.sections || [];
    return sections.some((s) => s.type === sectionType);
  }

  function matchedAbsenceFeatures(line) {
    const hits = [];
    for (const [key, patterns] of Object.entries(ABSENCE_CLAIM_PHRASES)) {
      if (patterns.some((re) => re.test(line))) hits.push(key);
    }
    return hits;
  }

  function matchedAbsenceSections(line) {
    const hits = [];
    for (const [key, patterns] of Object.entries(ABSENCE_SECTION_PHRASES)) {
      if (patterns.some((re) => re.test(line))) hits.push(key);
    }
    return hits;
  }

  function absenceTargetsForLine(featureHits, sectionHits) {
    const targets = new Set(featureHits);
    for (const s of sectionHits) {
      if (s === "newsletter") targets.add("newsletterSignup");
      else if (s === "benefits") targets.add("trustSignals");
      else targets.add(s);
    }
    return [...targets];
  }

  function targetPresentOnPages(target, contextPages) {
    switch (target) {
      case "newsletterSignup":
        return contextPages.some(
          (p) => pageFeaturePresent(p, "newsletterSignup") || pageHasSectionType(p, "newsletter")
        );
      case "trustSignals":
        return contextPages.some(
          (p) => pageFeaturePresent(p, "trustSignals") || pageHasSectionType(p, "benefits")
        );
      case "brandStory":
        return contextPages.some((p) => pageHasSectionType(p, "brandStory"));
      default:
        return contextPages.some((p) => pageFeaturePresent(p, target));
    }
  }

  /**
   * Drop or flag false "missing / no X" claims when per-page detection shows X
   * is present. Uses page-type context (home / collection / product) — NOT the
   * store-wide feature matrix — so a true "no reviews on collection cards"
   * finding on collection pages is preserved even when product pages have reviews.
   *
   * @param {string} markdown
   * @param {object[]} pages  crawled pages with featureDetection / observed.features
   * @returns {string}
   */
  export function enforceAbsenceClaims(markdown, pages = []) {
    if (!markdown || !pages.length) return markdown;

    const repByType = {};
    for (const p of pages) {
      const t = p.pageType || "general";
      if (!repByType[t]) repByType[t] = p;
    }

    const sectionPageTypes = [
      { re: /^#{1,2}\s+Home Page\b/i, pageTypes: ["general"] },
      { re: /^#{1,2}\s+Collection Page\b/i, pageTypes: ["collection"] },
      { re: /^#{1,2}\s+Product Page\b/i, pageTypes: ["product"] }
    ];

    const lines = markdown.split(/\r?\n/);
    let inZone = false;
    let activePageTypes = ["general", "collection", "product"];
    let dropped = 0;
    let flagged = 0;
    const kept = [];

    const isHeading = (line) => /^#{1,3}\s+/.test(line) || /^\s*\d+\.\s+\S/.test(line);
    const isRecoLabel = (line) => /^\s*[-*]?\s*recommendations:\s*$/i.test(line);

    for (const line of lines) {
      if (/^#{1,2}\s+/.test(line)) {
        inZone = /key areas of improvement/i.test(line);
        const sectionMatch = sectionPageTypes.find((s) => s.re.test(line));
        if (sectionMatch) activePageTypes = sectionMatch.pageTypes;
        kept.push(line);
        continue;
      }

      if (!inZone || isHeading(line) || isRecoLabel(line) || !line.trim()) {
        kept.push(line);
        continue;
      }

      const contextPages = activePageTypes.map((t) => repByType[t]).filter(Boolean);
      if (!contextPages.length) {
        kept.push(line);
        continue;
      }

      const featureHits = matchedAbsenceFeatures(line);
      const sectionHits = matchedAbsenceSections(line);
      if (!featureHits.length && !sectionHits.length) {
        kept.push(line);
        continue;
      }

      const placementCritique = PLACEMENT_CRITIQUE.test(line);
      const targets = absenceTargetsForLine(featureHits, sectionHits);

      // "No reviews or trust signals" — evaluate each side of "or" separately.
      const orParts = line.split(/\bor\b/i);
      let presentTargets = [];
      let absentTargets = [];
      const inheritsAbsence = orParts.length > 1 && /\b(?:no|missing|absent|lacks?)\b/i.test(orParts[0]);
      if (orParts.length > 1) {
        for (let i = 0; i < orParts.length; i += 1) {
          let part = orParts[i];
          if (i > 0 && inheritsAbsence && !/\b(?:no|missing|absent|lacks?)\b/i.test(part)) {
            part = `no ${part.trim()}`;
          }
          const partFeatures = matchedAbsenceFeatures(part);
          const partSections = matchedAbsenceSections(part);
          const partTargets = absenceTargetsForLine(partFeatures, partSections);
          for (const t of partTargets) {
            if (targetPresentOnPages(t, contextPages)) presentTargets.push(t);
            else absentTargets.push(t);
          }
        }
        presentTargets = [...new Set(presentTargets)];
        absentTargets = [...new Set(absentTargets)];
      } else {
        presentTargets = targets.filter((t) => targetPresentOnPages(t, contextPages));
        absentTargets = targets.filter((t) => !targetPresentOnPages(t, contextPages));
      }

      const compound =
        (targets.length > 1 || orParts.length > 1) &&
        presentTargets.length > 0 &&
        absentTargets.length > 0;

      if (compound) {
        flagged += 1;
        console.log(
          `enforceAbsenceClaims: flagged compound absence claim for rewording — ${line.trim().slice(0, 100)}`
        );
        const flaggedLine = /^\s*[-*]\s+/.test(line)
          ? line.replace(/^(\s*[-*]\s+)/, "$1⚠ **Reword:** ")
          : `⚠ **Reword:** ${line.trim()}`;
        kept.push(flaggedLine);
        continue;
      }

      if (presentTargets.length && !placementCritique) {
        dropped += 1;
        continue;
      }

      kept.push(line);
    }

    if (dropped > 0) {
      console.log(`enforceAbsenceClaims: dropped ${dropped} false absence claim(s)`);
    }
    if (flagged > 0) {
      console.log(`enforceAbsenceClaims: flagged ${flagged} compound absence claim(s) for rewording`);
    }

    return kept.join("\n").replace(/\n{3,}/g, "\n\n");
  }