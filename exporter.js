/**
 * services/exporter.js
 * Exports leads to CSV or XLSX.
 */
const XLSX = require("xlsx");

const COLS = [
  ["name",               "Business Name"],
  ["category",           "Category"],
  ["phone",              "Phone"],
  ["address",            "Address"],
  ["website",            "Website URL"],
  ["platformOnly",       "Platform Only (Zomato etc.)"],
  ["rating",             "Rating"],
  ["reviews",            "Reviews"],
  ["hasWebsite",         "Has Website"],
  ["websiteScore",       "Website Score (0-100)"],
  ["ssl",                "SSL / HTTPS"],
  ["mobileFriendly",     "Mobile Friendly"],
  ["pageSpeed",          "Page Speed (sec)"],
  ["issues",             "Issues Found"],
  ["leadScore",          "Lead Priority"],
  ["revenueOpportunity", "Revenue Opportunity"],
  ["contactScript",      "Contact Script"],
];

function fmt(val) {
  if (val === null || val === undefined) return "";
  if (Array.isArray(val)) return val.join("; ");
  if (typeof val === "boolean") return val ? "Yes" : "No";
  return String(val);
}

function toCSV(leads) {
  const header = COLS.map(([, label]) => `"${label}"`).join(",");
  const rows   = leads.map(l =>
    COLS.map(([key]) => `"${fmt(l[key]).replace(/"/g, '""')}"`).join(",")
  );
  return [header, ...rows].join("\n");
}

function toXLSX(leads) {
  const data = [
    COLS.map(([, label]) => label),
    ...leads.map(l => COLS.map(([key]) => fmt(l[key]))),
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = COLS.map(([key]) =>
    key === "contactScript" ? { wch: 100 } :
    key === "address"       ? { wch: 45 }  :
    key === "issues"        ? { wch: 50 }  : { wch: 20 }
  );
  XLSX.utils.book_append_sheet(wb, ws, "Leads");

  // Summary sheet
  const stats = [
    ["Metric", "Count"],
    ["Total leads", leads.length],
    ["HIGH priority", leads.filter(l => l.leadScore === "HIGH").length],
    ["MEDIUM priority", leads.filter(l => l.leadScore === "MEDIUM").length],
    ["LOW priority", leads.filter(l => l.leadScore === "LOW").length],
    ["No website", leads.filter(l => !l.hasWebsite).length],
    ["Platform only", leads.filter(l => l.platformOnly).length],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stats), "Summary");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

module.exports = { toCSV, toXLSX };
