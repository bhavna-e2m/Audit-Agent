const form = document.getElementById("audit-form");
const statusBox = document.getElementById("status");
const liveCrawlBox = document.getElementById("liveCrawl");
const resultBox = document.getElementById("result");
const submitBtn = document.getElementById("submitBtn");
const previewBtn = document.getElementById("previewBtn");
const previewBox = document.getElementById("preview");

const liveCrawlState = {
  pages: new Map(),
  theme: null
};

function setStatus(message, type = "success", progress = null, eta = "") {
  statusBox.className = `status ${type}`;
  statusBox.innerHTML = `
    <div class="status-title">${escapeHtml(message)}</div>
    ${
      progress !== null
        ? `<div class="progress"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>`
        : ""
    }
    ${eta ? `<div class="tiny">${escapeHtml(eta)}</div>` : ""}
  `;
}

function clearResult() {
  resultBox.className = "result hidden";
  resultBox.innerHTML = "";
}

function resetLiveCrawl() {
  liveCrawlState.pages = new Map();
  liveCrawlState.theme = null;
  liveCrawlBox.className = "live-crawl hidden";
  liveCrawlBox.innerHTML = "";
}

function pageTypeLabel(pageType) {
  const labels = {
    general: "Home",
    collection: "Collection",
    product: "Product",
    contact: "Contact",
    faq: "FAQ",
    warranty: "Warranty"
  };
  return labels[pageType] || pageType || "Page";
}

function renderLiveCrawlPanel() {
  const pageEntries = Array.from(liveCrawlState.pages.values()).sort(
    (a, b) => a.order - b.order
  );
  const crawling = pageEntries.find((p) => p.status === "crawling");

  const listHtml = pageEntries.length
    ? `<ul class="crawl-list live-crawl-list">${pageEntries
        .map((page) => {
          const statusClass =
            page.status === "crawling"
              ? "is-crawling"
              : page.status === "blocked"
                ? "is-blocked"
                : "is-done";
          const badge = page.requestedAsAdditional
            ? ' <span class="page-badge">Additional</span>'
            : "";
          const title = page.title ? ` <span class="page-title">— ${escapeHtml(page.title)}</span>` : "";
          const statusText =
            page.status === "crawling"
              ? '<span class="crawl-status">Scanning…</span>'
              : page.status === "blocked"
                ? '<span class="crawl-status blocked">Blocked</span>'
                : "";
          return `<li class="live-crawl-item ${statusClass}" data-order="${page.order}">
            <span class="page-type">${escapeHtml(pageTypeLabel(page.pageType))}</span>${badge}
            ${statusText}
            <a href="${escapeHtml(page.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.url)}</a>${title}
          </li>`;
        })
        .join("")}</ul>`
    : `<p class="live-crawl-empty">Waiting for first page…</p>`;

  liveCrawlBox.className = "live-crawl";
  liveCrawlBox.innerHTML = `
    <h3>Live crawl</h3>
    ${
      crawling
        ? `<p class="live-crawl-current">Now scanning <strong>${escapeHtml(pageTypeLabel(crawling.pageType))}</strong> page…</p>`
        : `<p class="live-crawl-current">Crawl in progress…</p>`
    }
    ${liveCrawlState.theme ? formatThemeHtml(liveCrawlState.theme) : ""}
    ${listHtml}
  `;

  const active = liveCrawlBox.querySelector(".live-crawl-item.is-crawling");
  if (active) {
    active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function upsertLiveCrawlPage(event) {
  const key = event.pageKey || event.url || `order-${event.order}`;
  const existing = liveCrawlState.pages.get(key) || {};
  liveCrawlState.pages.set(key, {
    ...existing,
    order: event.order ?? existing.order,
    url: event.url ?? existing.url,
    title: event.title ?? existing.title,
    pageType: event.pageType ?? existing.pageType,
    requestedAsAdditional:
      event.requestedAsAdditional ?? existing.requestedAsAdditional ?? false,
    status: event.status ?? existing.status
  });
  renderLiveCrawlPanel();
}

function handleAuditStreamEvent(event) {
  const { type, data } = event;

  if (type === "phase") {
    if (data.phase === "crawl_done" && data.pagesFound != null) {
      setStatus(
        data.message || `Crawled ${data.pagesFound} page(s).`,
        "success",
        null
      );
    } else {
      setStatus(data.message || "Working...", "success", null);
    }
    return;
  }

  if (type === "page") {
    upsertLiveCrawlPage(data);
    const label = pageTypeLabel(data.pageType);
    if (data.status === "crawling") {
      setStatus(`Scanning ${label} page…`, "success", null);
    } else if (data.status === "blocked") {
      setStatus(`Blocked by bot protection: ${label}`, "error", null);
    } else {
      setStatus(`Finished ${label} page (${data.order})`, "success", null);
    }
    return;
  }

  if (type === "theme" && data.theme) {
    liveCrawlState.theme = data.theme;
    renderLiveCrawlPanel();
  }
}

function parseSseChunk(chunk) {
  const events = [];
  for (const part of chunk.split("\n\n")) {
    if (!part.trim()) continue;
    let eventType = "message";
    let dataRaw = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("data:")) dataRaw += line.slice(5).trim();
    }
    if (!dataRaw) continue;
    try {
      events.push({ type: eventType, data: JSON.parse(dataRaw) });
    } catch {
      // ignore malformed chunks
    }
  }
  return events;
}

async function runAuditStream(requestBody) {
  const response = await fetch("/api/audit/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const err = await response.json();
      throw new Error(err.error || "Audit generation failed.");
    }
    throw new Error(`Audit failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completeData = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      for (const event of parseSseChunk(chunk)) {
        if (event.type === "error") {
          throw new Error(event.data.error || "Audit generation failed.");
        }
        if (event.type === "complete") {
          completeData = event.data;
          continue;
        }
        handleAuditStreamEvent(event);
      }
    }
  }

  if (buffer.trim()) {
    for (const event of parseSseChunk(buffer)) {
      if (event.type === "error") throw new Error(event.data.error || "Audit generation failed.");
      if (event.type === "complete") completeData = event.data;
      else handleAuditStreamEvent(event);
    }
  }

  if (!completeData) {
    throw new Error("Audit stream ended without a result.");
  }

  return completeData;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatThemeHtml(theme) {
  const resolved =
    theme && typeof theme === "object"
      ? theme
      : { displayName: theme || "Not clearly detected", schemaName: "", instanceName: "" };

  if (!resolved.displayName || resolved.displayName === "Not clearly detected") {
    return `<div><strong>Theme:</strong> Not clearly detected</div>`;
  }

  const schemaLabel = resolved.schemaName || resolved.displayName;
  let html = `<div><strong>Theme (schema):</strong> ${escapeHtml(schemaLabel)}</div>`;

  if (resolved.instanceName && resolved.instanceName !== schemaLabel) {
    html += `<div class="theme-meta"><strong>Theme label:</strong> ${escapeHtml(resolved.instanceName)}</div>`;
  }
  if (resolved.schemaVersion) {
    html += `<div class="theme-meta"><strong>Schema version:</strong> ${escapeHtml(resolved.schemaVersion)}</div>`;
  }
  if (resolved.previewThemeId && resolved.source === "preview_theme_id") {
    html += `<div class="theme-meta"><strong>Preview theme ID:</strong> ${escapeHtml(resolved.previewThemeId)} (from theme editor link)</div>`;
  } else if (resolved.previewThemeId && !resolved.schemaName) {
    html += `<div class="theme-meta"><strong>Theme ID:</strong> ${escapeHtml(resolved.previewThemeId)}</div>`;
  }

  return html;
}

function formatCrawledPagesHtml(crawledPages) {
  if (!Array.isArray(crawledPages) || !crawledPages.length) return "";

  const items = crawledPages
    .map((page) => {
      const badge = page.requestedAsAdditional
        ? ' <span class="page-badge">Additional</span>'
        : "";
      const type = escapeHtml(page.pageType || "page");
      const title = page.title ? ` <span class="page-title">— ${escapeHtml(page.title)}</span>` : "";
      return `<li>
        <span class="page-type">${type}</span>${badge}
        <a href="${escapeHtml(page.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.url)}</a>${title}
      </li>`;
    })
    .join("");

  return `
    <div class="crawl-section">
      <strong>Pages crawled (${crawledPages.length}):</strong>
      <ul class="crawl-list">${items}</ul>
    </div>
  `;
}

async function parseApiResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const raw = await response.text();
  const snippet = raw.slice(0, 120).replace(/\s+/g, " ");
  throw new Error(
    `Server returned non-JSON response (${response.status}). Please open the latest app URL and retry. Response starts with: ${snippet}` 
  );
}

async function loadPreview() {
  const url = document.getElementById("url").value.trim();
  if (!url) {
    setStatus("Please enter a URL first.", "error");
    return;
  }

  previewBtn.disabled = true;
  previewBox.className = "preview";
  previewBox.innerHTML = "Loading site preview and theme details...";

  try {
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await parseApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Preview failed.");

    if (data.url) {
      document.getElementById("url").value = data.url;
    }

    previewBox.className = "preview";
    previewBox.innerHTML = `
      ${
        data.previewImage
          ? `<img src="${escapeHtml(data.previewImage)}" alt="Store preview image" />`
          : `<div style="margin-bottom:8px;color:#475569;">No preview image found on page metadata.</div>`
      }
      <div><strong>Store:</strong> ${escapeHtml(data.title)}</div>
      <div><strong>Audit URL:</strong> ${escapeHtml(data.url)}</div>
      ${
        data.isThemePreview
          ? `<div class="theme-meta"><strong>Mode:</strong> Shopify theme preview (editor link). Tracking params were removed; <code>preview_theme_id</code> kept.</div>`
          : ""
      }
      <div><strong>Platform:</strong> ${data.isShopify ? "Shopify detected" : "Not clearly Shopify"}</div>
      ${formatThemeHtml(data.theme || { displayName: data.themeName })}
      ${
        data.isThemePreview && data.theme?.displayName === "Not clearly detected"
          ? `<div class="theme-meta">Open the storefront without the password, or publish the theme, if schema name still does not appear.</div>`
          : ""
      }
    `;
  } catch (error) {
    previewBox.className = "preview";
    previewBox.innerHTML = `<span style="color:#991b1b;">${escapeHtml(error.message)}</span>`;
  } finally {
    previewBtn.disabled = false;
  }
}

previewBtn.addEventListener("click", loadPreview);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearResult();
  resetLiveCrawl();
  submitBtn.disabled = true;
  statusBox.className = "status success";
  setStatus("Starting full Shopify audit…", "success", null, "Typically 1–3 minutes");

  const url = document.getElementById("url").value.trim();
  const createMarkdown = document.getElementById("createMarkdown").checked;
  const createGoogleDoc = document.getElementById("createGoogleDoc").checked;
  const referenceSiteUrls = document
    .getElementById("referenceSiteUrls")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const additionalPageUrls = document
    .getElementById("additionalPageUrls")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const data = await runAuditStream({
      url,
      appBaseUrl: window.location.origin,
      createMarkdown,
      createGoogleDoc,
      referenceSiteUrls,
      additionalPageUrls
    });

    setStatus("Audit generated successfully. Download your document below.", "success", 100);
    liveCrawlBox.className = "live-crawl hidden";
    resultBox.className = "result";
    const markdownHref = data.markdownPath
      ? data.markdownPath
      : `data:text/markdown;charset=utf-8,${encodeURIComponent(data.markdownContent || "")}`;

    resultBox.innerHTML = `
      <div><strong>Store:</strong> ${escapeHtml(data.url)}</div>
      ${formatThemeHtml(data.theme || { displayName: data.themeName })}
      <div><strong>Pages analyzed:</strong> ${data.pagesAnalyzed}</div>
      <div><strong>Format:</strong> ${createMarkdown ? "Markdown (.md)" : "Google Doc only"}</div>
      <div><strong>Mode:</strong> ${escapeHtml(data.modeUsed || "Full")}</div>
      ${
        createMarkdown
          ? `<a class="download" href="${markdownHref}" download>Download Markdown</a>`
          : ""
      }
      ${
        data.googleDocUrl
          ? `<div style="margin-top:10px;padding:10px;border:1px solid #dfcdb9;border-radius:10px;background:#fff8ef;">
               <strong>Google Doc Result:</strong>
               <a class="download" href="${escapeHtml(data.googleDocUrl)}" target="_blank" rel="noopener noreferrer">Open Google Doc</a>
             </div>`
          : ""
      }
      ${
        data.googleDocNote
          ? `<div style="margin-top:10px;color:#64748b;"><strong>Google Doc:</strong> ${escapeHtml(data.googleDocNote)}</div>`
          : ""
      }
      ${
        Array.isArray(data.referenceBenchmarks) && data.referenceBenchmarks.length
          ? `<div style="margin-top:10px;"><strong>Reference Benchmark Screenshots:</strong><br/>${data.referenceBenchmarks
              .map(
                (r, i) =>
                  `<a class="download" href="${escapeHtml(r.screenshotPath)}" target="_blank" rel="noopener noreferrer">Reference ${i + 1}: ${escapeHtml(r.title)}</a>`
              )
              .join("")}</div>`
          : ""
      }
      ${
        Array.isArray(data.referenceSitePoolUsed) && data.referenceSitePoolUsed.length
          ? `<div style="margin-top:10px;color:#64748b;"><strong>Reference Sites Used:</strong> ${escapeHtml(data.referenceSitePoolUsed.join(", "))}</div>`
          : ""
      }
    `;
  } catch (error) {
    setStatus(error.message || "Audit generation failed.", "error", 0);
  } finally {
    submitBtn.disabled = false;
  }
});
