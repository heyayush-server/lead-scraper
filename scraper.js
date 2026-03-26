/**
 * services/scraper.js
 * Scrapes Google Maps with Puppeteer + stealth plugin.
 */
const puppeteer      = require("puppeteer-extra");
const StealthPlugin  = require("puppeteer-extra-plugin-stealth");
const { v4: uuid }   = require("uuid");

puppeteer.use(StealthPlugin());

const PLATFORM_DOMAINS = [
  "zomato.com","swiggy.com","justdial.com","sulekha.com",
  "indiamart.com","magicpin.in","practo.com","lybrate.com",
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
];

const delay = ms => new Promise(r => setTimeout(r, ms));

async function scrapeGoogleMaps(keyword, location, limit = 30) {
  const query = `${keyword} in ${location}`;
  const url   = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,800",
      ...(process.env.PROXY_URL ? [`--proxy-server=${process.env.PROXY_URL}`] : []),
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });

    // Accept consent if shown
    try {
      const consent = await page.$('button[aria-label*="Accept"]');
      if (consent) { await consent.click(); await delay(800); }
    } catch (_) {}

    // Scroll the results feed to load enough listings
    const feed = 'div[role="feed"]';
    await page.waitForSelector(feed, { timeout: 15_000 });

    let prev = 0, tries = 0, maxTries = Math.ceil(limit / 6) + 4;
    while (tries++ < maxTries) {
      await page.evaluate(sel => {
        document.querySelector(sel)?.scrollBy(0, 1400);
      }, feed);
      await delay(1_400 + Math.random() * 600);
      const count = await page.$$eval('a[href*="/maps/place/"]', els => els.length);
      if (count >= limit) break;
      if (count === prev) { await delay(1500); break; }
      prev = count;
    }

    // Collect unique place links
    const links = await page.$$eval(
      'a[href*="/maps/place/"]',
      (els, max) => [...new Set(els.map(e => e.href))].slice(0, max),
      limit
    );

    const results = [];
    for (const link of links) {
      try {
        const biz = await scrapePlacePage(page, link);
        if (biz) results.push(biz);
        await delay(700 + Math.random() * 500);
      } catch (e) {
        console.warn("[scraper] skip:", e.message);
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}

async function scrapePlacePage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await delay(900 + Math.random() * 400);

  const data = await page.evaluate(() => {
    const t  = sel => document.querySelector(sel)?.textContent?.trim() ?? null;
    const at = (sel, a) => document.querySelector(sel)?.getAttribute(a) ?? null;

    return {
      name:     t('h1[class*="DUwDvf"]') || t("h1") || "Unknown",
      rating:   parseFloat(t('[class*="F7nice"] [aria-hidden]') || "0") || 0,
      reviews:  parseInt((t('[class*="F7nice"] button span') || "0").replace(/\D/g, "")) || 0,
      category: t('[class*="DkEaL"]') || t('button[jsaction*="category"]') || "Business",
      address:  document.querySelector('[data-item-id="address"]')
                  ?.querySelector('[class*="Io6YTe"]')?.textContent?.trim() || "",
      phone:    document.querySelector('[data-tooltip="Copy phone number"]')
                  ?.parentElement?.querySelector('[class*="Io6YTe"]')?.textContent?.trim() || "",
      website:  document.querySelector('a[data-item-id="authority"]')?.href || null,
    };
  });

  // Detect platform-only presence
  let platformOnly = null;
  let cleanWebsite = data.website;

  if (data.website) {
    try {
      const host = new URL(data.website).hostname.toLowerCase();
      const match = PLATFORM_DOMAINS.find(d => host.includes(d.split(".")[0]));
      if (match) {
        platformOnly = match.split(".")[0].replace(/^\w/, c => c.toUpperCase());
        cleanWebsite = null; // treat as no real website
      }
    } catch (_) {}
  }

  return {
    id:           uuid(),
    name:         data.name,
    category:     data.category,
    phone:        data.phone,
    address:      data.address,
    website:      cleanWebsite,
    platformOnly,
    rating:       data.rating,
    reviews:      data.reviews,
  };
}

module.exports = { scrapeGoogleMaps };
