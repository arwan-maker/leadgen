// Parses free-text budgets ("$800k", "800,000", "1.2M", "$2,500/mo", "600-750k", "under 900k", "1M+").
// Returns { min, max, monthly } (min or max may be null), or null when there's no number.
const NUM_RE = /(\d[\d,]*(?:\.\d+)?)\s*(k|m{1,2}|million|thousand)?\b/gi;
const MULT = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6 };

export function parseBudget(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const nums = [];
  for (const m of t.matchAll(NUM_RE)) {
    const value = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) nums.push({ value, unit: m[2] ? MULT[m[2]] : null });
  }
  if (!nums.length) return null;
  // "600-750k": the second number's unit carries back to a bare first number.
  if (nums.length > 1 && !nums[0].unit && nums[1].unit && nums[0].value < 1000) nums[0].unit = nums[1].unit;
  const values = nums.slice(0, 2).map((n) => Math.round(n.value * (n.unit || 1)));
  const monthly = /\/\s*(mo|month)|per month|monthly|a month|rent/.test(t) || values[values.length - 1] < 20000;
  if (values.length > 1) return { min: Math.min(...values), max: Math.max(...values), monthly };
  const v = values[0];
  if (/\+|over|above|at least|min(imum)?\b|from/.test(t)) return { min: v, max: null, monthly };
  return { min: null, max: v, monthly };
}

// Google lead forms put answers in the message, e.g. "Budget?: $800k".
export function budgetText(lead) {
  if (lead.budget) return lead.budget;
  const line = String(lead.message || "").split("\n").find((l) => /budget|price/i.test(l));
  return line ? line.replace(/^[^:]*:/, "") : null;
}
