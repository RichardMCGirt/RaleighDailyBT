/* ----------------- logger ----------------- */
const $log = document.getElementById('log');
const $verbose = document.getElementById('verbose');
function log(msg, cls=""){ const d=document.createElement('div'); d.textContent=msg; if(cls)d.className=cls; $log.appendChild(d); $log.scrollTop=$log.scrollHeight; }
function vlog(msg, cls=""){ if($verbose.checked) log(msg, cls); }
function sep(){ vlog("—".repeat(72)); }

/* ----------------- helpers ---------------- */
function safeCell(v) {
  if (v == null) return "";
  // Handle booleans explicitly
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  // Otherwise convert everything to trimmed string
  return String(v).trim();
}function norm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,""); }
function isTruthy(v) {
  if (v == null) return false;

  // Handle boolean values directly
  if (typeof v === "boolean") return v === true;

  const t = String(v).trim().toLowerCase();
  if (t === "") return false;

  return [
    "true",
    "1",
    "yes",
    "y",
    "to pay",
    "pay",
    "x",
    "✓"
  ].includes(t);
}function isFalse(v){ const t=String(v).trim().toLowerCase(); return t==="false"||t==="0"||t==="no"; }
function dateStamp(){ const d=new Date(); const mm=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); const yyyy=String(d.getFullYear()); return `${mm}-${dd}-${yyyy}`; }
function colLetterFromIndex(i){ let n=i+1,s=""; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26);} return s; }
function dumpRow(label, row, n=30){ const cells=(row||[]).slice(0,n).map((v,i)=>`${colLetterFromIndex(i)}:${safeCell(v)}`); vlog(`${label}: ${cells.join(" | ")}`); }
function contains(hay, needle){
  const h = String(hay || "").toLowerCase();
  const n = String(needle || "").toLowerCase();
  return h.includes(n);
}
function numberish(v){
  // Treat empty / null as "no number"
  if (v === "" || v == null) return NaN;

  // Basic numeric conversion (matches how you use Number(...) elsewhere)
  const n = Number(v);
  return isNaN(n) ? NaN : n;
}
function invoicePresent(records, info) {
  if (info.titleIdx < 0) return false;

  return records.some(({ r }) => {
    const title = String(r[info.titleIdx] || "").toLowerCase();
    return title.includes("invoiced"); // matches "Invoiced"
  });
}
function hasInvoicedDone(records, info) {
  if (info.titleIdx < 0) return false;

  return records.some(({ r }) => {
    const title = String(r[info.titleIdx] || "").toLowerCase();
    const pct = info.percentCompleteIdx >= 0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const completed = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;

    // A row counts as "invoiced done" if the title mentions "invoice"/"invoiced"
    // AND either Completed=TRUE or PercentComplete >= 100
    return (
      (title.includes("invoice") || title.includes("invoiced")) &&
      (completed || (!Number.isNaN(pct) && pct >= 100))
    );
  });
}
function hasFinalDone(records, info) {
  if (info.titleIdx < 0) return false;

  return records.some(({ r }) => {
    const title = String(r[info.titleIdx] || "").toLowerCase();
    const pct = info.percentCompleteIdx >= 0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const completed = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;

    // A row counts as "final done" if the title includes 100% job complete or job complete/inspected
    // and is either marked Completed=TRUE or has PercentComplete >= 100
    return (
      (title.includes("100% job complete") || title.includes("job complete/inspected")) &&
      (completed || (!Number.isNaN(pct) && pct >= 100))
    );
  });
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
const $location = document.getElementById('locationSelect');

const IGNORED_TRADES = new Set(["housewrap", "porch"]); // never surface these trades in UI
const STRICT_COMPLETION_TRADES = new Set(["porch", "screen porch", "columns"]);

/* ----------------- state ------------------ */
// Support multiple files: store parsed AOA per file (we only need AOA, not the raw workbook)
let parsedSheets = [];   // [{name, aoa, headerIndex, headerReason}]
let state = null;

/* ----------------- config ----------------- */
const TRADES = [
  "Painters","Siding","Columns","Trellis","Porch","Screen Porch",
  "Decking","Waterproof","Louvered Wall","Gutters"
];
// ---- Trade detection helpers ----
const TRADE_GROUPS = {
  siding:       ["siding"],
  decking:      ["decking", "deck ", "waterproof deck", "composite deck", "trex"],
  rails:        ["rail", "rails"],
  paint:        ["paint", "painter", "painting"],
  housewrap:    ["house wrap","housewrap"],
  "screen porch": ["screen porch", "screened porch"],
  columns:      ["column", "columns"]           // 👈 NEW: singular + plural
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
// 🧩 Normalize job names consistently (spaces, casing)
function normalizeJobName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")   // collapse multiple spaces
    .replace(/([0-9])([A-Za-z])/g, "$1 $2") // insert space between numbers and letters
    .trim()
    .toLowerCase();
}

function hasAnyCloseOutSoft(records, info){
  return records.some(({ r }) => {
    const s = textOf(r, info);
    const looks100 = s.includes("100% job complete");
    const looksInspected = s.includes("job complete/inspected");
    if (!(looks100 || looksInspected)) return false;
    const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const done = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
    return done || (!isNaN(pct) && pct >= 100);
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
    const done = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
    return done === true;
  });
}

function findUnpaidTrade(records, info){
  const rows = records.map(({ r }) => ({ r, s: textOf(r, info) }));
  const closeOutDone = hasAnyCloseOutComplete(records, info);
  const closeOutSoft = hasAnyCloseOutSoft(records, info);

  for (const prettyLabel of TRADES) {
    const tradeKey = prettyLabel.toLowerCase();
    if (IGNORED_TRADES.has(tradeKey)) continue;
    const tokens = tokensFor(prettyLabel);
    const tradeComplete = hasTradeCompleteSignal(prettyLabel, records, info);
    const paidRows = rows.filter(x => x.s.includes("paid") && tokens.some(t => x.s.includes(t)));
    const anyPaidPending = paidRows.some(x => !rowIsCompleted(x.r, info));
    const anyPaidDone    = paidRows.some(x =>  rowIsCompleted(x.r, info));
    const requireTradeComplete = STRICT_COMPLETION_TRADES.has(tradeKey);

    if (
      anyPaidPending &&
      !anyPaidDone &&
      (requireTradeComplete ? tradeComplete : (tradeComplete || closeOutDone || closeOutSoft))
    ) {
      return {
        trade: tradeKey,
        bucket: `${prettyLabel} To Pay`,
        reason: `Title→${prettyLabel} (to pay), Paid-title present (unfinished)`
      };
    }

    if (tradeComplete && !anyPaidDone) {
      return {
        trade: tradeKey,
        bucket: `${prettyLabel} To Pay`,
        reason: `${prettyLabel} complete without payment`
      };
    }
  }
  return null;
}

const READY_INVOICE_MODE = "strict";
const REQUIRE_INVOICE_PHRASE_FOR_BUCKET = false;

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
const TRADE_COMPLETE_TITLE_PATTERNS = {
  "Siding": [/^siding complete\b/i, /^job complete\/inspected\b/i],
  "Screen Porch": [/^screen porch complete\b/i, /^porch complete\b/i],
  "Porch": [/^porch complete\b/i],
  "Rails": [/^rails complete\b/i],
  "House Wrap": [/^house wrap complete\b/i],
  "_global": [/^job complete\/inspected\b/i, /^100% job complete\b/i],
};
let TRADE_FINISH_STRICT = false;

const PHRASES_INVOICE = ["invoice","ready to invoice","ready to bill","pay crew","ready to pay","bill now","billing","send invoice","invoice ready","ready for invoice"];
const PHRASES_CLOSE = ["job complete/inspected","job complete","100% job complete","close out","closed"];
const PHRASES_LIEN  = ["lien","liens needed","lien needed"];

function jobReadyForInvoice(records, info){
  let hasJCICompleted = false;
  let hasJCIpct100 = false;
  for (const { r } of records){
const title = info.titleIdx >= 0 ? norm(safeCell(r[info.titleIdx])).trim().toLowerCase() : "";
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

function anyUnpaidFinishedTrade(records, info){
  for (const trade of TRADES){
    if (IGNORED_TRADES.has(String(trade).toLowerCase())) continue;
    if (!tradeIsFinished(trade, records, info)) continue;

    const paidTruth = tradePaidTruthiness(trade, records, info);
    if (paidTruth === false) return true;

    if (paidTruth === null){
      const tokens = tokensFor(trade);
      if (titleIndicatesTradeToPay(trade, records, info, tokens)) return true;
    }
  }
  return false;
}
function parseJobParts(str) {
  const s = String(str || "").trim();
  const m = s.match(/^(\d+)\s*(.*)$/);
  if (m) {
    return {
      house: parseInt(m[1], 10),
      street: m[2].trim().toLowerCase()
    };
  }
  return { house: NaN, street: s.toLowerCase() };
}

function compareJobsByStreet(a, b) {
  const pa = parseJobParts(a);
  const pb = parseJobParts(b);

  const cmpStreet = pa.street.localeCompare(pb.street, undefined, { sensitivity: "base" });
  if (cmpStreet !== 0) return cmpStreet;

  if (!isNaN(pa.house) && !isNaN(pb.house)) return pa.house - pb.house;

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}


function containsInvoiceSignal(records, info){
  if (typeof info.containsInvoiceIdx === "number" && info.containsInvoiceIdx >= 0){
    let sawTrue = false, sawAnyExplicit = false;
    for (const { r } of records){
      const v = r[info.containsInvoiceIdx];
      if (String(v).trim() !== "") sawAnyExplicit = true;
      if (isTruthy(v)) sawTrue = true;
    }
    if (sawTrue) return true;
    if (sawAnyExplicit) return false;
  }
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
function safeArray(a){ return Array.isArray(a) ? a : []; }


function tradePaidTruthiness(trade, records, info){
  const paidIdx = info.paidByTrade[trade] ?? -1;
  if (paidIdx < 0) return null;
  let sawTrue = false, sawFalse = false;
  for (const { r } of records){
    const v = r[paidIdx];
    if (isTruthy(v)) sawTrue = true;
    else if (isFalse(v)) sawFalse = true;
  }
  if (sawTrue)  return true;
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

function safeSome(arr, pred){
  return Array.isArray(arr) ? arr.some(pred) : false;
}

function decideForJob(job, records, info) {
  try {
    // Default decision object structure
    const result = {
      bucket: null,
      reason: "",
      trade: null,
      extra: null,
      duplicates: []
    };

    // Basic invoice flags
    const invoicePresentFlag = invoicePresent(records, info);
    const invoiceDone        = hasInvoicedDone(records, info);
    const invoiceOk          = invoicePresentFlag && invoiceDone;

    // Use global meta if not passed
    info = info || state?.info || window.info || {};

    // Flatten text for simple phrase searches (liens, invoice text)
    const txts = records.map(({ r }) =>
      [r[info.phaseIdx], r[info.titleIdx], r[info.allNotesIdx]]
        .filter(Boolean)
        .join(" | ")
        .toLowerCase()
    );

    // ----------------- FINAL FLAGS -----------------
    // finalForClose: ONLY "100% Job Complete" at 100% (this controls Jobs To Close)
    const finalForClose = records.some(({ r }) => {
      const title = info.titleIdx >= 0
        ? safeCell(r[info.titleIdx]).toLowerCase()
        : "";
      const pct = info.percentCompleteIdx >= 0
        ? numberish(r[info.percentCompleteIdx])
        : NaN;

      return (
        title.includes("100% job complete") &&
        !Number.isNaN(pct) &&
        pct >= 100
      );
    });

    // finalForInvoice: your broader "final done" (Job Complete/Inspected OR 100% Job Complete, 100% or Completed=TRUE)
    const finalForInvoice = hasFinalDone(records, info);

    // ----------------- TRADES TO PAY (highest priority) -----------------

    // Uses existing helper; returns { bucket, reason, trade } or null
    const unpaid = findUnpaidTrade(records, info);
    if (unpaid) {
      result.bucket = unpaid.bucket;   // e.g. "Screen Porch To Pay"
      result.reason = unpaid.reason;
      result.trade  = unpaid.trade;
    }

    // ----------------- CLOSE / INVOICE LOGIC -----------------

    // 1) Invoice done AND finalForClose
    //    - If there is a trade to pay → keep trade as primary, add Jobs To Close as duplicate
    //    - If no trade to pay        → Jobs To Close only
    if (invoiceOk && finalForClose) {
      if (result.bucket) {
        // Trade bucket exists (To Pay) → add Jobs To Close as duplicate
        result.duplicates.push({
          bucket: "Jobs To Close",
          reason: "Invoice and 100% Job Complete are 100% → ready to close",
          trade: null,
          extra: null
        });
        return result;
      }

      // No trades to pay, fully closed
      result.bucket = "Jobs To Close";
      result.reason = "Invoice and 100% Job Complete are 100% → ready to close";
      return result;
    }

    // 2) Invoice done BUT 100% Job Complete is NOT 100
    //    - Do NOT put it in Jobs To Close
    //    - If no trade bucket, suppress from UI (no bucket)
    //
    // This is the rule that will catch 61 Allston Park:
    //   - Invoice 100% (invoiceOk = true)
    //   - Job Complete/Inspected 100% BUT 100% Job Complete = 0% (finalForClose = false)
    //   - No trade bucket → it will return with bucket=null
    if (invoiceOk && !finalForClose && !result.bucket) {
      return {
        bucket: null,
        reason: "Invoice completed but 100% Job Complete is not 100% → hold from closing",
        trade: null,
        extra: null,
        duplicates: []
      };
    }

    // 3) Final done (for invoice) AND invoice present but NOT done (0% or partial)
    //    ⇒ Jobs To Invoice (either as primary or duplicate)
    if (finalForInvoice && invoicePresentFlag && !invoiceDone) {
      const invoiceBucket = {
        bucket: "Jobs To Invoice",
        reason: "Final completion done but invoice is still 0% or partial",
        trade: null,
        extra: null,
        duplicates: []
      };

      if (result.bucket) {
        result.duplicates.push(invoiceBucket);
        return result;
      }

      return invoiceBucket;
    }

    // 4) Final done (for invoice) AND no invoice row at all
    //    ⇒ Jobs To Invoice
    if (finalForInvoice && !invoicePresentFlag) {
      const invoiceBucket = {
        bucket: "Jobs To Invoice",
        reason: "Final completion done but invoice row is missing",
        trade: null,
        extra: null,
        duplicates: []
      };

      if (result.bucket) {
        result.duplicates.push(invoiceBucket);
        return result;
      }

      return invoiceBucket;
    }

    // ----------------- LIEN (last in priority stack) -----------------

    if (!result.bucket && txts.some(s => s.includes("lien"))) {
      return {
        bucket: "Liens Needed",
        reason: "Lien phrase found",
        trade: null,
        extra: null,
        duplicates: []
      };
    }

    // ----------------- FALLBACK INVOICE PHRASE DETECTION -----------------
    // If nothing above has classified it, but we see "invoice" text somewhere,
    // only treat it as Jobs To Invoice if SOMETHING is actually done (100% or Completed=TRUE).
    if (!result.bucket && txts.some(s => s.includes("invoice") || s.includes("invoiced"))) {
      const anyDone = jobHasAnyDoneRow(records, info);

      if (!anyDone) {
        // 🔒 Guard: do NOT show in Jobs To Invoice if nothing is 100% / done
        return {
          bucket: null,
          reason: "Invoice phrase present but no rows at 100% or marked complete → not ready to invoice",
          trade: null,
          extra: null,
          duplicates: []
        };
      }

      // ✅ At least one row is done → this is a real “Jobs To Invoice” candidate
      return {
        bucket: "Jobs To Invoice",
        reason: "Invoice phrase found",
        trade: null,
        extra: null,
        duplicates: []
      };
    }

    // ----------------- TRADES-ONLY CASE (no close/invoice conditions hit) -----------------

    if (result.bucket) {
      // We had a trade bucket and no other rules overrode it
      return result;
    }

    // ----------------- NOTHING MATCHED -----------------
    return {
      bucket: null,
      reason: "No matching rule",
      trade: null,
      extra: null,
      duplicates: []
    };
  } catch (e) {
    log(e?.message || String(e), "err");
    return {
      bucket: null,
      reason: `Error: ${e?.message || String(e)}`,
      trade: null,
      extra: null,
      duplicates: []
    };
  }
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

  const requireTradeComplete = STRICT_COMPLETION_TRADES.has(trade);

  if (anyPaidPending && !anyPaidDone) {
    if (requireTradeComplete) {
      if (tradeComplete) return true;
    } else {
      return true;
    }
  }
  vlog(`[ToPay <- PaidPending] ${trade} (strict=${requireTradeComplete})`);

  if (tradeComplete && !anyPaidDone){
    return true;
  }
  vlog(`[ToPay?] ${trade} :: paidPending=${anyPaidPending} paidDone=${anyPaidDone} tradeComplete=${tradeComplete} closeOutDone=${closeOutDone} closeOutSoft=${closeOutSoft} requireComplete=${requireTradeComplete}`);

  return false;
}
function normalizeJobName(str){
  return String(str)
    .replace(/\s+/g, ' ')         // collapse extra spaces
    .trim()
    .toLowerCase();               // normalize case
}
function paidTitlePresent(trade, records, info) {
  const t = String(trade || "").toLowerCase();
  return records.some(({ r }) => {
    const title = safeCell(r[info.titleIdx]).toLowerCase();
    const done  = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
    const pct   = info.percentCompleteIdx >= 0 ? Number(r[info.percentCompleteIdx]) : NaN;
    // must match "Paid <trade>" and actually be done (Completed=TRUE or %>=100)
    return title.includes("paid") && title.includes(t) &&
           (done === true || (!Number.isNaN(pct) && pct >= 100));
  });
}
  
// === NEW HIDE RULE ===
function jobShouldBeHiddenForZeroPercents(records, info){
  if (info.percentCompleteIdx < 0) return false;
  let sawNumeric = false;
  for (const {r} of records){
    const raw = r[info.percentCompleteIdx];
    if (raw === "" || raw == null) continue;
    const n = Number(raw);
    if (!isNaN(n)){
      sawNumeric = true;
      if (n > 0) return false;
    }
  }
  return sawNumeric;
}

/* ----------------- file handling ---------- */
$file.addEventListener('change', async ()=>{
  try{
    $log.textContent = "";
    parsedSheets = [];

    const files = Array.from($file.files || []);
    if (!files.length) return;

    log(`Reading ${files.length} workbook${files.length>1?"s":""}...`);
    let totalRows = 0;

    for (const f of files){
      try{
        const u8 = new Uint8Array(await f.arrayBuffer());
        const wb = XLSX.read(u8, { type:'array' });
        const sheetName = (wb.SheetNames||[]).find(n=>n.toLowerCase()==="schedules") || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const aoa = XLSX.utils.sheet_to_json(ws, { header:1, defval:"" });

        const pick = chooseHeaderRowWithFallback(aoa, 10);
        const headers = aoa[pick.index] || [];

        vlog(`File: ${f.name} | Sheet: ${sheetName}`, "ok");
        dumpRow(`Row 1 (peek ${f.name})`, aoa[0]||[], 17);

        parsedSheets.push({ name:f.name, aoa, sheetName, headerIndex: pick.index, headerReason: pick.reason });
        totalRows += Math.max(0, aoa.length - (pick.index + 1));
      }catch(inner){
        log(`Error reading ${f.name}: ${inner?.message||String(inner)}`, "err");
      }
    }

    $countBadge.textContent = `${totalRows} rows`;
    $summary.textContent = files.length ? `Ready. ${files.length} file(s) parsed. Click Compute.` : "No results yet.";
    log(`Parsed ${files.length} file(s). Total data rows across files: ${totalRows}`, "ok");
  }catch(e){ log(e?.message||String(e), "err"); }
});

/* ----------------- main ------------------- */
$run.addEventListener('click', () => {
  
  // reset verbose-limit for this run
  VLOG_COUNT = 0;

  try {
    if (!parsedSheets.length) {
      throw new Error("Please upload one or more workbooks first.");
    }
      // Use the first file's header row for column detection
    const primary = parsedSheets[0];
    const headerRow = primary.aoa[primary.headerIndex] || [];
    dumpRow(`Chosen header row ${primary.headerIndex + 1} (raw)`, headerRow, 30);
    dumpRow(`Chosen header row ${primary.headerIndex + 1} (normalized)`, headerRow.map(norm), 30);

    const info = detectColumnsFrom(headerRow);
    info.headerRowIndex = primary.headerIndex;
    info.headerReason = primary.headerReason;
window.info = info;

    const mapLines = [];
    mapLines.push(`Job (key) -> ${colLetterFromIndex(info.keyIdx)} (${info.keyIdx})`);
    if (info.phaseIdx >= 0) mapLines.push(`Phase -> ${colLetterFromIndex(info.phaseIdx)} (${info.phaseIdx}) [PRIMARY STATUS]`);
    if (info.titleIdx >= 0) mapLines.push(`Title -> ${colLetterFromIndex(info.titleIdx)} (${info.titleIdx})`);
    if (info.allNotesIdx >= 0) mapLines.push(`All Notes -> ${colLetterFromIndex(info.allNotesIdx)} (${info.allNotesIdx})`);
    if (info.completedIdx >= 0) mapLines.push(`Completed -> ${colLetterFromIndex(info.completedIdx)} (${info.completedIdx})`);
    if (info.percentCompleteIdx >= 0) mapLines.push(`PercentComplete -> ${colLetterFromIndex(info.percentCompleteIdx)} (${info.percentCompleteIdx})`);
    for (const t of TRADES) {
      const p = info.paidByTrade[t];
      const q = info.toPayByTrade[t];
      if (p >= 0) mapLines.push(`Paid ${t} -> ${colLetterFromIndex(p)} (${p})`);
      if (q >= 0) mapLines.push(`${t} To Pay -> ${colLetterFromIndex(q)} (${q})`);
    }
    sep();
    vlog("Column mappings (from first file):\n" + mapLines.join("\n"), "ok");
    sep();

    // Merge rows from ALL files (skip each file's header region)
    const allRows = [];
    for (const pf of parsedSheets) {
      const rows = pf.aoa.slice(pf.headerIndex + 1);
      allRows.push(...rows);
    }
    $countBadge.textContent = `${allRows.length} rows`;

    // Combined status helper (we keep this so Explain uses the same logic)
    const combinedStatus = (r) => {
      const parts = [];
      if (info.phaseIdx >= 0) parts.push(safeCell(r[info.phaseIdx]));
      if (info.titleIdx >= 0) parts.push(safeCell(r[info.titleIdx]));
      if (info.allNotesIdx >= 0) parts.push(safeCell(r[info.allNotesIdx]));
      return parts.filter(Boolean).join(" | ");
    };

   // Group rows by job (same as before)
    const jobGroups = new Map();
    window.jobGroups = jobGroups;

    const keyIdx = info.keyIdx;

    allRows.forEach((r, i) => {
      const rawJob = r[keyIdx];
      const prettyJob = String(rawJob || "").trim();
      if (!prettyJob) return;

      const jobKey = makeJobKey(rawJob);
      if (!jobKey) return;

      const list = jobGroups.get(jobKey) || [];
      list.push({
        r,
        rowNum: i + (info.headerRowIndex + 2),
        rawJob: prettyJob,
      });
      jobGroups.set(jobKey, list);
    });

    log(`Grouped into ${jobGroups.size} unique jobs.`, "ok");

    // === Async classification: handle jobs in chunks so browser doesn't freeze ===
    const entries = Array.from(jobGroups.entries());
    const totalJobs = entries.length;
const assignment = new Map();
window.assignment = assignment;

const close = [];
window.close = close; // lets you type `close` in console

let index = 0;
const BATCH_SIZE = 40;
const FRAME_BUDGET = 12;

    $summary.textContent = `Classifying ${totalJobs} jobs...`;
  function classifyBatch() {
      const start = performance.now();
      let processed = 0;

      while (
        index < totalJobs &&
        processed < BATCH_SIZE &&
        performance.now() - start < FRAME_BUDGET
      ) {
        const [jobKey, records] = entries[index++];
        const displayJobName = records[0]?.rawJob || "";
        const pick = classifyJob(displayJobName, records, info);
        assignment.set(jobKey, pick);
        if (pick.bucket === "Jobs To Close") close.push(displayJobName);

        processed++;
      }

      $summary.textContent = `Classifying jobs... ${index}/${totalJobs}`;

      if (index < totalJobs) {
        requestAnimationFrame(classifyBatch);
      } else {
        finishCompute(allRows, info, jobGroups, assignment, combinedStatus);
      }
    }

    // Start classification
    requestAnimationFrame(classifyBatch);

  } catch (e) {
    log(e?.message || String(e), "err");
  }
}); // 👈 closes addEventListener

// ---------------- CLASSIFY JOB ----------------
function classifyJob(job, records, info) {
  try {
    // Call the decision helper
    const result = decideForJob(job, records, info);

    // Ensure consistent structure
    if (!result || typeof result !== "object") {
      return { bucket: null, reason: "Invalid decision result", trade: null, duplicates: [] };
    }

    // Guarantee duplicates array
    if (!Array.isArray(result.duplicates)) result.duplicates = [];

    return result;
  } catch (err) {
    console.error("classifyJob error for", job, err);
    return { bucket: null, reason: `Error: ${err.message}`, trade: null, duplicates: [] };
  }
}

function finishCompute(allRows, info, jobGroups, assignment, combinedStatus) {
  const columns = [];
const jobsToClose = [];
window.jobsToClose = jobsToClose;   // 👈 expose globally for console access

  // ✅ Declare these FIRST so they can be safely used below
  const invoice = [];
  const close = [];
  const lien = [];

  function allBucketsForDecision(decision) {
    const arr = [];
    if (decision.bucket) arr.push(decision.bucket);
    if (Array.isArray(decision.duplicates)) {
      for (const dup of decision.duplicates) {
        if (dup && dup.bucket) arr.push(dup.bucket);
      }
    }
    return arr;
  }

  // 🧩 Per-trade buckets
  for (const trade of TRADES) {
    if (IGNORED_TRADES.has(String(trade).toLowerCase())) continue;
    const items = [];

    for (const [job, decision] of assignment.entries()) {
      const allB = allBucketsForDecision(decision);
      if (allB.some(b => String(b || "").includes(`${trade} To Pay`))) {
        items.push(job);
      }
    }

    if (items.length) items.sort(compareJobsByStreet);
    columns.push({ header: `${trade} To Pay`, items });
  }

  // 🧾 Global buckets
  for (const [job, decision] of assignment.entries()) {
    const allB = allBucketsForDecision(decision);
    if (allB.some(b => String(b || "").includes("Jobs To Invoice"))) invoice.push(job);
    if (allB.some(b => String(b || "").includes("Jobs To Close")))   close.push(job);
    if (allB.some(b => String(b || "").includes("Liens Needed")))    lien.push(job);
  }

  // ✅ Safe to sort now
  invoice.sort(compareJobsByStreet);
  close.sort(compareJobsByStreet);
  lien.sort(compareJobsByStreet);

  // ✅ Add to columns
  columns.push({ header: "Jobs To Invoice", items: invoice });
  columns.push({ header: "Jobs To Close",   items: close });
  columns.push({ header: "Liens Needed",    items: lien });
columns.push({ header:"Jobs To Close", items:close });  // ✅ Add this line

  // 🪟 Render everything
  renderColumns(columns);
  const aoaOut = buildAOA(columns);

  // 📥 Setup CSV download
  $download.onclick = () => {
    const location = document.getElementById("locationSelect")?.value || "Unknown";
    const date = new Date().toISOString().split("T")[0];
    const filename = `${location}_Jobs_${date}.csv`;
    downloadAOA(aoaOut, filename);
  };

  $download.disabled = false;
  state = { rows: allRows, info, jobGroups, assignment, combinedStatus };

  const counts = columns.map(c => `${c.header}=${c.items.length}`).join(" • ");
  log(`Computation complete. ${counts}`, "ok");
  $summary.textContent = "Done.";
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
        return hasJCICompleted || hasJCIpct100;
      }

      function containsInvoiceSignal(recs, meta){
        if (typeof meta.containsInvoiceIdx === "number" && meta.containsInvoiceIdx >= 0){
          let sawTrue = false, sawAnyExplicit = false;
          for (const { r } of recs){
            const v = meta.containsInvoiceIdx >= 0 ? r[meta.containsInvoiceIdx] : undefined;
            if (String(v).trim() !== "") sawAnyExplicit = true;
            if (isTruthy(v)) sawTrue = true;
          }
          if (sawTrue) return true;
          if (sawAnyExplicit) return false;
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

/* ----------------- Explain panel ----------- */
$inspectBtn.addEventListener('click', () => {
  if (!state) {
    $inspectOut.textContent = "Run Compute first.";
    return;
  }

  const targets = $inspectInput.value
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!targets.length) {
    $inspectOut.textContent = "Paste one job per line.";
    return;
  }

  const { jobGroups, assignment, info } = state;
  const lines = [];

lines.push("Explain (priority = Trades → Invoice → Close → Lien)");
lines.push("");
lines.push("Legend:");
lines.push("  ✅ % = 100 (done)");
lines.push("  🟡 0 < % < 100 (in progress)");
lines.push("  ❌ % = 0 or blank (not started)");
lines.push("  ⛔ unpaid (trade needing payment)");
lines.push("  📄 invoiced row");
lines.push("");


  // Helper to show a short version of each record, including raw/computed flags
function rowMini(r) {
  const rawTitle = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]) : "";
  const phase    = info.phaseIdx >= 0 ? safeCell(r[info.phaseIdx]) : "";
  const pctVal   = info.percentCompleteIdx >= 0 ? numberish(r[info.percentCompleteIdx]) : NaN;
  const pctStr   = Number.isNaN(pctVal) ? "-" : pctVal;
  const rawComp  = info.completedIdx >= 0 ? safeCell(r[info.completedIdx]) : "";

  // Icons purely from PercentComplete:
  // ✅ = 100 (done)
  // 🟡 = between 0 and 100 (in progress)
  // ❌ = 0 or blank (not started)
  let icon = "❌";
  if (!Number.isNaN(pctVal)) {
    if (pctVal >= 100) {
      icon = "✅";
    } else if (pctVal > 0) {
      icon = "🟡";
    }
  }

  const shownPhase = phase || "(no phase)";
  const shownComp  = rawComp === "" ? "blank" : rawComp;

  return `${icon} "${rawTitle}" — ${shownPhase} — %=${pctStr} — CompletedCell=${shownComp}`;
}


  for (const rawJob of targets) {
    const displayName = rawJob.trim();
    const jobKey = makeJobKey(displayName);   // normalize casing/spaces
    if (!jobKey) continue;

    const recs = jobGroups.get(jobKey);
    if (!recs) {
      lines.push(`• ${displayName} — NOT FOUND`);
      lines.push("");
      continue;
    }

    const pick = assignment.get(jobKey) || { bucket: null, reason: "(none)", duplicates: [] };
    const displaySafe = recs[0]?.rawJob || displayName;

    // Collect all buckets including duplicates
    const allB = allBucketsForDecision(pick);
    const bucketLabel = allB.length ? allB.join(", ") : "(none)";

    lines.push(`• ${displaySafe}`);
    lines.push(`  Bucket(s): ${bucketLabel}  |  Reason: ${pick.reason || "(none)"}`);

    // Show duplicate bucket reasons, if any
    if (Array.isArray(pick.duplicates) && pick.duplicates.length) {
      lines.push("  Additional buckets:");
      for (const dup of pick.duplicates) {
        const dupBucket = dup && dup.bucket ? dup.bucket : "(none)";
        const dupReason = dup && dup.reason ? dup.reason : "(none)";
        lines.push(`    • ${dupBucket} — ${dupReason}`);
      }
    }

    // ---- Status snapshot (what the classifier sees) ----
  const invStatus = invoiceStatus(recs, info);
const finalPending = hasFinalCompletePresentButNotDone(recs, info);
const finalDone = hasFinalCompleteDone(recs, info); // ✅ FIX
const tradesToPay = getTradesToPay(recs, info);
let anyLien = false;

    try {
      anyLien = recs.some(({ r }) => anyContains(combinedStatus(r), PHRASES_LIEN));
    } catch (e) {
      anyLien = false;
    }

  const invoiceStatusText = (() => {
  if (!invStatus.present) return "Invoice: ❌";
  if (invStatus.done) return "Invoice: ✅";
  return "Invoice: ❌"; // present but not 100% still red ❌
})();

    let finalLine = "";
    if (finalDone) {
      finalLine = "✅ final done";
    } else if (finalPending) {
      finalLine = "🟡 final present but not done";
    } else {
      finalLine = "❌ no final row";
    }

    const tradesLine = tradesToPay.length
      ? `⛔ trades needing payment: ${tradesToPay.join(", ")}`
      : "no trades needing payment";

    const lienLine = anyLien ? "Lien phrase detected (PHRASES_LIEN match)" : "no lien phrase detected";

lines.push("  Status snapshot:");
lines.push(`    • ${invoiceStatusText}`);
    lines.push(`    • Final (100% / inspected): ${finalLine}`);
    lines.push(`    • Trades: ${tradesLine}`);
    lines.push(`    • Liens: ${lienLine}`);

    // Debug aliases
    lines.push("  Debug Aliases:");
    for (const [alias, terms] of Object.entries(ALIAS_GROUPS)) {
      lines.push(`    ${alias} → ${terms.join(", ")}`);
    }

    // Invoiced row count
    const invoicedRows = recs.filter(({ r }) => {
      const val = info.titleIdx >= 0 ? String(r[info.titleIdx]).toLowerCase() : "";
      return val.includes("invoiced");
    });
    if (invoicedRows.length) {
      lines.push(`  📄 Invoiced rows: ${invoicedRows.length}`);
    }

    // Key rows
    lines.push("  Key rows:");
    for (const { r } of recs) {
      lines.push("  - " + rowMini(r));
    }

    lines.push(""); // blank line between jobs
  }

  $inspectOut.textContent = lines.join("\n");
});
// 🔧 Make allBucketsForDecision globally available for Explain panel
function allBucketsForDecision(decision) {
  if (!decision) return [];
  const arr = [];
  if (decision.bucket) arr.push(decision.bucket);
  if (Array.isArray(decision.duplicates)) {
    for (const dup of decision.duplicates) {
      if (dup && dup.bucket) arr.push(dup.bucket);
    }
  }
  return arr;
}

// --- FINAL ROW DETECTORS --- */
// --- FINAL ROW DETECTORS --- */
function isFinalCompleteRow(title) {
  const t = String(title || "").toLowerCase();
  return /100\s*%.*job\s*complete/.test(t) ||
         /job\s*complete\s*[/-]?\s*inspected/.test(t) ||
         /\bfinal\b/.test(t);
}

// ✅ FINAL DONE = any final-style row with PercentComplete = 100
function hasFinalCompleteDone(records, info) {
  if (!Array.isArray(records)) return false;

  return records.some(({ r }) => {
    const rawTitle = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]) : "";
    if (!isFinalCompleteRow(rawTitle)) return false;

    const pctVal = info.percentCompleteIdx >= 0
      ? numberish(r[info.percentCompleteIdx])
      : NaN;

    // Treat 100% as TRUE / done
    return !Number.isNaN(pctVal) && pctVal >= 100;
  });
}

// ✅ FINAL PRESENT BUT NOT DONE = we see a final row, but NONE are at 100%
function hasFinalCompletePresentButNotDone(records, info) {
  if (!Array.isArray(records)) return false;

  let anyFinal = false;
  let anyDone  = false;

  for (const { r } of records) {
    const rawTitle = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]) : "";
    if (!isFinalCompleteRow(rawTitle)) continue;

    anyFinal = true;

    const pctVal = info.percentCompleteIdx >= 0
      ? numberish(r[info.percentCompleteIdx])
      : NaN;

    if (!Number.isNaN(pctVal) && pctVal >= 100) {
      anyDone = true;
    }
  }

  // “pending final” only if we saw a final row, but none reached 100%
  return anyFinal && !anyDone;
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

  const headerHints = [
    "job","title","phase","completed","percent","percentcomplete",
    "allnotes","notes","paid","to","topay","invoice","invoiced"
  ];
  let hintHits = 0;
  for (const n of normalized){
    if (n.length <= 30 && headerHints.some(h => n.includes(h))) hintHits++;
  }
  const hintScore = hintHits / Math.max(1, nonEmpty.length);

  // ✅ use bannerMetrics / looksLikeBannerMetrics correctly
  const metrics = bannerMetrics(row);
  const bannerPenalty = looksLikeBannerMetrics(metrics)
    ? (metrics.repeatRatio - 0.6) * 2.0
    : 0;
  const lengthPenalty = metrics.avgLen > 35
    ? (metrics.avgLen - 35) / 50
    : 0;

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
function formatJobName(name) {
  // Ensure safe string
  let formatted = String(name || "").trim();

  // Insert a space after leading numbers (e.g., "44Riverstone" → "44 Riverstone")
  formatted = formatted.replace(/^(\d+)([A-Za-z])/, "$1 $2");

  // Capitalize the first letter of each word
  formatted = formatted.replace(/\b\w/g, c => c.toUpperCase());

  return formatted;
}


/* ----------------- UI helpers -------------- */
function renderColumns(columns) {
  $grid.innerHTML = "";

  // Filter out columns that have no items
  const visibleColumns = columns.filter(c => Array.isArray(c.items) && c.items.length > 0);

  for (const col of visibleColumns) {
    const div = document.createElement('div');
    div.className = 'col';

    const hdr = document.createElement('div');
    hdr.className = 'hdr';

    const left = document.createElement('div');
    left.textContent = col.header;

    const right = document.createElement('div');
    right.className = 'muted';
    right.textContent = col.items.length;

    hdr.appendChild(left);
    hdr.appendChild(right);

    const list = document.createElement('div');
    list.className = 'list';

    for (const item of col.items) {
      const d = document.createElement('div');
      d.className = 'item';
      d.textContent = formatJobName(item);

      // NEW: click to toggle greyed-out + line-through
      d.addEventListener('click', () => {
        d.classList.toggle('item-done');
      });

      list.appendChild(d);
    }

    div.appendChild(hdr);
    div.appendChild(list);
    $grid.appendChild(div);
  }

  if (visibleColumns.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'muted';
    msg.textContent = '(No jobs to display)';
    $grid.appendChild(msg);
  }
}


function buildAOA(columns) {
  const nonEmpty = columns.filter(c => Array.isArray(c.items) && c.items.length > 0);

  const header1 = [];
  const header2 = [];

  for (const c of nonEmpty) {
    header1.push(c.header);
    header2.push("Key");
  }

  const maxLen = Math.max(0, ...nonEmpty.map(c => c.items.length));
  const rows = [];

  for (let r = 0; r < maxLen; r++) {
    const line = [];
    for (const c of nonEmpty) {
      line.push(formatJobName(c.items[r] || ""));
    }
    rows.push(line);
  }

  return [header1, header2, ...rows];
}

// Aliases used for debug display in Explain panel
const ALIAS_GROUPS = {
  Paid: ["paid column", "paid columns"],
  Complete: ["column complete", "columns complete", "column completed", "columns completed"],
  Invoiced: ["invoice", "invoiced", "invoicing"],
  "Job Complete": ["100% job complete", "job complete/inspected"]
};

function downloadAOA(aoa, filename = "jobs.csv") {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, "Jobs");

  XLSX.writeFile(wb, filename);
}

function readRow(r, info){
  const rawTitle = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]) : "";
  const title    = rawTitle.toLowerCase();           // keep spaces and %, just lower-case
  const done     = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
  const pct      = info.percentCompleteIdx >= 0 ? numberish(r[info.percentCompleteIdx]) : NaN;
  return { title, done, pct };
}

function rowIsDone(done, pct){
  return !!done || pct === 100;
}

// 🔹 NEW: does this job have *any* row that is actually “done”
// (Completed = TRUE or PercentComplete = 100)?
function jobHasAnyDoneRow(records, info){
  if (!Array.isArray(records)) return false;
  return records.some(({ r }) => {
    const { done, pct } = readRow(r, info);
    return rowIsDone(done, pct);
  });
}

function isFalseComplete(title, done){
  return (title.includes("complete") || title.includes("completed")) && !done;
}


function anyDoneByTitle(records, info, aliases) {
  const aliasNorm = (aliases || []).map(a => norm(a));

  for (const { r } of records) {
    const { title, done, pct } = readRow(r, info);
    const matched = aliasNorm.some(a => title.includes(a));
    if (!matched) continue;

    // Ignore “fake complete” rows
    if (isFalseComplete(title, done)) continue;

    if (rowIsDone(done, pct)) {
      return true;
    }
  }

  return false;
}


const ALIASES = {
  columns: {
    complete: ["column complete","columns complete","column completed","columns completed"],
    paid:     ["paid column","paid columns"]  // singular + plural
  }
};


// ---------- Core unpaid-finished detector ----------
function getTradesToPay(records, info) {
  const trades = [];

  // Columns: only flag when finished AND not paid
  const colFinished = anyDoneByTitle(records, info, ALIASES.columns.complete);
  const colPaid     = anyDoneByTitle(records, info, ALIASES.columns.paid);

  // ✅ NEW hard guard: if paid is true and finished, never include
  if (colFinished && colPaid) {
    vlog("[Skip Columns] already finished & paid → hide from all buckets");
    return trades; // return empty, skip Columns entirely
  }

  // Only flag when finished but not paid
 // --- Guard: Only flag Columns if a subcontractor was actually involved ---
const hasSubInvolved = records.some(({ r }) => {
  const title = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]).toLowerCase() : "";
  return title.includes("paid siding sub") || title.includes("subcontractor");
});

// Only mark Columns To Pay if finished, not paid, and sub was involved
if (colFinished && !colPaid && hasSubInvolved) {
  trades.push("Columns");
} else if (colFinished && !colPaid && !hasSubInvolved) {
  vlog("[Skip Columns] finished but no subcontractor involvement → skip Columns To Pay");
}


  // Defensive: remove Columns if any Paid-row exists (even incomplete)
  if (colPaid) {
    const idx = trades.indexOf("Columns");
    if (idx >= 0) trades.splice(idx, 1);
  }

  return trades;
}

// 🧩 Improved key generator for consistent job name matching
function makeJobKey(str) {
  if (!str) return "";

  return String(str)
    .replace(/\s+/g, " ")                 // collapse multiple spaces
    .replace(/([0-9])([A-Za-z])/g, "$1 $2") // insert missing space between numbers & letters
    .trim()
    .toLowerCase();
}


// ---------- Optional: invoice/final helpers used elsewhere ----------
function invoiceStatus(records, info){
  const aliases = ["invoiced"]; // extend if you use variants
  let present = false, done = false;
  for (const { r } of records){
    const { title, done: d, pct } = readRow(r, info);
    if (aliases.some(a => title.includes(a))){
      present = true;
      if (rowIsDone(d, pct)) done = true;
    }
  }
  return { present, done };
}


