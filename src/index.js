import "dotenv/config";
import { runAudit } from "./auditService.js";
import { normalizeStoreUrl, parseArgs } from "./utils.js";

async function main() {
  const {
    url,
    out,
    maxPages,
    docx,
    fastMode,
    includeScreenshots,
    includeReferenceBenchmarks
  } = parseArgs(
    process.argv.slice(2)
  );
  const normalized = normalizeStoreUrl(url);
  if (!normalized) {
    console.error("Invalid or missing URL. Use: --url https://example.com");
    process.exit(1);
  }

  if (!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error(
      "Missing API key. Set OPENROUTER_API_KEY (recommended) or OPENAI_API_KEY."
    );
    process.exit(1);
  }

  console.log(`Auditing Shopify store: ${normalized}`);
  const { outputPath, docxPath, pagesAnalyzed } = await runAudit({
    url: normalized,
    out,
    maxPages,
    docx,
    fastMode,
    includeScreenshots,
    includeReferenceBenchmarks
  });

  console.log(`Audit saved to: ${outputPath}`);
  console.log(`Pages analyzed: ${pagesAnalyzed}`);
  if (docxPath) {
    console.log(`Document saved to: ${docxPath}`);
  }
}

main().catch((err) => {
  console.error("Audit failed:", err.message);
  process.exit(1);
});
