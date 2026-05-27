# Shopify Theme Audit Agent

A Shopify-only AI agent that generates a structured audit document from a store URL.

## What it does

- Validates the URL and confirms it appears to be a Shopify storefront.
- Crawls key pages (home, one collection, one product, plus common utility pages).
- Extracts UX/CRO/technical signals (header behavior, CTA visibility, trust elements, typography hints, etc.).
- Sends structured findings to an LLM and produces a polished markdown report similar to your sample audit format.

## Theme-agnostic feature detection

The crawler does NOT rely on hardcoded class names from any specific theme. Each
feature (sticky header, zoom, quick view, wishlist, trust strip, filters, etc.)
is detected through multiple independent strategies:

- Shopify 2.0 semantic markers (`data-section-type`, `[is=...]` custom elements)
- Case-insensitive substring class matching (handles BEM, PascalCase, snake_case)
- Known library/app fingerprints (PhotoSwipe, Fancybox, GLightbox, Drift, Swym
  wishlist, Judge.me, Yotpo, Stamped, Loox, Okendo, Tawk, Intercom, Zendesk,
  Drift, Crisp, Gorgias, Tidio, etc.)
- Aria attributes and page text patterns
- Runtime scroll/CSS probes (Playwright)

Every detector returns `{ present, confidence, evidence }` where `present` can be
`true`, `false`, or `null` (unknown). The aggregator then groups findings into
four buckets (PRESENT, LIKELY PRESENT, UNCERTAIN, CONFIRMED ABSENT) which are
passed to the LLM. This eliminates the most common audit failure: recommending
the merchant ADD a feature that already exists under a non-standard class name.

After the LLM generates the report, a post-processor (in
`src/auditService.js`) iterates over every confirmed feature and strips any
"add/implement/introduce" recommendation bullets that match the false-positive
patterns defined in `ADD_FEATURE_PHRASES` (`src/featureDetection.js`).

The agent has been tested across Dawn, Sense, Refresh, Studio, Crave, Impulse,
Motion, Empire, Prestige, Warehouse, Hyper, and other common themes.

### Runtime hover probe (for hover-state and quick-add detection)

Some signals — product-card hover state, image swap on hover, reveal-on-hover
quick-add buttons — cannot be detected reliably from static HTML alone because
the CSS `:hover` pseudo-class only fires when the actual mouse cursor is over
the element. We solve this by running a Playwright-based runtime probe on the
first product card of each collection page:

1. The crawler calls `page.hover()` on a real `[class*='product-card']`
   element (this is the only way to truly trigger `:hover` CSS rules — JS
   `MouseEvent` dispatch does not).
2. It captures a snapshot of opacity, visibility, display, transform,
   background-image and `<img>.src` for up to 80 descendants.
3. It then re-snapshots and compares: any change is taken as evidence that a
   hover state exists.
4. Newly-visible quick-add buttons are also recorded.

If the runtime probe confirms a hover effect, the feature is upgraded to
`present: true, confidence: 'high'`. If the probe runs and explicitly sees no
change, the feature is marked `false, confidence: 'high'` — a real,
trustworthy "absent" rather than a guess.

## CRO checkpoint baseline (`src/shopifyStandards.js`)

The audit verifies against ~185 specific, observable CRO checkpoints organised
across 9 areas: general / site-wide, navigation, search, cart widget, footer,
home, collection, product, cart. These come from a structured CRO checklist (a
real consultant's verification baseline) and replace the prior loose
"best-practice" prose.

Each checkpoint optionally links to a feature key from `featureDetection.js`.
When the prompt is built (`src/auditPrompt.js`), every checkpoint is annotated
based on detection:

- `[✓ DETECTED — do NOT flag as missing]` — feature is present in the store
- `[✗ CONFIRMED MISSING — safe to recommend adding]` — feature genuinely absent
- `[? uncertain — only flag with specific page evidence]`
- `[unknown — verify against page evidence]` — no automatic mapping

This gives the LLM a concrete pre-verified list to score against, instead of
having to invent generic ideas. Combined with the "no generic recommendations"
hard rule and the post-processor's `GENERIC_BULLET_PATTERNS` filter, the
report only contains specific, evidence-anchored findings.

## Output format

The generated report includes:

- Summary
- Home Page - Shopify Requirements Verification (Section-by-Section)
- Home Page – Key Areas of Improvement
- Collection Page – Key Areas of Improvement
- Product Page – Key Areas of Improvement
- Other Pages – Key Areas of Improvement
- Final Recommendation

By default, each run now creates:
- Markdown report (`.md`)

## Prerequisites

- Node.js 18+
- An OpenRouter API key (recommended), or OpenAI-compatible API key

## Setup

```bash
npm install
cp .env.example .env
```

Set your API key in `.env`:

```env
OPENROUTER_API_KEY=your_key_here
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-4.1-mini
```

Optional OpenRouter headers:

```env
OPENROUTER_HTTP_REFERER=https://your-site-or-portfolio.com
OPENROUTER_X_TITLE=Shopify Theme Audit Agent
```

## Usage

```bash
npm run audit -- --url https://www.sermanbrands.com/
```

Optional arguments:

- `--out ./reports/serman-audit.md` custom output path
- `--max-pages 3` crawl limit (default `3`, fastest)
- `--docx` optionally generate DOCX as well

## Frontend (URL input + download)

Start the web app:

```bash
npm run dev
```

Open:

- `http://localhost:3000`

Flow:

- Enter Shopify store URL
- Optionally add extra same-domain page URLs under **Additional Pages to Audit**
- Optional: enable **Also create Google Doc automatically**
- Click **Generate Audit Document**
- Download generated `.md` from the UI

## Deploy on Vercel

1. Push this project to GitHub.
2. Import the repo in Vercel.
3. Add environment variables in Vercel Project Settings:
   - `OPENROUTER_API_KEY`
   - `OPENROUTER_BASE_URL`
   - `OPENAI_MODEL`
   - Optional Google Doc vars (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_DRIVE_FOLDER_ID`)
4. Deploy.

Notes for Vercel:
- The app runs through `api/index.js` serverless entrypoint.
- Markdown download is returned directly from API response (no persistent `reports/` storage required).
- For reliability in serverless limits, Vercel mode forces:
  - fast mode on
  - benchmark screenshot crawling off
  - local screenshot capture off

## Google Doc Auto-Create (optional)

You can configure either:

- OAuth user auth (recommended)
- Service account auth (fallback)

### Option A: OAuth user auth (recommended)

```env
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_SHARE_WITH_EMAIL=you@example.com
```

### Option B: Service account auth

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_SHARE_WITH_EMAIL=you@example.com
```

Notes:
- If credentials are missing, audit still works and returns markdown.
- If enabled and configured, frontend shows an **Open Google Doc** link after generation.
- If service account returns `storageQuotaExceeded`, switch to OAuth user auth or use a Shared Drive.

## Notes for Shopify auditing

- This agent is intentionally constrained to Shopify stores only.
- If a site is not detected as Shopify, it exits with a clear message.
- You can tune scoring and section prompts in `src/auditPrompt.js`.

## Recommended next upgrades

- Add screenshot capture with annotation references.
- Add Lighthouse/PageSpeed measurements and include in report.
- Add a confidence score per recommendation.
- Add multi-store batch mode from CSV.
 