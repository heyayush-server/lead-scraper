/**
 * LeadMapper – Single Server
 * Serves the frontend HTML + API from one Express app on port 3000.
 * No separate React dev server needed.
 */

require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const path     = require("path");
const fs       = require("fs");

const scraper   = require("./services/scraper");
const analyzer  = require("./services/websiteAnalyzer");
const scorer    = require("./services/leadScorer");
const exporter  = require("./services/exporter");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DB ───────────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "data", "leadmapper.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS scrape_jobs (
    id          TEXT PRIMARY KEY,
    keyword     TEXT NOT NULL,
    location    TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    total       INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS leads (
    id                 TEXT PRIMARY KEY,
    job_id             TEXT NOT NULL,
    name               TEXT,
    category           TEXT,
    phone              TEXT,
    address            TEXT,
    website            TEXT,
    platform_only      TEXT,
    rating             REAL,
    reviews            INTEGER,
    website_score      INTEGER DEFAULT 0,
    has_website        INTEGER DEFAULT 0,
    ssl                INTEGER DEFAULT 0,
    mobile_friendly    INTEGER DEFAULT 0,
    page_speed         REAL,
    issues             TEXT,
    lead_score         TEXT,
    revenue_opportunity TEXT,
    contact_script     TEXT,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES scrape_jobs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_leads_job  ON leads(job_id);
  CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(lead_score);
`);

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use("/api", rateLimit({ windowMs: 60_000, max: 40 }));

// ── Serve frontend HTML ──────────────────────────────────────────────────────
// The entire React-style UI is in public/index.html (plain HTML + inline JS).
// No build step, no npm install for frontend — just open localhost:3000.
app.use(express.static(path.join(__dirname, "public")));

// ── SSE job registry ─────────────────────────────────────────────────────────
const activeJobs = new Map(); // jobId → [res, ...]

function emit(jobId, event, data) {
  (activeJobs.get(jobId) || []).forEach(res =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  );
}

// ── API Routes ───────────────────────────────────────────────────────────────

/** POST /api/scrape  – start a job */
app.post("/api/scrape", async (req, res) => {
  const { keyword, location, limit = 30 } = req.body;
  if (!keyword?.trim() || !location?.trim())
    return res.status(400).json({ error: "keyword and location are required" });

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  db.prepare("INSERT INTO scrape_jobs (id,keyword,location) VALUES (?,?,?)").run(jobId, keyword, location);
  res.json({ jobId });

  runJob(jobId, keyword.trim(), location.trim(), Math.min(Number(limit) || 30, 80))
    .catch(err => {
      console.error("[job error]", err.message);
      db.prepare("UPDATE scrape_jobs SET status='error' WHERE id=?").run(jobId);
      emit(jobId, "error", { message: err.message });
      (activeJobs.get(jobId) || []).forEach(r => r.end());
      activeJobs.delete(jobId);
    });
});

/** GET /api/scrape/stream/:jobId  – SSE progress stream */
app.get("/api/scrape/stream/:jobId", (req, res) => {
  const { jobId } = req.params;
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  res.flushHeaders();

  if (!activeJobs.has(jobId)) activeJobs.set(jobId, []);
  activeJobs.get(jobId).push(res);

  req.on("close", () => {
    const remaining = (activeJobs.get(jobId) || []).filter(r => r !== res);
    remaining.length ? activeJobs.set(jobId, remaining) : activeJobs.delete(jobId);
  });

  // If already done, reply immediately
  const job = db.prepare("SELECT status FROM scrape_jobs WHERE id=?").get(jobId);
  if (job?.status === "completed") {
    const leads = db.prepare("SELECT * FROM leads WHERE job_id=?").all(jobId).map(hydrate);
    res.write(`event: completed\ndata: ${JSON.stringify({ leads, total: leads.length })}\n\n`);
    res.end();
  }
});

/** GET /api/leads?jobId=&leadScore=&hasWebsite=&minRating=&search= */
app.get("/api/leads", (req, res) => {
  const { jobId, leadScore, hasWebsite, minRating, search,
          sortBy = "lead_score", order = "ASC", limit = 200, offset = 0 } = req.query;

  let q = "SELECT * FROM leads WHERE 1=1";
  const p = [];
  if (jobId)      { q += " AND job_id=?";                    p.push(jobId); }
  if (leadScore)  { q += " AND lead_score=?";                p.push(leadScore); }
  if (hasWebsite !== undefined) { q += " AND has_website=?"; p.push(hasWebsite === "true" ? 1 : 0); }
  if (minRating)  { q += " AND rating>=?";                   p.push(+minRating); }
  if (search)     { q += " AND (name LIKE ? OR address LIKE ?)"; p.push(`%${search}%`, `%${search}%`); }

  const safe = ["name","rating","website_score","lead_score","created_at"];
  q += ` ORDER BY ${safe.includes(sortBy) ? sortBy : "lead_score"} ${order === "DESC" ? "DESC" : "ASC"}`;
  q += " LIMIT ? OFFSET ?";
  p.push(+limit, +offset);

  res.json({ leads: db.prepare(q).all(...p).map(hydrate) });
});

/** GET /api/leads/export?jobId=&format=csv|json|xlsx */
app.get("/api/leads/export", (req, res) => {
  const { jobId, format = "csv" } = req.query;
  const leads = db.prepare("SELECT * FROM leads WHERE job_id=?").all(jobId).map(hydrate);

  if (format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="leads.json"`);
    return res.json(leads);
  }
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="leads.csv"`);
    return res.send(exporter.toCSV(leads));
  }
  if (format === "xlsx") {
    const buf = exporter.toXLSX(leads);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="leads.xlsx"`);
    return res.send(buf);
  }
  res.status(400).json({ error: "format must be csv, json, or xlsx" });
});

/** GET /api/stats/:jobId */
app.get("/api/stats/:jobId", (req, res) => {
  const id = req.params.jobId;
  const g = (q, ...p) => db.prepare(q).get(...p);
  res.json({
    total:    g("SELECT COUNT(*) c FROM leads WHERE job_id=?", id).c,
    high:     g("SELECT COUNT(*) c FROM leads WHERE job_id=? AND lead_score='HIGH'", id).c,
    medium:   g("SELECT COUNT(*) c FROM leads WHERE job_id=? AND lead_score='MEDIUM'", id).c,
    low:      g("SELECT COUNT(*) c FROM leads WHERE job_id=? AND lead_score='LOW'", id).c,
    noWebsite:g("SELECT COUNT(*) c FROM leads WHERE job_id=? AND has_website=0", id).c,
    avgScore: Math.round(g("SELECT AVG(website_score) a FROM leads WHERE job_id=? AND has_website=1", id).a || 0),
  });
});

/** GET /api/jobs */
app.get("/api/jobs", (_req, res) =>
  res.json(db.prepare("SELECT * FROM scrape_jobs ORDER BY created_at DESC LIMIT 20").all())
);

// ── Core pipeline ────────────────────────────────────────────────────────────
async function runJob(jobId, keyword, location, limit) {
  db.prepare("UPDATE scrape_jobs SET status='running' WHERE id=?").run(jobId);

  emit(jobId, "progress", { step: "Opening browser…", pct: 5 });
  const businesses = await scraper.scrapeGoogleMaps(keyword, location, limit);
  emit(jobId, "progress", { step: `Found ${businesses.length} businesses. Checking websites…`, pct: 35 });

  const insert = db.prepare(`
    INSERT OR REPLACE INTO leads
    (id,job_id,name,category,phone,address,website,platform_only,rating,reviews,
     website_score,has_website,ssl,mobile_friendly,page_speed,issues,
     lead_score,revenue_opportunity,contact_script)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const leads = [];
  for (let i = 0; i < businesses.length; i++) {
    const biz = businesses[i];
    emit(jobId, "progress", {
      step: `Analysing ${biz.name}…`,
      pct:  35 + Math.floor((i / businesses.length) * 55),
      done: i + 1, total: businesses.length,
    });

    const analysis = await analyzer.analyze(biz.website);
    const scored   = scorer.score(biz, analysis);
    const row      = { ...biz, ...analysis, ...scored };

    insert.run(
      row.id, jobId, row.name, row.category, row.phone, row.address,
      row.website, row.platformOnly, row.rating, row.reviews,
      row.websiteScore, row.hasWebsite ? 1 : 0,
      row.ssl ? 1 : 0, row.mobileFriendly ? 1 : 0, row.pageSpeed,
      JSON.stringify(row.issues || []),
      row.leadScore, row.revenueOpportunity, row.contactScript
    );
    leads.push(row);
    emit(jobId, "lead", { lead: row });
  }

  db.prepare("UPDATE scrape_jobs SET status='completed',total=?,completed_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(leads.length, jobId);
  emit(jobId, "completed", { leads, total: leads.length });
  (activeJobs.get(jobId) || []).forEach(r => r.end());
  activeJobs.delete(jobId);
}

function hydrate(row) {
  return {
    ...row,
    issues:        JSON.parse(row.issues || "[]"),
    hasWebsite:    Boolean(row.has_website),
    ssl:           Boolean(row.ssl),
    mobileFriendly:Boolean(row.mobile_friendly),
  };
}

// Catch-all → serve index.html (SPA fallback)
app.get("*", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(PORT, () => {
  console.log(`\n🚀 LeadMapper running → http://localhost:${PORT}\n`);
});
