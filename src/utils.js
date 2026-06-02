import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function parseArgs(argv) {
  const args = {
    url: "",
    out: "",
    maxPages: 3,
    docx: false,
    fastMode: false,
    includeScreenshots: false,
    includeReferenceBenchmarks: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--url") args.url = argv[i + 1] || "";
    if (token === "--out") args.out = argv[i + 1] || "";
    if (token === "--max-pages") args.maxPages = Number(argv[i + 1] || "8");
    if (token === "--docx") args.docx = true;
    if (token === "--no-docx") args.docx = false;
    if (token === "--fast") args.fastMode = true;
    if (token === "--no-fast") args.fastMode = false;
    if (token === "--screenshots") args.includeScreenshots = true;
    if (token === "--no-screenshots") args.includeScreenshots = false;
    if (token === "--reference-benchmarks") args.includeReferenceBenchmarks = true;
    if (token === "--no-reference-benchmarks") args.includeReferenceBenchmarks = false;
  }
  return args;
}

export function normalizeUrl(input) {
  try { 
    const u = new URL(input);
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

/** Params required for Shopify theme preview / password storefronts. */
const STORE_URL_KEEP_PARAMS = new Set([
  "preview_theme_id",
  "shop",
  "key",
  "pb",
  "password"
]);

/**
 * Normalize merchant URLs for crawl/audit: drop theme-editor noise (_ab, _bt, …)
 * but keep preview_theme_id so the correct theme loads.
 */
export function normalizeStoreUrl(input) {
  try {
    const u = new URL(String(input || "").trim());
    u.hash = "";

    const keys = [...u.searchParams.keys()];
    for (const key of keys) {
      if (STORE_URL_KEEP_PARAMS.has(key)) continue;
      if (key.startsWith("_") || key === "v" || key === "oseid") {
        u.searchParams.delete(key);
      }
    }

    return u.toString();
  } catch {
    return normalizeUrl(input);
  }
}

export function getPreviewThemeId(input) {
  try {
    return new URL(input).searchParams.get("preview_theme_id") || "";
  } catch {
    return "";
  }
}

export function isShopifyPreviewUrl(input) {
  return Boolean(getPreviewThemeId(input));
}

/** Stable key for comparing same page URLs (trailing slash, hash). */
export function canonicalUrlKey(input) {
  try {
    const u = new URL(input);
    u.hash = "";
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * Crawl dedupe key — product URLs ignore ?variant= (same PDP, one audit).
 * Collection/home URLs keep query params (filters/sort).
 */
export function crawlCanonicalUrlKey(input) {
  try {
    const u = new URL(input);
    u.hash = "";
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    if (/\/products\/[^/]+/i.test(u.pathname)) {
      u.search = "";
    }
    return u.toString();
  } catch {
    return "";
  }
}

export function isProductUrl(input) {
  try {
    return /\/products\/[^/]+/i.test(new URL(input).pathname);
  } catch {
    return false;
  }
}

export function urlsEquivalent(a, b) {
  const ka = canonicalUrlKey(a);
  const kb = canonicalUrlKey(b);
  return Boolean(ka && kb && ka === kb);
}

export function slugFromUrl(url) {
  const u = new URL(url);
  return u.hostname.replace(/^www\./, "").replace(/\./g, "-");
}

export async function saveReport(filePath, markdown) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, markdown, "utf8");
}

export async function saveBinary(filePath, content) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10); 
}
