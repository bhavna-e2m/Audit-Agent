import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit } from "./auditService.js";
import { createGoogleDocFromMarkdown } from "./googleDocs.js";
import { detectThemeInfo, formatThemeForApi } from "./featureDetection.js";
import { getCoreStorefrontPageBudget, DEFAULT_PAGES_PER_TYPE } from "./crawler.js";
import { isShopifyPreviewUrl, normalizeStoreUrl, normalizeUrl } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const app = express();
const basePort = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(rootDir, "public")));
app.use("/reports", express.static(path.join(rootDir, "reports")));
app.use("/previews", express.static(path.join(rootDir, "previews")));

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function resolveAuditParams(body = {}) {
  const {
    url,
    maxPages,
    appBaseUrl,
    createMarkdown,
    createGoogleDoc,
    fastMode,
    includeScreenshots,
    includeReferenceBenchmarks,
    referenceScreenshots,
    referenceSiteUrls,
    additionalPageUrls
  } = body;

  const normalized = normalizeStoreUrl(url || "");
  const isVercel = Boolean(process.env.VERCEL);
  const fastModeRequested = fastMode === true || String(fastMode).toLowerCase() === "true";
  // Keep deployed behavior aligned with local defaults.
  const defaultMaxPages = fastModeRequested ? 2 : 6;

  const rootHostname = normalized ? new URL(normalized).hostname.replace(/^www\./, "") : "";
  const normalizedAdditionalPages = Array.isArray(additionalPageUrls)
    ? additionalPageUrls
        .map((u) => normalizeUrl(String(u || "").trim()))
        .filter(Boolean)
        .filter((u) => new URL(u).hostname.replace(/^www\./, "") === rootHostname)
        .filter((u, idx, arr) => arr.indexOf(u) === idx)
    : [];

  const requestedMaxPages = Number(maxPages || defaultMaxPages);
  const pagesPerType = DEFAULT_PAGES_PER_TYPE;
  const coreStorefrontPages = getCoreStorefrontPageBudget(pagesPerType);
  const minimumPagesForRequestedExtras =
    coreStorefrontPages + normalizedAdditionalPages.length;
  const resolvedMaxPages = Math.max(requestedMaxPages, minimumPagesForRequestedExtras);

  return {
    normalized,
    isVercel,
    fastModeRequested,
    resolvedMaxPages,
    normalizedAdditionalPages,
    appBaseUrl: typeof appBaseUrl === "string" ? appBaseUrl : "",
    createMarkdown: createMarkdown !== false,
    createGoogleDoc: Boolean(createGoogleDoc),
    includeScreenshots: includeScreenshots === true,
    includeReferenceBenchmarks: includeReferenceBenchmarks === true,
    referenceScreenshots: Array.isArray(referenceScreenshots) ? referenceScreenshots : [],
    referenceSiteUrls: Array.isArray(referenceSiteUrls) ? referenceSiteUrls : []
  };
}

async function executeAuditRun(params) {
  const {
    normalized,
    isVercel,
    fastModeRequested,
    resolvedMaxPages,
    normalizedAdditionalPages,
    appBaseUrl,
    createMarkdown,
    includeScreenshots,
    includeReferenceBenchmarks,
    referenceScreenshots,
    referenceSiteUrls,
    onProgress
  } = params;

  return runAudit({
    url: normalized,
    maxPages: resolvedMaxPages,
    appBaseUrl,
    createMarkdown,
    additionalPageUrls: normalizedAdditionalPages,
    persistReports: !isVercel,
    docx: false,
    fastMode: fastModeRequested,
    includeScreenshots,
    includeReferenceBenchmarks,
    referenceScreenshots,
    referenceSiteUrls,
    onProgress
  });
}

function buildAuditApiPayload(normalized, result, params) {
  const { isVercel, fastModeRequested, createMarkdown } = params;
  const relativeMdPath =
    result.outputPath && !isVercel ? `/${result.outputPath.replace(/\\/g, "/")}` : "";

  return {
    success: true,
    url: normalized,
    pagesAnalyzed: result.pagesAnalyzed,
    theme: result.theme || null,
    themeName: result.theme?.displayName || "",
    crawledPages: result.crawledPages || [],
    markdownPath: relativeMdPath,
    markdownContent: isVercel && createMarkdown !== false ? result.markdown : "",
    screenshots: result.screenshots || [],
    referenceBenchmarks: result.referenceBenchmarks || [],
    referenceSitePoolUsed: result.referenceSitePoolUsed || [],
    qualityChecks: result.qualityChecks || null,
    modeUsed: fastModeRequested ? "Fast" : "Full"
  };
}

app.post("/api/preview", async (req, res) => {
  try {
    const { url } = req.body || {};
    const normalized = normalizeStoreUrl(url || "");
    if (!normalized) {
      return res.status(400).json({ error: "Invalid or missing URL." }); 
    }

    const response = await fetch(normalized, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" 
      }
    });
    const html = await response.text();

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || new URL(normalized).hostname;
    const isShopify = /shopify|cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme/i.test(html);
    const theme = formatThemeForApi(detectThemeInfo(html, normalized));
    const ogImageMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    const isThemePreview = isShopifyPreviewUrl(normalized);

    return res.json({
      success: true,
      url: normalized,
      title,
      isShopify,
      isThemePreview,
      theme,
      themeName: theme.displayName,
      previewImage: ogImageMatch?.[1] || ""
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Preview failed." });
  }
});

async function attachGoogleDoc(normalized, result, createGoogleDoc) {
  let googleDocUrl = "";
  let googleDocNote = "";
  if (!createGoogleDoc) {
    return { googleDocUrl, googleDocNote };
  }

  try {
    const host = new URL(normalized).hostname.replace(/^www\./, "");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const docResult = await createGoogleDocFromMarkdown({
      title: `Shopify Audit - ${host} - ${stamp}`,
      markdown: result.markdown
    });
    if (docResult.enabled) {
      googleDocUrl = docResult.url;
    } else {
      googleDocNote = docResult.reason;
    }
  } catch (docError) {
    googleDocNote = docError?.message || "Google Doc creation failed.";
  }

  return { googleDocUrl, googleDocNote };
}

async function handleAuditRequest(req, res) {
  try {
    const params = resolveAuditParams(req.body || {});
    if (!params.normalized) {
      return res.status(400).json({ error: "Invalid or missing URL." });
    }

    if (!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Missing API key. Set OPENROUTER_API_KEY (recommended) or OPENAI_API_KEY."
      });
    }

    const result = await executeAuditRun(params);
    const { googleDocUrl, googleDocNote } = await attachGoogleDoc(
      params.normalized,
      result,
      params.createGoogleDoc
    );

    return res.json({
      ...buildAuditApiPayload(params.normalized, result, params),
      googleDocUrl,
      googleDocNote
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Audit generation failed." });
  }
}

async function handleAuditStreamRequest(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    const params = resolveAuditParams(req.body || {});
    if (!params.normalized) {
      sendSse(res, "error", { error: "Invalid or missing URL." });
      return res.end();
    }

    if (!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
      sendSse(res, "error", {
        error: "Missing API key. Set OPENROUTER_API_KEY (recommended) or OPENAI_API_KEY."
      });
      return res.end();
    }

    sendSse(res, "phase", {
      phase: "start",
      message: "Starting full Shopify audit...",
      modeUsed: params.fastModeRequested ? "Fast" : "Full"
    });

    const result = await executeAuditRun({
      ...params,
      onProgress: (payload) => sendSse(res, payload.type, payload)
    });

    const { googleDocUrl, googleDocNote } = await attachGoogleDoc(
      params.normalized,
      result,
      params.createGoogleDoc
    );

    sendSse(res, "complete", {
      ...buildAuditApiPayload(params.normalized, result, params),
      googleDocUrl,
      googleDocNote
    });
    res.end();
  } catch (error) {
    sendSse(res, "error", { error: error.message || "Audit generation failed." });
    res.end();
  }
}

app.post("/api/audit/stream", handleAuditStreamRequest);
app.post("/api/audit", handleAuditRequest);
// Backward-compatibility: older/cached frontend may call POST /api
app.post("/api", handleAuditStreamRequest);  

// Some browsers/proxies always request favicon.ico; return empty response
// to avoid unnecessary serverless invocation failures/noise on Vercel.
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("*", (req, res) => {
  res.sendFile(path.join(rootDir, "public", "index.html"));
});

function startServer(port, retriesLeft = 10) {
  const server = app.listen(port, () => {
    console.log(`Shopify Audit frontend running: http://localhost:${port}`);   
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && retriesLeft > 0) {
      const nextPort = port + 1;
      console.warn(`Port ${port} in use, retrying on ${nextPort}...`);
      startServer(nextPort, retriesLeft - 1);
      return;
    }

    console.error("Failed to start server:", error.message);
    process.exit(1);
  });
}

if (!process.env.VERCEL) {
  startServer(basePort);
}

export default app;
      