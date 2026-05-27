import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

function looksLikeShopify(html) {
  return /shopify|cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme/i.test(html);
}

function safeName(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function waitForVisualReady(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 7000 });
  } catch {
    // Some sites keep long-polling connections; continue with fallback waits.
  }

  try {
    await page.waitForFunction(
      () => {
        const imgs = Array.from(document.images || []);
        const imagesReady = imgs.every((img) => img.complete);
        const fontsReady = document.fonts ? document.fonts.status === "loaded" : true;
        return imagesReady && fontsReady;
      },
      { timeout: 5000 }
    );
  } catch {
    // If assets are slow, still proceed after a short grace wait.
  }

  await page.waitForTimeout(500);
}

export async function collectReferenceScreenshots({ urls = [], outputDir, limit = 2 }) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 6) : 2;
  const valid = [...new Set((urls || []).map((u) => String(u).trim()).filter(Boolean))].slice(
    0,
    max
  );
  if (!valid.length) return [];

  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = [];
  for (let i = 0; i < valid.length; i += 1) {
    const url = valid[i];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
      await waitForVisualReady(page);
      const html = await page.content();
      if (!looksLikeShopify(html)) continue;

      const title = await page.title();
      const fileName = `${String(i + 1).padStart(2, "0")}-${safeName(new URL(url).hostname)}.png`;
      const fullPath = path.join(outputDir, fileName);
      await page.screenshot({ path: fullPath, fullPage: true });

      results.push({
        url,
        title: title || new URL(url).hostname,
        screenshotPath: fullPath
      });
    } catch {
      // Skip invalid reference URLs
    }
  }

  await browser.close();
  return results;
}
