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

function extractSignals(url, html, runtimeHints = {}) {
  const $ = cheerio.load(html);
  const text = cleanText($("body").text()).slice(0, 6000);
  const aboveFoldModule = detectAboveFoldModule($);

  // Run the comprehensive theme-agnostic feature detection.
  const featureDetection = detectFeatures($, html, url, runtimeHints, text);
  const themeInfo = detectThemeInfo(html, url);
  const themeName = detectThemeName(html);

  const headerText = cleanText($("header").first().text()).slice(0, 800);
  const footerText = cleanText($("footer").first().text()).slice(0, 1200);
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

  return {
    pageType: classifyPage(url),
    title: metaTitle,
    url,
    challengePage,
    heroText,
    headerText,
    footerText,
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
      hasStockIndicator:        isPresent("stockIndicator"),
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
    return await page.evaluate(async () => {
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
  } catch {
    return {
      stickyHeaderTested: false,
      stickyHeader: false,
      hasFloatingChatButton: false,
      productCardHoverTested: false,
      productCardHoverChanges: false,
      quickAddRevealedOnHover: false
    };
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
  const shopifyDetected = detectShopifyFromHtml(html);
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
      await page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
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
  return /shopify|cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme/i.test(html);
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
  let shopifyDetected = false;

  console.log(
    `Starting fetch-based crawl for: ${startUrl} (target: ${targets.each} collections + ${targets.each} products)`
  );

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

  return { shopifyDetected, pages };
}

export async function crawlStore(startUrl, maxPages = 8, options = {}) {
  const additionalPageUrls = Array.isArray(options.additionalPageUrls)
    ? options.additionalPageUrls.filter(Boolean)
    : [];
  const crawlOptions = {
    onPageCrawled: options.onPageCrawled,
    pagesPerType: options.pagesPerType
  };
  const targets = resolveCrawlTargets(crawlOptions);

  console.log(`Starting crawl for: ${startUrl}`);
  console.log(`Additional URLs: ${additionalPageUrls.length}`);
  console.log(`Balanced crawl target: ${targets.each} collection(s) + ${targets.each} product(s)`);

  if (process.env.AUDIT_USE_FETCH_ONLY === "1") {
    const queue = [startUrl, ...additionalPageUrls];
    const uniqueQueue = Array.from(new Set(queue));
    return crawlStoreWithFetch(uniqueQueue[0], maxPages, uniqueQueue, additionalPageUrls, crawlOptions);
  }

  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
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
    let shopifyDetected = false;
    const screenshotDir = process.env.AUDIT_SCREENSHOT_DIR || "";
    const sectionScreenshotDir =
      process.env.AUDIT_SECTION_SCREENSHOT_DIR || process.env.AUDIT_SCREENSHOT_DIR || "";

    console.log(`Queue length: ${queue.length}, maxPages: ${maxPages}`);

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

        await page.goto(next, { waitUntil: "domcontentloaded", timeout: 15000 });
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
    return { shopifyDetected, pages };
  } catch (error) {
    console.log(`Browser crawl failed, falling back to fetch: ${error.message}`);
    const queue = [startUrl, ...additionalPageUrls];
    const uniqueQueue = Array.from(new Set(queue));
    return crawlStoreWithFetch(uniqueQueue[0], maxPages, uniqueQueue, additionalPageUrls, crawlOptions);
  }
}
