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
const IGNORED_TRADES = new Set(["housewrap"]); // never surface this trade in UI

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

function tokensFor(trade){
  const key = TRADE_TOKEN_MAP[trade] || trade.toLowerCase();
  return Array.isArray(TRADE_GROUPS[key]) ? TRADE_GROUPS[key] : [key];
}

function containsAny(txt, arr){ return arr.some(k => txt.includes(k)); }
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
  return records.some(({r}) => {
    const s = textOf(r, info);
    const looks100 = s.includes("100% job complete");
    const looksInspected = s.includes("job complete/inspected");
    return (looks100 || looksInspected) && rowIsCompleted(r, info);
  });
}

// For a specific trade, do we have "<Trade> Complete" finished?
function hasTradeWorkComplete(trade, records, info, tokens){
  return records.some(({r}) => {
    const s = textOf(r, info);
    return s.includes("complete") && tokens.some(tok => s.includes(tok)) && rowIsCompleted(r, info);
  });
}


function findUnpaidTrade(records, info){
  const rows = records.map(({r}) => ({ r, s: textOf(r, info) }));

  for (const [trade, tokens] of Object.entries(TRADE_GROUPS)){
    if (IGNORED_TRADES.has(trade)) continue;

    const tradeComplete = hasTradeWorkComplete(trade, records, info, tokens);
    const closeOutDone  = hasAnyCloseOutComplete(records, info);

    const paidRows       = rows.filter(x => x.s.includes("paid") && tokens.some(t => x.s.includes(t)));
    const anyPaidPending = paidRows.some(x => !rowIsCompleted(x.r, info));
    const anyPaidDone    = paidRows.some(x =>  rowIsCompleted(x.r, info));

    if (anyPaidPending && (tradeComplete || closeOutDone)){
      return { trade, reason: `Title→${capitalize(trade)} (to pay), Paid-title present (unfinished)` };
    }
    if (tradeComplete && !anyPaidDone){
      return { trade, reason: `${capitalize(trade)} complete without payment` };
    }
  }
  return null;
}

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

const PHRASES_INVOICE = ["invoice","ready to invoice","ready to bill","pay crew","ready to pay","bill now","billing","send invoice","invoice ready","ready for invoice"];
const PHRASES_CLOSE = ["job complete/inspected","job complete","100% job complete","close out","closed"];
const PHRASES_LIEN  = ["lien","liens needed","lien needed"];

/* --------- HOISTED HELPERS --------- */
// --- SAFETY GUARDS ---
function safeArray(a){ return Array.isArray(a) ? a : []; }

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

// NEW: Title-driven To-Pay logic with “Paid … (0%) but no <Trade> Complete anywhere” exception
function titleIndicatesTradeToPay(trade, records, info, tokens){
  if (IGNORED_TRADES.has(trade)) return false;

  const rows = records.map(({r}) => ({ r, s: textOf(r, info) }));
  const paidRows       = rows.filter(x => x.s.includes("paid") && tokens.some(t => x.s.includes(t)));
  const anyPaidPending = paidRows.some(x => !rowIsCompleted(x.r, info));
  const anyPaidDone    = paidRows.some(x =>  rowIsCompleted(x.r, info));

  // <- NEW: require real completion context to surface payments
  const tradeComplete  = hasTradeWorkComplete(trade, records, info, tokens);
  const closeOutDone   = hasAnyCloseOutComplete(records, info);

  // Rule 1: unpaid "Paid <Trade>" only counts if tradeComplete OR closeOutDone
  if (anyPaidPending && (tradeComplete || closeOutDone)){
    return true; // "<Trade> To Pay"
  }

  // Rule 2: trade completed but no completed payment yet
  if (tradeComplete && !anyPaidDone){
    return true;
  }

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
/* ------------------------------------ */

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
  // Reuse your existing brain:
  const d = decideForJob(job, records);
  // Return only what your UI needs:
  return {
    bucket: d.bucket,
    reason: d.reason,
    trade: d.trade || null
  };
}

    // Decision engine
function decideForJob(job, records){
  if (!Array.isArray(records) || records.length === 0){
    return { bucket:null, reason:"no records for job", trade:null, extra:null };
  }      // HIDE RULE: if every PercentComplete value present for this job equals 0 → suppress
      if (jobShouldBeHiddenForZeroPercents(records, info)){
        return { bucket:null, reason:"All PercentComplete entries are 0 → suppress", trade:null, extra:null };
      }

      // collect trade hits (explicit columns or titles)
      const hits = [];
      for (const trade of TRADES){
        const paidIdx = info.paidByTrade[trade] ?? -1;
        const toPayIdx = info.toPayByTrade[trade] ?? -1;

        // (a) explicit columns win immediately
        if (paidIdx >= 0 && records.some(({r}) => isFalse(r[paidIdx]))){
          hits.push({ trade, why: `Paid ${trade} = FALSE`, tiePct: 0 });
          continue;
        }
        if (toPayIdx >= 0 && records.some(({r}) => isTruthy(r[toPayIdx]) || String(r[toPayIdx]).trim()!=="")){
          hits.push({ trade, why: `${trade} To Pay marked`, tiePct: 0 });
          continue;
        }

        // (b) Titles (with the balanced “Paid … (0%) unless <Trade> Complete exists” rule)
       // (b) Titles (with the balanced “Paid … (0%) unless <Trade> Complete exists” rule)
const tokens = tokensFor(trade);
if (titleIndicatesTradeToPay(trade, records, info, tokens)){
  let minPct = 1000;
  for (const { r } of records){
    const title = info.titleIdx>=0 ? safeCell(r[info.titleIdx]) : "";
    const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const pats = TRADE_DUE_TITLE_PATTERNS[trade] || [];
    if (titleMatchesAny(pats, title)){
      if (!isNaN(pct)) minPct = Math.min(minPct, pct); else minPct = Math.min(minPct, 999);
    }
  }
  hits.push({ trade, why: `Title indicates ${trade} payment needed`, tiePct: isFinite(minPct) ? minPct : 999 });
}

      }

      if (hits.length){
        hits.sort((a,b) => a.tiePct - b.tiePct);
        const pick = hits[0];
        return { bucket: `${pick.trade} To Pay`, reason: pick.why, trade: pick.trade, extra: null };
      }

   // Guard: block Invoice only when a “100% Job Complete” row is actually complete
const hasBlocking100Complete = records.some(({r}) => {
  const phrasePresent = contains(combinedStatus(r), "100% job complete");
  if (!phrasePresent) return false;
  const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
  const completedTruth = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
  return completedTruth || (!isNaN(pct) && pct >= 100);
});
// PRIORITY 1: Trades (To Pay) — must run before Invoice
const unpaidTrade = findUnpaidTrade(records, info);
if (unpaidTrade){
return {
  bucket: `${labelForTrade(unpaidTrade.trade)} To Pay`,
  reason: unpaidTrade.reason,
  trade:  unpaidTrade.trade,
  extra:  null
};
}

// NEW: If 100% is complete but "Invoiced" exists and is NOT complete, route to Jobs To Invoice
const invoicedRows = records.filter(({r}) => contains(combinedStatus(r), "invoiced"));
const invoicedPresent = invoicedRows.length > 0;
const invoicedDone = invoicedRows.some(({r}) => {
  const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
  const completedTruth = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
  return completedTruth || (!isNaN(pct) && pct >= 100);
});
if (hasBlocking100Complete && invoicedPresent && !invoicedDone){
  return { bucket:"Jobs To Invoice", reason:"100% complete but Invoiced not completed", trade:null, extra:null };
}

// PRIORITY 2: Invoice (existing)
if (!hasBlocking100Complete && records.some(({r}) => anyContains(combinedStatus(r), PHRASES_INVOICE))){
  const rec = records.find(({r}) => anyContains(combinedStatus(r), PHRASES_INVOICE));
  const phrase = PHRASES_INVOICE.find(p => contains(combinedStatus(rec.r), p));
  return { bucket:"Jobs To Invoice", reason:`contains “${phrase}” in ${combinedStatus(rec.r)}`, trade:null, extra:null };
}

      // PRIORITY 3: Close
      if (info.completedIdx>=0 && records.some(({r}) => isTruthy(r[info.completedIdx]))){
        return { bucket:"Jobs To Close", reason:"Completed = TRUE", trade:null, extra:null };
      }
      if (info.percentCompleteIdx>=0 && records.some(({r}) => Number(r[info.percentCompleteIdx])>=100)){
        return { bucket:"Jobs To Close", reason:"PercentComplete ≥ 100", trade:null, extra:null };
      }
      if (records.some(({r}) => anyContains(combinedStatus(r), PHRASES_CLOSE))){
        const rec = records.find(({r}) => anyContains(combinedStatus(r), PHRASES_CLOSE));
        const phrase = PHRASES_CLOSE.find(p => contains(combinedStatus(rec.r), p));
        return { bucket:"Jobs To Close", reason:`contains “${phrase}”`, trade:null, extra:null };
      }

      // PRIORITY 4: Liens
      if (records.some(({r}) => anyContains(combinedStatus(r), PHRASES_LIEN))){
        return { bucket:"Liens Needed", reason:"lien phrase found", trade:null, extra:null };
      }

      return { bucket:null, reason:"no rules matched", trade:null, extra:null };
    }

    // assign jobs
  // assign jobs
const assignment = new Map();
for (const [job, records] of jobGroups.entries()){
  const pick = classifyJob(job, records, info);
  assignment.set(job, pick);
}


    // build columns from assignment
    const columns = [];
    for (const trade of TRADES){
      const items = [];
      for (const [job, decision] of assignment.entries()){
        if (decision.bucket === `${trade} To Pay`) items.push(job);
      }
      if (items.length) items.sort((a,b)=>a.localeCompare(b, undefined, {numeric:true,sensitivity:'base'}));
      columns.push({ header:`${trade} To Pay`, items });
    }
    const invoice = [], close = [], lien = [];
    for (const [job, decision] of assignment.entries()){
      if (decision.bucket === "Jobs To Invoice") invoice.push(job);
      else if (decision.bucket === "Jobs To Close") close.push(job);
      else if (decision.bucket === "Liens Needed") lien.push(job);
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

  const { jobGroups, assignment, info, combinedStatus } = state;
  const out = [];
  out.push(`Explain (priority = Trades → Invoice → Close → Lien)`);
  out.push("");

  for (const job of targets){
    const recs = jobGroups.get(job);
    if (!recs){
      out.push(`• ${job} — NOT FOUND`);
      out.push("");
      continue;
    }
    const pick = assignment.get(job) || { bucket:null, reason:"(none)" };
    out.push(`• ${job} — bucket: ${pick.bucket || "(none)"} — reason: ${pick.reason}`);
    recs.forEach(({r,rowNum})=>{
      const title = info.titleIdx>=0 ? safeCell(r[info.titleIdx]) : "";
      const phase = info.phaseIdx>=0 ? safeCell(r[info.phaseIdx]) : "";
      const completed = info.completedIdx>=0 ? safeCell(r[info.completedIdx]) : "";
      const pct = info.percentCompleteIdx>=0 ? safeCell(r[info.percentCompleteIdx]) : "";
      const statusStr = combinedStatus(r);
      const flags = [];
      for (const t of TRADES){
        const p = info.paidByTrade[t]; const q = info.toPayByTrade[t];
        if (p>=0 && isFalse(r[p])) flags.push(`Paid ${t}=FALSE`);
        if (q>=0 && (isTruthy(r[q]) || String(r[q]).trim()!=="")) flags.push(`${t} To Pay=Y`);

        if (titleIndicatesTradeToPay(t, [{r}], info, tokensFor(t))) {
  flags.push(`Title→${t} (to pay)`);
}


        const token = buildTradeTitlePattern(t);
        const paidRx = new RegExp(`\\bpaid\\b[^a-z0-9]*${token}`,'i');
        if (paidRx.test(title)) {
          const pctN = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
          const doneN = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
          flags.push(`Paid-title present (pct=${isNaN(pctN)?"":pctN}, completed=${doneN})`);
        }
      }
      out.push(`   [row ${rowNum}] title="${title}" | phase="${phase}" | completed=${completed} | percent=${pct} | status="${statusStr}"${flags.length? " | "+flags.join(", ") : ""}`);
    });
    out.push("");
  }
  $inspectOut.textContent = out.join("\n");
});

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
  const hints = ["job","title","phase","notes","percentcomplete","completed","paid","to","pay","topay","siding","painters","columns","trellis","screen porch","decking","waterproof","louvered","wall","gutters","invoice","lien","close"].map(norm);
  let hintHits = 0; for (const n of normalized){ if (n.length <= 30 && hints.some(h => n.includes(h))) hintHits++; }
  const hintScore = hintHits / Math.max(1, nonEmpty.length);
  const m = bannerMetrics(row);
  const bannerPenalty = looksLikeBannerMetrics(m) ? (m.repeatRatio - 0.6) * 2.0 : 0;
  const lengthPenalty = m.avgLen > 35 ? (m.avgLen-35)/50 : 0;
  return (0.55*hintScore + 0.45*uniqScore) - (bannerPenalty + lengthPenalty);
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
