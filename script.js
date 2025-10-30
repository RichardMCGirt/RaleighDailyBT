
/* ----------------- logger ----------------- */
const $log = document.getElementById('log');
const $verbose = document.getElementById('verbose');
function log(msg, cls=""){ const d=document.createElement('div'); d.textContent=msg; if(cls)d.className=cls; $log.appendChild(d); $log.scrollTop=$log.scrollHeight; }
function vlog(msg, cls=""){ if($verbose.checked) log(msg, cls); }
function sep(){ vlog("—".repeat(72)); }

/* ----------------- helpers ---------------- */
function safeCell(v){ return v==null ? "" : (typeof v==="string"? v : String(v)); }
function norm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,""); }
function isTruthy(v){ const t=String(v).trim().toLowerCase(); if (t==="") return false; return ["true","1","yes","y","to pay","pay","x","✓"].includes(t) || (t!=="false"&&t!=="0"&&t!=="no"); }
function isFalse(v){ const t=String(v).trim().toLowerCase(); return t==="false"||t==="0"||t==="no"; }
function dateStamp(){ const d=new Date(); const mm=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); const yyyy=String(d.getFullYear()); return `${mm}-${dd}-${yyyy}`; }
function colLetterFromIndex(i){ let n=i+1,s=""; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26);} return s; }
function dumpRow(label, row, n=30){ const cells=(row||[]).slice(0,n).map((v,i)=>`${colLetterFromIndex(i)}:${safeCell(v)}`); vlog(`${label}: ${cells.join(" | ")}`); }
function contains(hay, needle){
  const h = String(hay || "").toLowerCase();
  const n = String(needle || "").toLowerCase();
  return h.includes(n);
}

/* ----------------- DOM -------------------- */
const $file = document.getElementById('fileInput');
const $run = document.getElementById('runBtn');
const $download = document.getElementById('downloadBtn');
const $countBadge = document.getElementById('countBadge');
const $summary = document.getElementById('summary');
const $grid = document.getElementById('grid');
const $inspectInput = document.getElementById('inspectInput');
const $inspectBtn = document.getElementById('inspectBtn');
const $inspectOut = document.getElementById('inspectOut');
const IGNORED_TRADES = new Set(["housewrap", "porch"]); // never surface these trades in UI
const STRICT_COMPLETION_TRADES = new Set(["porch", "screen porch"]);

/* ----------------- state ------------------ */
let workbook = null;
let state = null;

/* ----------------- config ----------------- */
const TRADES = [
  "Painters","Siding","Columns","Trellis","Porch","Screen Porch", // ← added
  "Decking","Waterproof","Louvered Wall","Gutters"
];
// ---- Trade detection helpers ----
const TRADE_GROUPS = {
  siding:       ["siding"],
  decking:      ["decking", "deck ", "waterproof deck", "composite deck", "trex"],
  rails:        ["rail", "rails"],
  paint:        ["paint", "painter", "painting"],
  housewrap:    ["house wrap","housewrap"],
  "screen porch": ["screen porch", "screened porch"]
};
// Map pretty UI labels in TRADES → keys in TRADE_GROUPS (or fallbacks)
const TRADE_TOKEN_MAP = {
  "Siding": "siding",
  "Decking": "decking",
  "Painters": "paint",
  "Columns": "columns",
  "Trellis": "trellis",
  "Screen Porch": "screen porch",
  "Waterproof": "waterproof",
  "Louvered Wall": "louvered wall",
  "Gutters": "gutters"
};
function hasAnyCloseOutSoft(records, info){
  return records.some(({ r }) => {
    const s = textOf(r, info);
    const looks100 = s.includes("100% job complete");
    const looksInspected = s.includes("job complete/inspected");
    if (!(looks100 || looksInspected)) return false;
    const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const done = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
    return done || (!isNaN(pct) && pct >= 100); // ← allow %≥100 as “soft done”
  });
}

function tokensFor(trade){
  const key = TRADE_TOKEN_MAP[trade] || trade.toLowerCase();
  return Array.isArray(TRADE_GROUPS[key]) ? TRADE_GROUPS[key] : [key];
}

function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }
function labelForTrade(trade){ return trade.split(/\s+/).map(capitalize).join(" "); }

function rowIsCompleted(r, info){
  const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
  const done = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
  return done || (!isNaN(pct) && pct >= 100);
}

function textOf(r, info){
  return [
    info.phaseIdx>=0 ? safeCell(r[info.phaseIdx]) : "",
    info.titleIdx>=0 ? safeCell(r[info.titleIdx]) : "",
    info.allNotesIdx>=0 ? safeCell(r[info.allNotesIdx]) : "",
  ].join(" | ").toLowerCase();
}

// Any close-out completion? e.g., "100% Job Complete" or "Job Complete/Inspected" finished
function hasAnyCloseOutComplete(records, info){
  return records.some(({ r }) => {
    const s = textOf(r, info);
    const looks100 = s.includes("100% job complete");
    const looksInspected = s.includes("job complete/inspected");
    if (!(looks100 || looksInspected)) return false;
    // STRICT: only count if Completed=TRUE
    const done = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
    return done === true;
  });
}

// For a specific trade, do we have "<Trade> Complete" finished?
function hasTradeWorkComplete(trade, records, info, tokens){
  return records.some(({ r }) => {
    const s = textOf(r, info);
    const isCompleteLine = s.includes("complete") && tokens.some(tok => s.includes(tok));
    if (!isCompleteLine) return false;
    // STRICT: only trust the Completed boolean for "Complete" lines
    const done = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
    return done === true;
  });
}


function findUnpaidTrade(records, info){
  // rows flattened to searchable strings
  const rows = records.map(({ r }) => ({ r, s: textOf(r, info) }));

  // close-out completion is a global guard you already use
  const closeOutDone = hasAnyCloseOutComplete(records, info);
const closeOutSoft = hasAnyCloseOutSoft(records, info);

  // Iterate over **pretty** trade labels (e.g., "Screen Porch")
  // TRADES: { "Screen Porch": [...tokens], "Porch": [...], ... }
 for (const prettyLabel of TRADES) {
  const tradeKey = prettyLabel.toLowerCase();
  if (IGNORED_TRADES.has(tradeKey)) continue;

  // ✅ get correct tokens for this pretty label
  const tokens = tokensFor(prettyLabel);

    // Your completion check should accept the lower-case key and the tokens for this trade
const tradeComplete = hasTradeCompleteSignal(prettyLabel, records, info);

    // Find "Paid ..." rows that also mention this trade (via its tokens)
    const paidRows = rows.filter(x =>
      x.s.includes("paid") && tokens.some(t => x.s.includes(t))
    );

    const anyPaidPending = paidRows.some(x => !rowIsCompleted(x.r, info));
    const anyPaidDone    = paidRows.some(x =>  rowIsCompleted(x.r, info));

    // Trades that must be COMPLETE before they can be considered "To Pay"
    const requireTradeComplete = STRICT_COMPLETION_TRADES.has(tradeKey);

    // If we have an unfinished "Paid ..." row for this trade (and none finished),
    // and the appropriate completion guard is satisfied, return the **pretty** bucket label.
    if (
      anyPaidPending &&
      !anyPaidDone && // collapse mixed states to "not To Pay"
(requireTradeComplete ? tradeComplete : (tradeComplete || closeOutDone || closeOutSoft))
    ) {
      return {
        trade: tradeKey,
        bucket: `${prettyLabel} To Pay`, // ← matches your column header exactly
        reason: `Title→${prettyLabel} (to pay), Paid-title present (unfinished)`
      };
    }

    // If the trade work is complete but there is no finished "Paid ..." row yet,
    // this is also a To-Pay scenario for that trade.
    if (tradeComplete && !anyPaidDone) {
      return {
        trade: tradeKey,
        bucket: `${prettyLabel} To Pay`, // ← use pretty label for exact match
        reason: `${prettyLabel} complete without payment`
      };
    }
  }

  // Nothing qualifies
  return null;
}

const READY_INVOICE_MODE = "either";

const REQUIRE_INVOICE_PHRASE_FOR_BUCKET = false;

// Keywords proving the trade was actually worked on (loose)
const TRADE_ACTIVITY_KEYWORDS = {
  "Painters":      ["paint","painter","touch-up","touch up","caulk","prime","stain"],
  "Siding":        ["siding","lap","vinyl","hardie","james hardie","fiber cement"],
  "Columns":       ["column","post","wrap"],
  "Trellis":       ["trellis","pergola"],
  "Decking":       ["deck","decking","joist","board"],
  "Waterproof":    ["waterproof","water proof","seal","membrane","flashing"],
  "Louvered Wall": ["louver","louvered wall"],
  "Gutters":       ["gutter","downspout","down spout"],
};
// Map trades to “complete” title patterns (add or adjust as you use in your sheet)
const TRADE_COMPLETE_TITLE_PATTERNS = {
  "Siding": [/^siding complete\b/i, /^job complete\/inspected\b/i],
  "Screen Porch": [/^screen porch complete\b/i, /^porch complete\b/i],
  "Porch": [/^porch complete\b/i],
  "Rails": [/^rails complete\b/i],
  "House Wrap": [/^house wrap complete\b/i],
  // fallbacks: many jobs use “Job Complete/Inspected” as global finish signal
  "_global": [/^job complete\/inspected\b/i, /^100% job complete\b/i],
};

// “to pay/payment due” patterns (we do not include “Paid …” here)
const TRADE_DUE_TITLE_PATTERNS = {
  "Siding":        [/(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b).*(siding|wrap)/i, /(siding|wrap).*(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b)/i],
  "Painters":      [/(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b).*(paint|painter)/i, /(paint|painter).*(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b)/i],
  "Columns":       [/(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b).*(column)/i, /(column).*(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b)/i],
  "Trellis":       [/(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b).*(trellis)/i, /(trellis).*(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b)/i],
  "Decking":       [/(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b).*(deck)/i, /(deck).*(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b)/i],
  "Waterproof":    [/(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b).*(water\s*proof|waterproof)/i, /(water\s*proof|waterproof).*(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b)/i],
  "Louvered Wall": [/(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b).*(louver(ed)?\s*wall|louver)/i, /(louver(ed)?\s*wall|louver).*(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b)/i],
  "Gutters":       [/(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b).*(gutter)/i, /(gutter).*(\bpay\b|\bto\s*pay\b|\bpayment\s*due\b)/i],
};
let TRADE_FINISH_STRICT = false; // set to true for “must have Siding Complete” etc.

const PHRASES_INVOICE = ["invoice","ready to invoice","ready to bill","pay crew","ready to pay","bill now","billing","send invoice","invoice ready","ready for invoice"];
const PHRASES_CLOSE = ["job complete/inspected","job complete","100% job complete","close out","closed"];
const PHRASES_LIEN  = ["lien","liens needed","lien needed"];
function jobReadyForInvoice(records, info){
  let hasJCICompleted = false;
  let hasJCIpct100 = false;
  for (const { r } of records){
    const title = info.titleIdx>=0 ? safeCell(r[info.titleIdx]).toLowerCase() : "";
    const done  = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
    const pct   = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
    if (title.includes("job complete/inspected")){
      if (done === true) hasJCICompleted = true;
      if (!isNaN(pct) && pct >= 100) hasJCIpct100 = true;
    }
  }
  if (READY_INVOICE_MODE === "strict")     return hasJCICompleted;
  if (READY_INVOICE_MODE === "percent100") return hasJCIpct100;
  return hasJCICompleted || hasJCIpct100; // "either"
}

// Returns true if ANY finished trade is unpaid (explicit Paid column FALSE, or title-based “to pay”)
// Uses your existing tradeIsFinished / tradePaidTruthiness / titleIndicatesTradeToPay
function anyUnpaidFinishedTrade(records, info){
  for (const trade of TRADES){
    if (IGNORED_TRADES.has(String(trade).toLowerCase())) continue;
    if (!tradeIsFinished(trade, records, info)) continue;

    const paidTruth = tradePaidTruthiness(trade, records, info);
    if (paidTruth === false) return true;

    if (paidTruth === null){ // no explicit Paid col => rely on title-based hint
      const tokens = tokensFor(trade);
      if (titleIndicatesTradeToPay(trade, records, info, tokens)) return true;
    }
  }
  return false;
}

// Prefer an explicit "Contains Invoice" column if you mapped info.containsInvoiceIdx; else scan text.
function containsInvoiceSignal(records, info){
  if (typeof info.containsInvoiceIdx === "number" && info.containsInvoiceIdx >= 0){
    let sawTrue = false, sawAnyExplicit = false;
    for (const { r } of records){
      const v = r[info.containsInvoiceIdx];
      if (String(v).trim() !== "") sawAnyExplicit = true;
      if (isTruthy(v)) sawTrue = true;
    }
    if (sawTrue) return true;
    if (sawAnyExplicit) return false; // explicit column exists and is all false/blank ⇒ treat as false
    // fall through to text-scan if column exists but is blank everywhere
  }
  // text fallback
  return records.some(({r})=>{
    const s = [
      info.phaseIdx>=0 ? safeCell(r[info.phaseIdx]) : "",
      info.titleIdx>=0 ? safeCell(r[info.titleIdx]) : "",
      info.allNotesIdx>=0 ? safeCell(r[info.allNotesIdx]) : ""
    ].filter(Boolean).join(" | ").toLowerCase();
    return s.includes("invoice") || s.includes("invoiced");
  });
}

/* --------- HOISTED HELPERS --------- */
// --- SAFETY GUARDS ---
function safeArray(a){ return Array.isArray(a) ? a : []; }
function tradeIsFinished(trade, records, info){
  const base = TRADE_COMPLETE_TITLE_PATTERNS[trade] || [];
  const pats = TRADE_FINISH_STRICT
    ? base                                 // strict: per-trade only
    : base.concat(TRADE_COMPLETE_TITLE_PATTERNS._global || []); // allow global finisher

  let soft = false;
  for (const { r } of records){
    const title = info.titleIdx>=0 ? safeCell(r[info.titleIdx]) : "";
    const done  = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
    const pct   = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
    if (pats.some(rx => rx.test(title))){
      if (done === true) return true;       // strict finisher
      if (!isNaN(pct) && pct >= 100) soft = true; // soft finisher
    }
  }
  return soft;
}

// If a trade has contradictory rows (some TRUE, some FALSE) we prefer TRUE
function tradePaidTruthiness(trade, records, info){
  const paidIdx = info.paidByTrade[trade] ?? -1;
  if (paidIdx < 0) return null;
  let sawTrue = false, sawFalse = false;
  for (const { r } of records){
    const v = r[paidIdx];
    if (isTruthy(v)) sawTrue = true;
    else if (isFalse(v)) sawFalse = true;
  }
  if (sawTrue)  return true;   // prefer TRUE if mixed
  if (sawFalse) return false;
  return null;
}

function anyContains(text, phrases){
  const t = String(text || "").toLowerCase();
  const arr = safeArray(phrases);
  return arr.some(p => t.includes(String(p).toLowerCase()));
}

function containsAny(txt, arr){
  const s = String(txt || "").toLowerCase();
  const list = safeArray(arr);
  return list.some(k => s.includes(String(k).toLowerCase()));
}

// (optional) defensive helper used in several places:
function safeSome(arr, pred){
  return Array.isArray(arr) ? arr.some(pred) : false;
}

function reEscape(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildTradeTitlePattern(trade){
  const parts = String(trade||"").trim().split(/\s+/);
  if (!parts.length) return "";
  const leadRaw = parts.slice(0, -1);
  const lastRaw = parts[parts.length - 1] || "";

  const leadEsc = leadRaw.map(reEscape).join('\\s*');
  const lastEsc = reEscape(lastRaw);

  let lastPattern;
  if (/s$/i.test(lastRaw)) {
    const singularEsc = reEscape(lastRaw.replace(/s$/i, ""));
    lastPattern = `(?:${singularEsc}|${lastEsc})`;
  } else {
    lastPattern = `${lastEsc}s?`;
  }
  return (leadEsc ? leadEsc + '\\s*' : '') + lastPattern;
}

// Does this job have any "<Trade> Complete/Completed" line that is actually complete? (Completed=TRUE or pct>=100)
function hasTradeCompleteSignal(trade, records, info){
  const token = buildTradeTitlePattern(trade);
  const completeRx = new RegExp(`${token}[^a-z0-9]*(complete|completed)`, 'i');
  return records.some(({r})=>{
    const title = info.titleIdx>=0 ? safeCell(r[info.titleIdx]) : "";
    const pct   = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const done  = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
    return completeRx.test(title) && (done || (!isNaN(pct) && pct>=100));
  });
}

// Do we see a "Paid <Trade>" row? (optionally unfinished)
function paidTitlePresent(trade, records, info){
  if (info.titleIdx < 0) return false;
  const token = buildTradeTitlePattern(trade);
  const paidRx = new RegExp(`\\bpaid\\b[^a-z0-9]*${token}`, 'i');
  return records.some(({r}) => paidRx.test(safeCell(r[info.titleIdx])));
}

// Is that paid row unfinished? (pct<100 or Completed=FALSE/blank)
function paidTitleUnfinished(trade, records, info){
  if (info.titleIdx < 0) return false;
  const token = buildTradeTitlePattern(trade);
  const paidRx = new RegExp(`\\bpaid\\b[^a-z0-9]*${token}`, 'i');
  return records.some(({r})=>{
    const title = safeCell(r[info.titleIdx]);
    if (!paidRx.test(title)) return false;
    const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const done = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
    return (!done) && (isNaN(pct) || pct < 100);
  });
}

function hasTradeActivity(trade, records, info){
  const keys = (TRADE_ACTIVITY_KEYWORDS[trade]||[]).map(k=>k.toLowerCase());
  if (!keys.length) return true;
  return records.some(({r})=>{
    const txt = [
      info.titleIdx>=0 ? safeCell(r[info.titleIdx]) : "",
      info.phaseIdx>=0 ? safeCell(r[info.phaseIdx]) : "",
      info.allNotesIdx>=0 ? safeCell(r[info.allNotesIdx]) : "",
    ].join(" | ").toLowerCase();
    return keys.some(k => txt.includes(k));
  });
}

function titleIndicatesTradeToPay(trade, records, info, tokens){
  if (IGNORED_TRADES.has(trade)) return false;

  const rows = records.map(({r}) => ({ r, s: textOf(r, info) }));
  const paidRows       = rows.filter(x => x.s.includes("paid") && tokens.some(t => x.s.includes(t)));
  const anyPaidPending = paidRows.some(x => !rowIsCompleted(x.r, info));
  const anyPaidDone    = paidRows.some(x =>  rowIsCompleted(x.r, info));
const tradeComplete  = hasTradeCompleteSignal(trade, records, info);
const closeOutDone   = hasAnyCloseOutComplete(records, info);
const closeOutSoft   = hasAnyCloseOutSoft(records, info);

  // NEW: Porch/Screen Porch must be COMPLETE to consider "To Pay"
  const requireTradeComplete = STRICT_COMPLETION_TRADES.has(trade);

  // Rule 1: unpaid "Paid <Trade>" only counts if completion context satisfied
// For most trades, an unfinished "Paid <Trade>" is enough to surface To Pay.
// Porch/Screen Porch still require actual completion.
if (anyPaidPending && !anyPaidDone) {
  if (requireTradeComplete) {
    if (tradeComplete) return true; // strict trades
  } else {
    return true; // non-strict trades (e.g., Siding) – no completion context required
  }
}
vlog(`[ToPay <- PaidPending] ${trade} (strict=${requireTradeComplete})`);


  // Rule 2: trade completed but no completed payment yet
  if (tradeComplete && !anyPaidDone){
    return true;
  }
// DEBUG: per-trade decision
vlog(`[ToPay?] ${trade} :: paidPending=${anyPaidPending} paidDone=${anyPaidDone} tradeComplete=${tradeComplete} closeOutDone=${closeOutDone} closeOutSoft=${closeOutSoft} requireComplete=${requireTradeComplete}`);

  return false;
}

// === NEW HIDE RULE ===
// If EVERY PercentComplete value present for this job is 0, suppress the job entirely.
function jobShouldBeHiddenForZeroPercents(records, info){
  if (info.percentCompleteIdx < 0) return false; // no pct column, do not hide
  let sawNumeric = false;
  for (const {r} of records){
    const raw = r[info.percentCompleteIdx];
    if (raw === "" || raw == null) continue; // ignore blanks
    const n = Number(raw);
    if (!isNaN(n)){
      sawNumeric = true;
      if (n > 0) return false; // found a positive percent → do not hide
    }
  }
  return sawNumeric; // true if we saw ONLY zeros (and no positives)
}

/* ----------------- file handling ---------- */
$file.addEventListener('change', async ()=>{
  try{
    $log.textContent = "";
    const f = $file.files?.[0]; if(!f) return;
    log("Reading workbook: " + f.name);
    const u8 = new Uint8Array(await f.arrayBuffer());
    workbook = XLSX.read(u8, { type:'array' });

    const sheetName = (workbook.SheetNames||[]).find(n=>n.toLowerCase()==="schedules") || workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(ws, { header:1, defval:"" });

    log("Sheets: " + (workbook.SheetNames||[]).join(", "), "ok");
    const nRows = aoa.length;
    const nCols = Math.max(...aoa.map(r => r.length), 0);
    vlog(`Sheet '${sheetName}' size: ${nRows} rows × ${nCols} columns`, "ok");
    for (let r=0; r<Math.min(3, nRows); r++) dumpRow(`Row ${r+1} (peek)`, aoa[r], 17);
    $summary.textContent = "Ready. Click Compute.";
  }catch(e){ log(e?.message||String(e), "err"); }
});

/* ----------------- main ------------------- */
$run.addEventListener('click', ()=>{
  try{
    if (!workbook) throw new Error("Please upload a workbook first.");
    const sheetName = (workbook.SheetNames||[]).find(n=>n.toLowerCase()==="schedules") || workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(ws, { header:1, defval:"" });
    if (!aoa.length) throw new Error("No rows found.");

    const pick = chooseHeaderRowWithFallback(aoa, 10);
    const headers = aoa[pick.index] || [];
    dumpRow(`Chosen header row ${pick.index+1} (raw)`, headers, 30);
    dumpRow(`Chosen header row ${pick.index+1} (normalized)`, headers.map(norm), 30);

    const info = detectColumnsFrom(headers);
    info.headerRowIndex = pick.index; info.headerReason = pick.reason;

    const mapLines = [];
    mapLines.push(`Job (key) -> ${colLetterFromIndex(info.keyIdx)} (${info.keyIdx})`);
    if (info.phaseIdx>=0) mapLines.push(`Phase -> ${colLetterFromIndex(info.phaseIdx)} (${info.phaseIdx}) [PRIMARY STATUS]`);
    if (info.titleIdx>=0) mapLines.push(`Title -> ${colLetterFromIndex(info.titleIdx)} (${info.titleIdx})`);
    if (info.allNotesIdx>=0) mapLines.push(`All Notes -> ${colLetterFromIndex(info.allNotesIdx)} (${info.allNotesIdx})`);
    if (info.completedIdx>=0) mapLines.push(`Completed -> ${colLetterFromIndex(info.completedIdx)} (${info.completedIdx})`);
    if (info.percentCompleteIdx>=0) mapLines.push(`PercentComplete -> ${colLetterFromIndex(info.percentCompleteIdx)} (${info.percentCompleteIdx})`);
    for (const t of TRADES){
      const p = info.paidByTrade[t]; const q = info.toPayByTrade[t];
      if (p>=0) mapLines.push(`Paid ${t} -> ${colLetterFromIndex(p)} (${p})`);
      if (q>=0) mapLines.push(`${t} To Pay -> ${colLetterFromIndex(q)} (${q})`);
    }
    sep(); vlog("Column mappings:\n" + mapLines.join("\n"), "ok"); sep();

    const rows = aoa.slice(pick.index + 1);
    $countBadge.textContent = `${rows.length} rows`;

    const combinedStatus = (r)=>{
      const parts = [];
      if (info.phaseIdx>=0) parts.push(safeCell(r[info.phaseIdx]));
      if (info.titleIdx>=0) parts.push(safeCell(r[info.titleIdx]));
      if (info.allNotesIdx>=0) parts.push(safeCell(r[info.allNotesIdx]));
      return parts.filter(Boolean).join(" | ");
    };

    // Group rows by job
    const jobGroups = new Map();
    const keyIdx = info.keyIdx;
    rows.forEach((r, i)=>{
      const job = String(r[keyIdx]||"").trim();
      if (!job) return;
      const list = jobGroups.get(job) || [];
      list.push({ r, rowNum: i + (pick.index+2) });
      jobGroups.set(job, list);
    });
    log(`Grouped into ${jobGroups.size} unique jobs.`, "ok");
function classifyJob(job, records, info){
  const d = decideForJob(job, records);
  // return primary + duplicates so the renderer can add both
  return {
    bucket: d.bucket || null,
    reason: d.reason || "",
    trade: d.trade || null,
    extra: d.extra || null,
    duplicates: Array.isArray(d.duplicates)
      ? d.duplicates.map(x => ({
          bucket: x.bucket || null,
          reason: x.reason || "",
          trade: x.trade || null,
          extra: x.extra || null
        }))
      : []
  };
}

function paidFamilyAny(records, info, tokens, decideDone){
  const rows = records.map(({ r }) => ({ r, s: textOf(r, info) }));
  const paidRows = rows.filter(x => x.s.includes("paid") && tokens.some(t => x.s.includes(t)));
  if (!paidRows.length) return false;
  return paidRows.some(({ r }) => {
    const pct  = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const done = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
    return decideDone ? (done || (!isNaN(pct) && pct>=100)) : (!done && (isNaN(pct) || pct<100));
  });
}
function paidFamilyDone(records, info, tokens){
  return paidFamilyAny(records, info, tokens, /*decideDone=*/true);
}
function paidFamilyUnfinished(records, info, tokens){
  return paidFamilyAny(records, info, tokens, /*decideDone=*/false);
}

function decideForJob(job, records){
  if (!Array.isArray(records) || records.length === 0){
    return { bucket:null, reason:"no records for job", trade:null, extra:null };
  }

  // =========================
  // CONFIG
  // =========================
  const READY_INVOICE_MODE = "either"; // "strict" | "percent100" | "either"
  const REQUIRE_INVOICE_PHRASE_FOR_BUCKET = false; // see containsInvoiceSignal()
  const ALLOW_MULTI_BUCKETS = true; // << allow showing the job twice (trade + invoice)

  // =========================
  // HELPERS
  // =========================
  function combinedStatus(r){
    const parts = [];
    if (info.phaseIdx>=0) parts.push(safeCell(r[info.phaseIdx]));
    if (info.titleIdx>=0) parts.push(safeCell(r[info.titleIdx]));
    if (info.allNotesIdx>=0) parts.push(safeCell(r[info.allNotesIdx]));
    return parts.filter(Boolean).join(" | ");
  }
  function titleMatchesAny(pats, title){
    const t = String(title || "");
    return (pats||[]).some(rx => rx.test(t));
  }
  function jobReadyForInvoice(recs, meta){
    let hasJCICompleted = false;
    let hasJCIpct100 = false;
    for (const { r } of recs){
      const title = meta.titleIdx>=0 ? safeCell(r[meta.titleIdx]).toLowerCase() : "";
      const done  = meta.completedIdx>=0 ? isTruthy(r[meta.completedIdx]) : false;
      const pct   = meta.percentCompleteIdx>=0 ? Number(r[meta.percentCompleteIdx]) : NaN;
      if (title.includes("job complete/inspected")){
        if (done === true) hasJCICompleted = true;
        if (!isNaN(pct) && pct >= 100) hasJCIpct100 = true;
      }
    }
    if (READY_INVOICE_MODE === "strict")     return hasJCICompleted;
    if (READY_INVOICE_MODE === "percent100") return hasJCIpct100;
    return hasJCICompleted || hasJCIpct100; // "either"
  }
  function containsInvoiceSignal(recs, meta){
    if (typeof meta.containsInvoiceIdx === "number" && meta.containsInvoiceIdx >= 0){
      let sawTrue = false, sawAnyExplicit = false;
      for (const { r } of recs){
        const v = r[meta.containsInvoiceIdx];
        if (String(v).trim() !== "") sawAnyExplicit = true;
        if (isTruthy(v)) sawTrue = true;
      }
      if (sawTrue) return true;
      if (sawAnyExplicit) return false; // explicit column exists and is all false/blank ⇒ treat as false
      // fall through to text-scan if column exists but blank everywhere
    }
    return recs.some(({r})=>{
      const s = [
        info.phaseIdx>=0 ? safeCell(r[info.phaseIdx]) : "",
        info.titleIdx>=0 ? safeCell(r[info.titleIdx]) : "",
        info.allNotesIdx>=0 ? safeCell(r[info.allNotesIdx]) : ""
      ].filter(Boolean).join(" | ").toLowerCase();
      return s.includes("invoice") || s.includes("invoiced");
    });
  }

  // Trade completion patterns
  const TRADE_COMPLETE_TITLE_PATTERNS = {
    "Siding":        [/^siding complete\b/i],
    "Screen Porch":  [/^screen porch complete\b/i, /^porch complete\b/i],
    "Porch":         [/^porch complete\b/i],
    "Rails":         [/^rails complete\b/i],
    "House Wrap":    [/^house wrap complete\b/i],
    "_global":       [/^job complete\/inspected\b/i, /^100%\s*job\s*complete\b/i],
  };
  // Allow global finisher to count for Siding (your earlier requirement)
  const GLOBAL_FINISH_OK_FOR = new Set(["Siding"]);

  function tradeIsFinished(trade, recs, meta){
    const base = TRADE_COMPLETE_TITLE_PATTERNS[trade] || [];
    const pats = GLOBAL_FINISH_OK_FOR.has(trade)
      ? base.concat(TRADE_COMPLETE_TITLE_PATTERNS._global || [])
      : base;
    let soft = false;
    for (const { r } of recs){
      const title = meta.titleIdx>=0 ? safeCell(r[meta.titleIdx]) : "";
      const done  = meta.completedIdx>=0 ? isTruthy(r[meta.completedIdx]) : false;
      const pct   = meta.percentCompleteIdx>=0 ? Number(r[meta.percentCompleteIdx]) : NaN;
      if (titleMatchesAny(pats, title)){
        if (done === true) return true;              // strict finisher
        if (!isNaN(pct) && pct >= 100) soft = true;  // soft finisher
      }
    }
    return soft;
  }
  function tradePaidTruthiness(trade, recs, meta){
    const paidIdx = meta.paidByTrade[trade] ?? -1;
    if (paidIdx < 0) return null; // no explicit column
    let sawTrue = false, sawFalse = false;
    for (const { r } of recs){
      const v = r[paidIdx];
      if (isTruthy(v)) sawTrue = true;
      else if (isFalse(v)) sawFalse = true;
    }
    if (sawTrue)  return true;   // prefer TRUE if mixed
    if (sawFalse) return false;
    return null;
  }
  // ===== RENDERING PIPELINE (drop-in) =====

// Buckets map → { "Siding To Pay": [cards...], "Jobs To Invoice": [cards...], ... }
function createEmptyBuckets(){
  return {
    "Siding To Pay": [],
    "Screen Porch To Pay": [],
    "Porch To Pay": [],
    "Rails To Pay": [],
    "House Wrap To Pay": [],
    "Jobs To Invoice": [],
    "Jobs To Close": [],
    "Liens Needed": []
  };
}

// Convert the raw job info + reason into a card payload for your UI
function buildCard(jobName, resultObj, recordsForJob){
  return {
    job: jobName,
    reason: resultObj.reason || "",
    trade: resultObj.trade || null,
    extra: resultObj.extra || null,
    // keep whatever else your UI needs here:
    records: recordsForJob
  };
}

// Safely add a card to a bucket if bucket name is valid
function addToBucket(buckets, bucketName, card){
  if (!bucketName || !buckets.hasOwnProperty(bucketName)) return;
  buckets[bucketName].push(card);
}

// Given a map jobName -> [records], classify & fill buckets (handles duplicates!)
function classifyAllJobs(recordsByJob){
  const buckets = createEmptyBuckets();

  for (const [jobName, jobRecords] of Object.entries(recordsByJob)){
    // 1) classify primary
    const result = decideForJob(jobName, jobRecords);

    // If nothing actionable, skip (or collect for a "Hidden / None" view if you have one)
    if (!result || !result.bucket){
      // Example: addToBucket(buckets, "(none)", buildCard(jobName, result, jobRecords));
      continue;
    }

    // 2) primary card
    const primaryCard = buildCard(jobName, result, jobRecords);
    addToBucket(buckets, result.bucket, primaryCard);

    // 3) duplicates (SECOND cards like "Jobs To Invoice" for the same job)
    if (Array.isArray(result.duplicates) && result.duplicates.length){
      for (const dup of result.duplicates){
        if (!dup || !dup.bucket) continue;
        const dupCard = buildCard(jobName, dup, jobRecords);
        addToBucket(buckets, dup.bucket, dupCard);
      }
    }
  }

  return buckets;
}

// Example renderer: call this after you’ve loaded and grouped your rows by job.
function renderBucketsToUI(recordsByJob){
  const buckets = classifyAllJobs(recordsByJob);

  // Clear and render each bucket section. Replace with your DOM logic.
  renderBucketSection("Siding To Pay", buckets["Siding To Pay"]);
  renderBucketSection("Screen Porch To Pay", buckets["Screen Porch To Pay"]);
  renderBucketSection("Porch To Pay", buckets["Porch To Pay"]);
  renderBucketSection("Rails To Pay", buckets["Rails To Pay"]);
  renderBucketSection("House Wrap To Pay", buckets["House Wrap To Pay"]);
  renderBucketSection("Jobs To Invoice", buckets["Jobs To Invoice"]);
  renderBucketSection("Jobs To Close", buckets["Jobs To Close"]);
  renderBucketSection("Liens Needed", buckets["Liens Needed"]);
}

// Stub: replace with your actual DOM building code
function renderBucketSection(bucketName, cards){
  const container = document.querySelector(`[data-bucket="${bucketName}"]`);
  if (!container) return;
  container.innerHTML = ""; // clear

  for (const card of cards){
    const div = document.createElement("div");
    div.className = "job-card";
    div.innerHTML = `
      <div class="job-title"><strong>${escapeHtml(card.job)}</strong></div>
      <div class="job-reason">${escapeHtml(card.reason)}</div>
      ${card.trade ? `<div class="job-trade">Trade: ${escapeHtml(card.trade)}</div>` : ""}
    `;
    container.appendChild(div);
  }
}

// Simple HTML escaper
function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

  function anyUnpaidFinishedTrade(recs, meta){
    for (const trade of TRADES){
      if (IGNORED_TRADES.has(String(trade).toLowerCase())) continue;
      if (!tradeIsFinished(trade, recs, meta)) continue;
      const paidTruth = tradePaidTruthiness(trade, recs, meta);
      if (paidTruth === false) return true;
      if (paidTruth === null){
        const tokens = tokensFor(trade);
        if (titleIndicatesTradeToPay(trade, recs, meta, tokens)) return true;
      }
    }
    return false;
  }

  // =========================
  // FLAGS
  // =========================
  const readyForInvoiceGate = jobReadyForInvoice(records, info);
  const finalDone           = hasFinalCompleteDone(records, info); // strict (“100% Job Complete” Completed=TRUE)
  const pendingFinal        = hasFinalCompletePresentButNotDone(records, info);

  const invoicedRows    = records.filter(({r}) => combinedStatus(r).toLowerCase().includes("invoiced"));
  const invoicedPresent = invoicedRows.length > 0;
  const invoicedDone    = invoicedRows.some(({r}) => {
    const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const completedTruth = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
    return completedTruth || (!isNaN(pct) && pct >= 100);
  });

  // Conservative "all zero" guard
  {
    const allZero = jobShouldBeHiddenForZeroPercents(records, info);
    if (allZero){
      const hasInvoicePhrase = records.some(({r}) => anyContains(combinedStatus(r), PHRASES_INVOICE));
      const hasTradeActivity = TRADES.some(pretty => {
        if (IGNORED_TRADES.has(String(pretty).toLowerCase())) return false;
        const tokens = tokensFor(pretty);
        return titleIndicatesTradeToPay(pretty, records, info, tokens) ||
               paidFamilyUnfinished(records, info, tokens) ||
               paidFamilyDone(records, info, tokens);
      });
      if (!hasInvoicePhrase && !hasTradeActivity){
        return { bucket:null, reason:"All PercentComplete entries are 0 and no invoice/trade activity → suppress", trade:null, extra:null };
      }
    }
  }

  // =========================
  // PRIORITY 1: TRADES — detect primary trade bucket
  // =========================
  let primaryTradeHit = null;
  for (const trade of TRADES){
    if (IGNORED_TRADES.has(String(trade).toLowerCase())) continue;
    if (!tradeIsFinished(trade, records, info)) continue;

    const paidTruth = tradePaidTruthiness(trade, records, info);
    if (paidTruth === true) continue; // already paid
    if (paidTruth === false){
      if (String(trade).toLowerCase()==="porch" && typeof HIDE_PORCH_TO_PAY!=="undefined" && HIDE_PORCH_TO_PAY){
        // Suppress porch if asked; keep scanning for other trades (but don’t set primary)
      } else {
        primaryTradeHit = { bucket:`${trade} To Pay`, reason:`Paid ${trade} = FALSE (finished)`, trade, extra:null };
        break;
      }
    } else {
      // No explicit paid column; allow title-based
      const tokens = tokensFor(trade);
      if (titleIndicatesTradeToPay(trade, records, info, tokens)){
        if (String(trade).toLowerCase()==="porch" && typeof HIDE_PORCH_TO_PAY!=="undefined" && HIDE_PORCH_TO_PAY){
          // suppressed
        } else {
          primaryTradeHit = { bucket:`${trade} To Pay`, reason:`${trade} payment needed (title/implicit, finished)`, trade, extra:null };
          break;
        }
      }
    }
  }

  // =========================
  // INVOICE decision (independent so we can show both)
  // =========================
  // Invoice should appear when:
  //  - readyForInvoiceGate === true (JCI completed or 100%)
  //  - AND there are no *other unpaid trades* blocking invoicing
  //  - AND invoice is not completed yet (either present-but-not-done OR not present/explicit FALSE)
let invoiceNeeded = false;
let invoiceReason = null;

// Recompute or reuse invoicedPresent/invoicedDone above if already computed
const invoiceSignal = containsInvoiceSignal(records, info);
const invoicedNotDone = invoicedPresent && !invoicedDone;

const invoiceSecondaryPossible =
  readyForInvoiceGate &&
  (
    (invoicedNotDone) ||
    (!invoicedPresent && !REQUIRE_INVOICE_PHRASE_FOR_BUCKET) ||
    (typeof info.containsInvoiceIdx==="number" && info.containsInvoiceIdx>=0 && invoiceSignal===false)
  );

// NOTE: For multi-bucket, we *do not* block invoice by "anyUnpaidFinishedTrade" when a trade is already primary.
//       That lets the same job appear twice: <Trade> To Pay  AND  Jobs To Invoice.
if (invoiceSecondaryPossible){
  invoiceNeeded = true;
  if (invoicedNotDone){
    invoiceReason = '"Invoiced" present but not completed';
  } else if (!invoicedPresent && !REQUIRE_INVOICE_PHRASE_FOR_BUCKET){
    invoiceReason = 'Ready; invoice not started';
  } else {
    invoiceReason = 'Ready; Contains Invoice = FALSE';
  }

  }

  // SPECIAL SUPPRESS: if invoice is DONE but final is NOT done, hide (neither invoice nor close)
  if (invoicedPresent && invoicedDone && !finalDone){
    // BUT if there is a trade hit, we still want to show trade (because program’s goal is who to pay)
    if (primaryTradeHit){
      return primaryTradeHit;
    }
    return { bucket:null, reason:"Invoice completed but 100% Job Complete is not done → suppress until final", trade:null, extra:null };
  }
// Allow invoice duplicate even when final is present but not done.
// -------------------------
if (pendingFinal){
  // SPECIAL SUPPRESS: If invoice is DONE but final is NOT done, hide (unless we have a trade).
  if (invoicedPresent && invoicedDone && !finalDone){
    if (primaryTradeHit) return primaryTradeHit; // still show who to pay
    return { bucket:null, reason:"Invoice completed but 100% Job Complete is not done → suppress until final", trade:null, extra:null };
  }

  // If we have a trade AND an invoice-needed duplicate, return both
  if (primaryTradeHit && invoiceNeeded && ALLOW_MULTI_BUCKETS){
    return { ...primaryTradeHit, duplicates:[{ bucket:"Jobs To Invoice", reason:`${invoiceReason}; final pending`, trade:null, extra:null }] };
  }

  // If only invoice is needed (no trade), show invoice even with pending final
  if (!primaryTradeHit && invoiceNeeded){
    return { bucket:"Jobs To Invoice", reason:`${invoiceReason}; final pending`, trade:null, extra:null };
  }

  // Otherwise suppress unless lien present
  const anyLien = records.some(({r}) => anyContains(combinedStatus(r), PHRASES_LIEN));
  if (anyLien){
    return { bucket:"Liens Needed", reason:"lien phrase found (final pending)", trade:null, extra:null };
  }
  return { bucket:null, reason:"Final present but not done → suppress (job not done)", trade:null, extra:null };
}


  // Now decide with multi-bucket behavior
// If both apply and multi-bucket is enabled
if (primaryTradeHit && invoiceNeeded && ALLOW_MULTI_BUCKETS){
  return { ...primaryTradeHit, duplicates:[{ bucket:"Jobs To Invoice", reason:invoiceReason, trade:null, extra:null }] };
}

if (primaryTradeHit) return primaryTradeHit;
if (invoiceNeeded)  return { bucket:"Jobs To Invoice", reason:invoiceReason, trade:null, extra:null };

// Close (final done AND invoice done)
if (finalDone && invoicedDone){
  return { bucket:"Jobs To Close", reason:"Final completion row done and invoice completed; all trades paid", trade:null, extra:null };
}

// Liens
if (records.some(({r}) => anyContains(combinedStatus(r), PHRASES_LIEN))){
  return { bucket:"Liens Needed", reason:"lien phrase found", trade:null, extra:null };
}

return { bucket:null, reason:"no rules matched", trade:null, extra:null };
}

  // assign jobs
const assignment = new Map();
for (const [job, records] of jobGroups.entries()){
  const pick = classifyJob(job, records, info);
  assignment.set(job, pick);
}

// build columns from assignment
const columns = [];

// Per-trade "To Pay" columns — allow multi-bucket by using .includes(...)
for (const trade of TRADES){
  // NEW: skip ignored trades (e.g., Porch)
  if (IGNORED_TRADES.has(String(trade).toLowerCase())) continue;

  const items = [];
  for (const [job, decision] of assignment.entries()){
    const b = decision.bucket || "";
    if (b.includes(`${trade} To Pay`)) items.push(job);
  }
  if (items.length) items.sort((a,b)=>a.localeCompare(b, undefined, {numeric:true,sensitivity:'base'}));
  columns.push({ header:`${trade} To Pay`, items });
}


// Helper to get ALL bucket labels for a job (primary + duplicates)
function allBucketsForDecision(decision){
  const arr = [];
  if (decision.bucket) arr.push(decision.bucket);
  if (Array.isArray(decision.duplicates)){
    for (const dup of decision.duplicates){
      if (dup && dup.bucket) arr.push(dup.bucket);
    }
  }
  return arr;
}

// Per-trade "To Pay" columns — now consider duplicates too
for (const trade of TRADES){
  if (IGNORED_TRADES.has(String(trade).toLowerCase())) continue;

  const items = [];
  for (const [job, decision] of assignment.entries()){
    const allB = allBucketsForDecision(decision);
    if (allB.some(b => String(b||"").includes(`${trade} To Pay`))){
      items.push(job);
    }
  }
  if (items.length) items.sort((a,b)=>a.localeCompare(b, undefined, {numeric:true,sensitivity:'base'}));
  columns.push({ header:`${trade} To Pay`, items });
}

// Global buckets — include duplicates as well
const invoice = [], close = [], lien = [];
for (const [job, decision] of assignment.entries()){
  const allB = allBucketsForDecision(decision);
  if (allB.some(b => String(b||"").includes("Jobs To Invoice"))) invoice.push(job);
  if (allB.some(b => String(b||"").includes("Jobs To Close")))   close.push(job);
  if (allB.some(b => String(b||"").includes("Liens Needed")))    lien.push(job);
}

invoice.sort((a,b)=>a.localeCompare(b, undefined, {numeric:true,sensitivity:'base'}));
close.sort((a,b)=>a.localeCompare(b, undefined, {numeric:true,sensitivity:'base'}));
lien.sort((a,b)=>a.localeCompare(b, undefined, {numeric:true,sensitivity:'base'}));
columns.push({ header:"Jobs To Invoice", items: invoice });
columns.push({ header:"Jobs To Close",   items: close });
columns.push({ header:"Liens Needed",    items: lien });

renderColumns(columns);


    const aoaOut = buildAOA(columns);
    $download.onclick = () => downloadAOA(aoaOut);
    $download.disabled = false;

    state = { sheetName, rows, info, jobGroups, assignment, combinedStatus };

    const counts = columns.map(c=>`${c.header}=${c.items.length}`).join(" • ");
    log(`Computation complete. ${counts}`, "ok");
  }catch(e){ log(e?.message||String(e), "err"); }
});

/* ----------------- Explain panel ----------- */
$inspectBtn.addEventListener('click', ()=>{
  if (!state){ $inspectOut.textContent = "Run Compute first."; return; }
  const targets = $inspectInput.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if (!targets.length){ $inspectOut.textContent = "Paste one job per line."; return; }

  const { jobGroups, assignment, info } = state;

  const lines = [];
  lines.push("Explain (priority = Trades → Invoice → Close → Lien)");
  lines.push("");
  lines.push("Legend: ✅ done • 🟡 present, not done • ⛔ unpaid • 📄 invoiced row");
  lines.push("");

  function rowMini(r){
    const title = info.titleIdx>=0 ? safeCell(r[info.titleIdx]) : "";
    const phase = info.phaseIdx>=0 ? safeCell(r[info.phaseIdx]) : "";
    const pct   = info.percentCompleteIdx>=0 ? safeCell(r[info.percentCompleteIdx]) : "";
    const done  = info.completedIdx>=0 ? safeCell(r[info.completedIdx]) : "";
    return `"${title}" — ${phase} — %=${pct||0} — Completed=${done||""}`;
  }

  for (const job of targets){
    const recs = jobGroups.get(job);
    if (!recs){
      lines.push(`• ${job} — NOT FOUND`);
      lines.push("");
      continue;
    }
    const pick = assignment.get(job) || { bucket:null, reason:"(none)" };
    lines.push(`• ${job}`);
    lines.push(`  Bucket: ${pick.bucket || "(none)"}  |  Reason: ${pick.reason}`);

    // Summarize special rows
    const invoicedRows = recs.filter(({r}) => String(safeCell(r[info.titleIdx])).toLowerCase().includes("invoiced"));
    if (invoicedRows.length){
      const flag = invoicedRows.some(({r})=>{
        const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
        const done = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
        return done || (!isNaN(pct) && pct>=100);
      }) ? "✅" : "🟡";
      lines.push(`  ${flag} 📄 Invoiced row present (${invoicedRows.length})`);
    }

    // Show any "Paid <Trade>" and "<Trade> Complete" hints in one compact block
    const tradeHints = [];
    for (const t of TRADES){
      const token = buildTradeTitlePattern(t);
      const paidRx = new RegExp(`\\bpaid\\b[^a-z0-9]*${token}`, 'i');
      const paidAny = recs.some(({r}) => paidRx.test(safeCell(r[info.titleIdx])));
      if (paidAny){
        const paidDone = recs.some(({r})=>{
          const title = safeCell(r[info.titleIdx]); if (!paidRx.test(title)) return false;
          const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
          const done = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
          return done || (!isNaN(pct) && pct>=100);
        });
        tradeHints.push(`${paidDone?"✅":"🟡"} Paid ${t}`);
      }
      const complete = hasTradeCompleteSignal(t, recs, info); // your helper
      if (complete) tradeHints.push(`✅ ${t} Complete`);
    }
    if (tradeHints.length) lines.push(`  Trades: ${tradeHints.join(" • ")}`);

    // Print 5 most-relevant rows (short)
    const shortlist = recs.slice(0, 5).map(({r}) => `  - ${rowMini(r)}`);
    if (shortlist.length) {
      lines.push("  Key rows:");
      lines.push(...shortlist);
    }
    lines.push("");
  }

  $inspectOut.textContent = lines.join("\n");
});

// --- NEW helpers (place near your other helpers) ---
// --- FINAL ROW DETECTORS (replace the old three helpers entirely) ---
function isFinalCompleteRow(title){
  const t = String(title || "").toLowerCase();
  // recognize both variants as "final"
  return t.includes("100% job complete") ||
         t.includes("100% complete") ||
         t.includes("job complete/inspected") ||
         t.includes("job complete / inspected");
}

function hasFinalCompleteDone(records, info){
  // true only if a final row exists AND it's actually complete
  return Array.isArray(records) && records.some(({ r }) => {
    const title = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]) : "";
    if (!isFinalCompleteRow(title)) return false;
    const pct   = info.percentCompleteIdx >= 0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const done  = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
    return done === true || (!Number.isNaN(pct) && pct >= 100);
  });
}

function hasFinalCompletePresentButNotDone(records, info){
  // a final row exists but it's not actually complete
  return Array.isArray(records) && records.some(({ r }) => {
    const title = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]) : "";
    if (!isFinalCompleteRow(title)) return false;
    const pct  = info.percentCompleteIdx >= 0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const done = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
    return !(done === true || (!Number.isNaN(pct) && pct >= 100));
  });
}


/* ----------------- header detection -------- */
function chooseHeaderRowWithFallback(aoa, scanRows=10){
  const max = Math.min(scanRows, aoa.length);
  const scored = [];
  vlog("Header-row scoring (first up to 10 rows):");
  for (let r=0; r<max; r++){
    const row = aoa[r] || [];
    const s = scoreRowAsHeader(row);
    const metrics = bannerMetrics(row);
    vlog(`  row ${r+1}: score=${s.toFixed(3)} • repeatRatio=${metrics.repeatRatio.toFixed(3)} • avgLen=${metrics.avgLen.toFixed(1)}`);
    scored.push({row:r, score:s, metrics});
  }
  scored.sort((a,b)=>b.score-a.score);
  let best = scored[0] || {row:0, score:0};
  let reason = `best score=${best.score.toFixed(3)}`;
  if (best.row === 0 && looksLikeBannerMetrics(best.metrics)) {
    const alt = scored.find(s => s.row === 1) || {row:1, score:scoreRowAsHeader(aoa[1]||[]), metrics:bannerMetrics(aoa[1]||[])}; 
    const delta = best.score - alt.score;
    if (alt.score > 0 || delta < 0.15) {
      best = alt; reason = "row 1 looked like a banner → using row 2";
    }
  }
  log(`Auto-picked header row: #${best.row+1} (${reason})`, "ok");
  return { index: best.row, reason };
}
// Keep only ONE definition of this function in the file:
function titleMatchesAny(rxList, title){
  const t = safeCell(title);
  const list = safeArray(rxList);
  return list.some(rx => rx && typeof rx.test === "function" && rx.test(t));
}
function scoreRowAsHeader(row){
  const vals = (row||[]).map(safeCell);
  const nonEmpty = vals.filter(t => t.trim()!=="");
  if (!nonEmpty.length) return -1;

  const normalized = nonEmpty.map(norm);
  const uniq = new Set(normalized).size;
  const uniqScore = uniq / Math.max(1, nonEmpty.length);

  // Header "hints" typical of your sheet
  const headerHints = [
    "job","title","phase","completed","percent","percentcomplete",
    "allnotes","notes","paid","to", "topay","invoice","invoiced"
  ];
  let hintHits = 0;
  for (const n of normalized){
    if (n.length <= 30 && headerHints.some(h => n.includes(h))) hintHits++;
  }
  const hintScore = hintHits / Math.max(1, nonEmpty.length);

  const m = bannerMetrics(row);
  const bannerPenalty = looksLikeBannerMetrics(m) ? (m.repeatRatio - 0.6) * 2.0 : 0;
  const lengthPenalty = m.avgLen > 35 ? (m.avgLen - 35) / 50 : 0;

  return (0.55 * hintScore + 0.45 * uniqScore) - (bannerPenalty + lengthPenalty);
}


function bannerMetrics(row){
  const vals = (row||[]).map(safeCell).filter(t=>t.trim()!=="");
  if (!vals.length) return { repeatRatio:0, avgLen:0 };
  const normalized = vals.map(norm);
  const counts = new Map(); let maxC = 0;
  for (const n of normalized){ counts.set(n, (counts.get(n)||0)+1); maxC = Math.max(maxC, counts.get(n)); }
  const repeatRatio = maxC / normalized.length;
  const avgLen = vals.reduce((a,t)=>a+t.length,0)/vals.length;
  return { repeatRatio, avgLen };
}

function looksLikeBannerMetrics(m){ return (m.repeatRatio >= 0.7 && m.avgLen >= 20) || m.avgLen >= 45; }

/* ----------------- column detection -------- */
function detectColumnsFrom(headerRow){
  const first = headerRow || [];
  const keyIdx = findHeader(first, ["job","title","address","lot","project","name"]);
  const titleIdx = findHeader(first, ["title"], true);
  const phaseIdx = findHeader(first, ["phase"], true);
  const allNotesIdx = findHeader(first, ["all notes","notes","internal notes","sub/vendor notes","client notes"], true);
  const completedIdx = findHeader(first, ["completed"], true);
  const percentCompleteIdx = findHeader(first, ["percent complete","percentcomplete"], true);
  const paidByTrade = {}; const toPayByTrade = {};
  for (const t of TRADES) {
    const tNorm = norm(t);
    const paid = findHeader(first, [`paid${tNorm}`, `paid ${tNorm}`, `${tNorm} paid`], true);
    const toPay = findHeader(first, [`${tNorm} to pay`, `${tNorm}topay`, `${tNorm} pay`, `${tNorm} payable`], true);
    if (paid >= 0) paidByTrade[t] = paid;
    if (toPay >= 0) toPayByTrade[t] = toPay;
  }
  return { keyIdx: keyIdx>=0 ? keyIdx : 0, titleIdx, phaseIdx, allNotesIdx, completedIdx, percentCompleteIdx, paidByTrade, toPayByTrade };
}

function findHeader(firstRow, candidates, optional=false){
  const normRow = firstRow.map(v => norm(v));
  for (const c of candidates) {
    const t = norm(c);
    let idx = normRow.indexOf(t); if (idx !== -1) return idx;
    idx = normRow.findIndex(h => h.includes(t)); if (idx !== -1) return idx;
    const parts = t.split(/[^a-z0-9]+/g).filter(Boolean);
    if (parts.length > 1) { idx = normRow.findIndex(h => parts.every(p=>h.includes(p))); if (idx !== -1) return idx; }
  }
  return optional ? -1 : -1;
}

/* ----------------- UI helpers -------------- */
function renderColumns(columns){
  $grid.innerHTML = "";
  for (const col of columns){
    const div = document.createElement('div'); div.className = 'col';
    const hdr = document.createElement('div'); hdr.className = 'hdr';
    const left = document.createElement('div'); left.textContent = col.header;
    const right = document.createElement('div'); right.className='muted'; right.textContent = col.items.length;
    hdr.appendChild(left); hdr.appendChild(right);
    const list = document.createElement('div'); list.className='list';
    if (!col.items.length){
      const span=document.createElement('div'); span.className='muted'; span.textContent='(none)'; list.appendChild(span);
    } else {
      for (const item of col.items){ const d = document.createElement('div'); d.className='item'; d.textContent = item; list.appendChild(d); }
    }
    div.appendChild(hdr); div.appendChild(list); $grid.appendChild(div);
  }
}

function buildAOA(columns){
  const header1=[]; const header2=[];
  for (const c of columns){ header1.push(c.header); header2.push("Key"); }
  const maxLen = Math.max(0, ...columns.map(c=>c.items.length));
  const rows=[]; for (let r=0;r<maxLen;r++){ const line=[]; for (const c of columns){ line.push(c.items[r] || ""); } rows.push(line); }
  return [header1, header2, ...rows];
}

function downloadAOA(aoa){
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const colCount = aoa[0]?.length || 0;
  ws['!cols'] = Array.from({length: colCount}, ()=>({ wch: 26 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Who To Pay");
  XLSX.writeFile(wb, `Who To Pay ${dateStamp()}.xlsx`);
  log("Excel downloaded.", "ok");
}
