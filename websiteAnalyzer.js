/**
 * services/websiteAnalyzer.js
 * Checks a business website for SSL, mobile-friendliness,
 * load speed, and UI quality. Returns a 0–100 score.
 */
const puppeteer     = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { URL }       = require("url");

puppeteer.use(StealthPlugin());

async function analyze(websiteUrl) {
  if (!websiteUrl) {
    return { hasWebsite: false, websiteScore: 0, ssl: false,
             mobileFriendly: false, pageSpeed: null, issues: [] };
  }

  let url;
  try {
    url = websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`;
    new URL(url); // validate
  } catch {
    return { hasWebsite: true, websiteScore: 5, ssl: false,
             mobileFriendly: false, pageSpeed: null, issues: ["Invalid URL"] };
  }

  const ssl = url.startsWith("https://");
  let mobileFriendly = false, pageSpeed = null, uiScore = 20;
  const issues = [];

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    // Use mobile viewport to test responsiveness
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await page.setDefaultNavigationTimeout(14_000);

    const t0 = Date.now();
    let ok = true;
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      ok = resp?.ok() ?? true;
    } catch {
      ok = false;
      issues.push("Page failed to load");
    }
    pageSpeed = +((Date.now() - t0) / 1000).toFixed(1);

    if (!ok) issues.push("Server error response");
    if (pageSpeed > 8)  issues.push("Extremely slow load (>" + pageSpeed + "s)");
    else if (pageSpeed > 4) issues.push("Slow load time (" + pageSpeed + "s)");

    // Run heuristics inside the page
    const checks = await page.evaluate(() => {
      const html  = document.documentElement.innerHTML;
      const text  = document.body?.innerText || "";
      const vp    = document.querySelector('meta[name="viewport"]')?.content || "";
      return {
        hasMobileVP:    vp.includes("width=device-width"),
        hasH1:          !!document.querySelector("h1"),
        hasImages:      document.querySelectorAll("img").length > 0,
        hasPhone:       /(\+91|0\d{9,10}|\d{10})/.test(text),
        hasNav:         !!(document.querySelector("nav") || document.querySelector("header")),
        hasFooter:      !!document.querySelector("footer"),
        hasCTA:         /contact|call|enquir|book|order|buy|whatsapp/i.test(html),
        hasSchema:      html.includes('"application/ld+json"'),
        textLen:        text.length,
        linkCount:      document.querySelectorAll("a").length,
        imgCount:       document.querySelectorAll("img").length,
      };
    }).catch(() => ({}));

    mobileFriendly = !!checks.hasMobileVP;

    // Build score
    let score = 25;
    if (ssl)                   score += 12;
    if (checks.hasMobileVP)    score += 12;
    if (pageSpeed < 3)         score += 10;
    else if (pageSpeed < 5)    score += 5;
    if (checks.hasH1)          score += 6;
    if (checks.hasImages)      score += 6;
    if (checks.hasPhone)       score += 8;
    if (checks.hasNav)         score += 5;
    if (checks.hasFooter)      score += 4;
    if (checks.hasCTA)         score += 5;
    if (checks.hasSchema)      score += 4;
    if (checks.textLen > 300)  score += 3;
    uiScore = Math.min(100, score);

    // Collect issues
    if (!ssl)               issues.push("No SSL (HTTP only)");
    if (!checks.hasMobileVP) issues.push("Not mobile-friendly");
    if (!checks.hasH1)      issues.push("Missing H1 heading");
    if (!checks.hasPhone)   issues.push("No phone number visible");
    if (!checks.hasNav)     issues.push("No navigation menu");
    if (!checks.hasFooter)  issues.push("No footer");
    if (!checks.hasCTA)     issues.push("No call-to-action");
    if (checks.textLen < 200) issues.push("Very thin content");

  } catch (err) {
    console.warn("[analyzer]", err.message);
    issues.push("Analysis error");
  } finally {
    await browser.close();
  }

  return {
    hasWebsite:     true,
    websiteScore:   Math.max(0, uiScore),
    ssl,
    mobileFriendly,
    pageSpeed,
    issues:         [...new Set(issues)],
  };
}

module.exports = { analyze };
