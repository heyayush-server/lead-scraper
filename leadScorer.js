/**
 * services/leadScorer.js
 * Classifies leads and generates contact scripts + revenue estimates.
 */
const { v4: uuid } = require("uuid");

const PREMIUM_CATS = ["hotel","clinic","dental","real estate","event","photography","hospital","resort"];

function score(biz, analysis) {
  const { hasWebsite, websiteScore, ssl, mobileFriendly, pageSpeed, issues } = analysis;

  let leadScore;
  if (!hasWebsite)          leadScore = "HIGH";
  else if (websiteScore < 35) leadScore = "HIGH";
  else if (websiteScore < 65) leadScore = "MEDIUM";
  else                       leadScore = "LOW";

  const isPremium = PREMIUM_CATS.some(c => biz.category?.toLowerCase().includes(c));

  const revenueMap = {
    HIGH:   isPremium ? "₹25K–₹60K" : "₹12K–₹35K",
    MEDIUM: isPremium ? "₹15K–₹30K" : "₹8K–₹20K",
    LOW:    isPremium ? "₹8K–₹15K"  : "₹4K–₹10K",
  };

  return {
    id:                 biz.id || uuid(),
    leadScore,
    revenueOpportunity: revenueMap[leadScore],
    contactScript:      buildScript(biz, analysis, leadScore),
    websiteScore:       websiteScore || 0,
    hasWebsite,
    ssl,
    mobileFriendly,
    pageSpeed,
    issues,
  };
}

function buildScript(biz, analysis, leadScore) {
  const name      = biz.name  || "your business";
  const cat       = biz.category?.toLowerCase() || "business";
  const city      = (biz.address || "").split(",")[1]?.trim() || "your city";
  const { hasWebsite, websiteScore, ssl, mobileFriendly, pageSpeed, issues } = analysis;

  if (!hasWebsite && !biz.platformOnly) {
    return `Hi, am I speaking with the owner of ${name}?\n\nMy name is [Your Name] and I help local ${cat}s in ${city} grow online. I noticed ${name} doesn't have a website yet — and 87% of customers search online before visiting any local business.\n\nI can build you a professional, mobile-friendly website in 7 days starting at ₹12,000, fully integrated with Google Maps and WhatsApp.\n\nCould I get 10 minutes this week for a free consultation?`;
  }

  if (biz.platformOnly) {
    return `Hi, this is [Your Name]. I noticed ${name} is currently listed only on ${biz.platformOnly}.\n\nWhile that's great for discovery, ${biz.platformOnly} takes commission on every order and you own zero customer data. With your own website you get direct bookings, build your own audience, and save lakhs in fees over time.\n\nI've built websites for similar ${cat}s starting at ₹12,000. Can I show you a quick example of what yours could look like — no commitment?`;
  }

  if (websiteScore < 35) {
    const topIssues = issues.slice(0, 3).join(", ") || "multiple problems";
    return `Hi, is this the owner of ${name}?\n\nI ran a quick audit of your website and found some issues: ${topIssues}. ${!ssl ? "The site shows 'Not Secure' in Chrome, which scares visitors away." : ""} ${!mobileFriendly ? "It's also not working properly on mobile — and 70% of your customers are on phones." : ""}\n\nThis is actively costing you customers daily. I specialise in fixing exactly these problems. A full redesign starts at ₹15,000 and takes about 10 days.\n\nCan I send you a free detailed report?`;
  }

  if (websiteScore < 65) {
    return `Hi, this is [Your Name]. I came across ${name}'s website while researching local ${cat}s.\n\nYour site is live which is great, but I noticed ${issues.length > 0 ? issues[0] : "some areas"} that could be improved to get more enquiries from Google.\n\nI'd love to send you a free audit — no strings attached. With your ${biz.rating}⭐ rating you have a great reputation; your website should reflect that.\n\nWould a free report be useful?`;
  }

  return `Hi, this is [Your Name]. ${name} has a solid online presence — well done!\n\nI work with local ${cat}s and noticed a few small SEO tweaks that could meaningfully increase your Google ranking and enquiries. Takes me 5 minutes to explain.\n\nWould you be open to a quick call this week?`;
}

module.exports = { score };
