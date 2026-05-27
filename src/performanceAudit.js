export async function runPerformanceAudit(url) {
  const isVercelRuntime = Boolean(process.env.VERCEL || process.env.NOW_REGION);
  const isDisabledByEnv = String(process.env.DISABLE_PERFORMANCE_AUDIT || "").toLowerCase() === "true";
  if (isVercelRuntime || isDisabledByEnv) {
    return null;
  }

  let browser = null;
  try {
    // Lazy-load heavy modules so serverless packaging/runtime is not blocked.
    const [{ default: lighthouse }, puppeteer] = await Promise.all([
      import("lighthouse"),
      import("puppeteer")
    ]);

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const runnerResult = await lighthouse(url, {
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'seo', 'best-practices'],
      port: new URL(browser.wsEndpoint()).port,
    });

    const report = runnerResult.lhr;
    const categories = report.categories;

    return {
      performance: {
        score: Math.round(categories.performance.score * 100),
        metrics: {
          firstContentfulPaint: report.audits['first-contentful-paint']?.displayValue,
          speedIndex: report.audits['speed-index']?.displayValue,
          largestContentfulPaint: report.audits['largest-contentful-paint']?.displayValue,
          cumulativeLayoutShift: report.audits['cumulative-layout-shift']?.displayValue,
          totalBlockingTime: report.audits['total-blocking-time']?.displayValue,
        } 
      },
      accessibility: {
        score: Math.round(categories.accessibility.score * 100),
      },
      seo: {
        score: Math.round(categories.seo.score * 100),
      },
      bestPractices: {
        score: Math.round(categories['best-practices'].score * 100),
      }
    };
  } catch (error) {
    console.error('Performance audit failed:', error.message);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
} 