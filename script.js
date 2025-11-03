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
function numberish(v){
  // Treat empty / null as "no number"
  if (v === "" || v == null) return NaN;

  // Basic numeric conversion (matches how you use Number(...) elsewhere)
  const n = Number(v);
  return isNaN(n) ? NaN : n;
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

const READY_INVOICE_MODE = "either";
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

function paidTitlePresent(trade, records, info){
  if (info.titleIdx < 0) return false;
  const token = buildTradeTitlePattern(trade);
  const paidRx = new RegExp(`\\bpaid\\b[^a-z0-9]*${token}`, 'i');
  return records.some(({r}) => paidRx.test(safeCell(r[info.titleIdx])));
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
$run.addEventListener('click', ()=>{
  try{
    if (!parsedSheets.length) throw new Error("Please upload one or more workbooks first.");

    // Use the first file's header row for column detection
    const primary = parsedSheets[0];
    const headerRow = primary.aoa[primary.headerIndex] || [];
    dumpRow(`Chosen header row ${primary.headerIndex+1} (raw)`, headerRow, 30);
    dumpRow(`Chosen header row ${primary.headerIndex+1} (normalized)`, headerRow.map(norm), 30);

    const info = detectColumnsFrom(headerRow);
    info.headerRowIndex = primary.headerIndex; 
    info.headerReason = primary.headerReason;

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
    sep(); vlog("Column mappings (from first file):\n" + mapLines.join("\n"), "ok"); sep();

    // Merge rows from ALL files (skip each file's header region)
    const allRows = [];
    for (const pf of parsedSheets){
      const rows = pf.aoa.slice(pf.headerIndex + 1);
      allRows.push(...rows);
    }
    $countBadge.textContent = `${allRows.length} rows`;

    const combinedStatus = (r)=>{
      const parts = [];
      if (info.phaseIdx>=0) parts.push(safeCell(r[info.phaseIdx]));
      if (info.titleIdx>=0) parts.push(safeCell(r[info.titleIdx]));
      if (info.allNotesIdx>=0) parts.push(safeCell(r[info.allNotesIdx]));
      return parts.filter(Boolean).join(" | ");
    };

    // Group rows by job
  // Group rows by job
const jobGroups = new Map();
const keyIdx = info.keyIdx;

allRows.forEach((r, i) => {
  const rawJob = r[keyIdx];                         // whatever is in the job column
  const prettyJob = String(rawJob || "").trim();    // for display / logs
  if (!prettyJob) return;

  const jobKey = makeJobKey(rawJob);                // <- HERE is where keyExact logic gets used
  if (!jobKey) return;

  const list = jobGroups.get(jobKey) || [];
  list.push({
    r,
    rowNum: i + (info.headerRowIndex + 2),
    rawJob: prettyJob
  });
  jobGroups.set(jobKey, list);
});

log(`Grouped into ${jobGroups.size} unique jobs.`, "ok");


    function classifyJob(job, records, info){
      const d = decideForJob(job, records);
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

      const READY_INVOICE_MODE = "either";
      const REQUIRE_INVOICE_PHRASE_FOR_BUCKET = false;
      const ALLOW_MULTI_BUCKETS = true;

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
            const v = r[meta.containsInvoiceIdx];
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
// === MULTI-TRADE TO-PAY + CLOSE-IF-INVOICED PATCH ===========================
// Recognize finishes:
const TRADE_COMPLETE_TITLE_PATTERNS = {
  "Siding":        [/^siding complete\b/i],
  "Screen Porch":  [/^screen porch complete\b/i, /^porch complete\b/i],
  "Porch":         [/^porch complete\b/i],
  "Rails":         [/^rails complete\b/i],
  "House Wrap":    [/^house wrap complete\b/i],
  "Columns":       [/^columns?\s*complete\b/i, /^column wrap complete\b/i, /^post wrap complete\b/i],
  "_global":       [/^job complete\/inspected\b/i, /^100%\s*job\s*complete\b/i],
};
// Let global finals count for these trades:
const GLOBAL_FINISH_OK_FOR = new Set(["Siding"]);
function safeCell(v){ return (v==null ? "" : String(v)).trim(); }
function isTruthy(v){ return v === true || v === "true" || v === 1 || v === "1" || v === "TRUE"; }
function titleMatchesAny(pats, title){
  if (!pats || !pats.length) return false;
  return pats.some(re => re.test(title));
}
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
      if (done === true) return true;
      if (!isNaN(pct) && pct >= 100) soft = true;
    }
  }
  return soft;
}
function paidStatus(trade, recs, meta){
  // Default: "Paid {Trade}"
  const defaultPattern = new RegExp("^paid\\s+"+ trade.replace(/\s+/g, "\\s+") +"\\b", "i");
  // Special cases per trade (add more if you need):
  const PAID_TITLE_PATTERNS = {
    "Columns": [/^paid\s+columns?\b/i, /^paid\s+column\s*wrap\b/i, /^paid\s+post\s*wrap\b/i],
    // "Screen Porch": [/^paid\s+screen\s*porch\b/i], // example if you need alternates later
  };

  const patterns = PAID_TITLE_PATTERNS[trade] || [defaultPattern];

  let present = false, done = false, explicitFalse = false;

  for (const { r } of recs){
    const title = meta.titleIdx>=0 ? safeCell(r[meta.titleIdx]) : "";
    if (!patterns.some(re => re.test(title))) continue;

    present = true;

    const doneFlag = meta.completedIdx>=0 ? isTruthy(r[meta.completedIdx]) : false;
    const pct      = meta.percentCompleteIdx>=0 ? Number(r[meta.percentCompleteIdx]) : NaN;

    if (doneFlag || (!isNaN(pct) && pct >= 100)) {
      done = true;
    } else if (meta.completedIdx>=0 && r[meta.completedIdx] === false) {
      explicitFalse = true;
    }
  }
  return { present, done, explicitFalse };
}

function getTradesToPay(recs, meta){
  const CANDIDATE_TRADES = ["Siding","Porch","Screen Porch","Columns","Rails","House Wrap"];
  const toPay = [];
  for (const t of CANDIDATE_TRADES){
    if (!tradeIsFinished(t, recs, meta)) continue;
    const { present, done, explicitFalse } = paidStatus(t, recs, meta);
    if ((present && !done) || explicitFalse){
      toPay.push(t);
    }
  }
  return toPay;
}

// ----- MAIN DECISION for To Pay (+Close if Invoiced) ------------------------
// ----- MAIN DECISION for To Pay (+Close if Invoiced) ------------------------
const tradesNeedingPayment = getTradesToPay(records, info); // pass info, not meta

if (tradesNeedingPayment.length >= 1){
  // Priority decides the primary To Pay bucket label:
  const PRIORITY = ["Screen Porch","Porch","Columns","Rails","Siding","House Wrap"];
  const sorted = [...tradesNeedingPayment].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b));

  const primary = sorted[0];
  const others  = sorted.slice(1);

  const result = {
    bucket: `${primary} To Pay`,
    reason: `${primary} payment needed (title/implicit, finished)`,
    trade:  primary,
    extra:  (others.length ? { multiTradesPending: sorted } : null),
  };

  // Fan out to other unpaid trades as duplicates (if any)
  if (others.length){
    result.duplicates = others.map(t => ({
      bucket: `${t} To Pay`,
      reason: `${t} payment needed (trade finished; multiple trades pending)`,
      trade:  t,
      extra:  { multiTradesPending: sorted }
    }));
  }

  // Invoiced status + final status
  const inv = invoiceStatus(records, info);
  const finalDoneNow = hasFinalCompleteDone(records, info); // already defined below

  // ✅ ALSO show in Close if BOTH invoice & final are fully completed
  if (inv.present && inv.done && finalDoneNow){
    (result.duplicates ??= []).push({
      bucket: "Jobs To Close",
      reason: `Invoice completed and final complete; also pending trade payment`,
      trade:  null,
      extra:  { multiTradesPending: sorted }
    });
  }

  // ✅ NEW: ALSO show in Jobs To Invoice when either:
  //   - Invoiced is present but not completed, or
  //   - Ready for invoice (JCI 100%/done), invoice not started and phrase not required
  const ready = jobReadyForInvoice(records, info);
  const invoicePhraseRequired = (typeof REQUIRE_INVOICE_PHRASE_FOR_BUCKET !== "undefined") ? REQUIRE_INVOICE_PHRASE_FOR_BUCKET : false;

  if ( (inv.present && !inv.done) || (!inv.present && !invoicePhraseRequired && ready) ){
    (result.duplicates ??= []).push({
      bucket: "Jobs To Invoice",
      reason: inv.present && !inv.done ? '"Invoiced" present but not completed'
                                       : 'Ready; invoice not started',
      trade:  null,
      extra:  null
    });
  }

  return result;
}

// Invoiced present/done?
function invoiceStatus(recs, meta){
  let present = false, done = false;
  for (const { r } of recs){
    const title = meta.titleIdx>=0 ? safeCell(r[meta.titleIdx]) : "";
    if (!/^invoiced\b/i.test(title)) continue;
    present = true;
    const doneFlag = meta.completedIdx>=0 ? isTruthy(r[meta.completedIdx]) : false;
    const pct      = meta.percentCompleteIdx>=0 ? Number(r[meta.percentCompleteIdx]) : NaN;
    if (doneFlag || (!isNaN(pct) && pct >= 100)) done = true;
  }
  return { present, done };
}

      function tradePaidTruthiness(trade, recs, meta){
        const paidIdx = meta.paidByTrade[trade] ?? -1;
        if (paidIdx < 0) return null;
        let sawTrue = false, sawFalse = false;
        for (const { r } of recs){
          const v = r[paidIdx];
          if (isTruthy(v)) sawTrue = true;
          else if (isFalse(v)) sawFalse = true;
        }
        if (sawTrue)  return true;
        if (sawFalse) return false;
        return null;
      }

      // ===== FINAL FLAGS =====
      const readyForInvoiceGate = jobReadyForInvoice(records, info);
      const finalDone           = hasFinalCompleteDone(records, info);
      const pendingFinal        = hasFinalCompletePresentButNotDone(records, info);

      const invoicedRows    = records.filter(({r}) => combinedStatus(r).toLowerCase().includes("invoiced"));
      const invoicedPresent = invoicedRows.length > 0;
      const invoicedDone    = invoicedRows.some(({r}) => {
        const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
        const completedTruth = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
        return completedTruth || (!isNaN(pct) && pct >= 100);
      });

      // All-zero guard
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

      // PRIORITY 1: TRADES
     let primaryTradeHit = null;
for (const trade of TRADES){
  if (IGNORED_TRADES.has(String(trade).toLowerCase())) continue;
  if (!tradeIsFinished(trade, records, info)) continue;

  // ✅ NEW GUARD — skip any finished trade that already has a "Paid" row (even if partially marked)
  if (tradeIsFinished(trade, records, info) && paidTitlePresent(trade, records, info)) {
    vlog(`[Skip] ${trade} already finished & has paid title → hide from all To Pay buckets`);
    continue;
  }

  const paidTruth = tradePaidTruthiness(trade, records, info);
  if (paidTruth === true) continue;
  if (paidTruth === false){
          if (String(trade).toLowerCase()==="porch" && typeof HIDE_PORCH_TO_PAY!=="undefined" && HIDE_PORCH_TO_PAY){
            // suppressed
          } else {
            primaryTradeHit = { bucket:`${trade} To Pay`, reason:`Paid ${trade} = FALSE (finished)`, trade, extra:null };
            break;
          }
        } else {
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

      // INVOICE
      let invoiceNeeded = false;
      let invoiceReason = null;
      const invoiceSignal = containsInvoiceSignal(records, info);
      const invoicedNotDone = invoicedPresent && !invoicedDone;

      const invoiceSecondaryPossible =
        readyForInvoiceGate &&
        (
          (invoicedNotDone) ||
          (!invoicedPresent && !REQUIRE_INVOICE_PHRASE_FOR_BUCKET) ||
          (typeof info.containsInvoiceIdx==="number" && info.containsInvoiceIdx>=0 && invoiceSignal===false)
        );

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

      if (invoicedPresent && invoicedDone && !finalDone){
        if (primaryTradeHit){
          return primaryTradeHit;
        }
        return { bucket:null, reason:"Invoice completed but 100% Job Complete is not done → suppress until final", trade:null, extra:null };
      }

      if (pendingFinal){
        if (invoicedPresent && invoicedDone && !finalDone){
          if (primaryTradeHit) return primaryTradeHit;
          return { bucket:null, reason:"Invoice completed but 100% Job Complete is not done → suppress until final", trade:null, extra:null };
        }
        if (primaryTradeHit && invoiceNeeded && ALLOW_MULTI_BUCKETS){
          return { ...primaryTradeHit, duplicates:[{ bucket:"Jobs To Invoice", reason:`${invoiceReason}; final pending`, trade:null, extra:null }] };
        }
        if (!primaryTradeHit && invoiceNeeded){
          return { bucket:"Jobs To Invoice", reason:`${invoiceReason}; final pending`, trade:null, extra:null };
        }
        const anyLien = records.some(({r}) => anyContains(combinedStatus(r), PHRASES_LIEN));
        if (anyLien){
          return { bucket:"Liens Needed", reason:"lien phrase found (final pending)", trade:null, extra:null };
        }
        return { bucket:null, reason:"Final present but not done → suppress (job not done)", trade:null, extra:null };
      }

      if (primaryTradeHit && ALLOW_MULTI_BUCKETS){
  const hasInvoicePhrase = containsInvoiceSignal(records, info);
  if (invoiceNeeded || hasInvoicePhrase){
    return {
      ...primaryTradeHit,
      duplicates:[{
        bucket:"Jobs To Invoice",
        reason: invoiceReason || 'Invoice present but not yet completed',
        trade: null,
        extra: null
      }]
    };
  }
}
      if (primaryTradeHit) return primaryTradeHit;
      if (invoiceNeeded)  return { bucket:"Jobs To Invoice", reason:invoiceReason, trade:null, extra:null };

      if (finalDone && invoicedDone){
        return { bucket:"Jobs To Close", reason:"Final completion row done and invoice completed; all trades paid", trade:null, extra:null };
      }
      if (records.some(({r}) => anyContains(combinedStatus(r), PHRASES_LIEN))){
        return { bucket:"Liens Needed", reason:"lien phrase found", trade:null, extra:null };
      }
      return { bucket:null, reason:"no rules matched", trade:null, extra:null };
    }

    // assign jobs
  const assignment = new Map();
for (const [jobKey, records] of jobGroups.entries()){
  const displayJobName = records[0]?.rawJob || "";   // "2 Sugar Creek"
  const pick = classifyJob(displayJobName, records, info);
  assignment.set(jobKey, pick);
}


    const columns = [];

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

    // === FIX: Build each trade column ONCE (includes duplicates), removing the earlier duplicate pass ===
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
// Global buckets — include duplicates for Close
const invoice = [], close = [], lien = [];
for (const [job, decision] of assignment.entries()){
  const allB = allBucketsForDecision(decision);
  if (allB.some(b => String(b||"").includes("Jobs To Invoice"))) invoice.push(job);
  if (allB.some(b => String(b||"").includes("Jobs To Close")))   close.push(job);   // ← include duplicates
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

    state = { rows: allRows, info, jobGroups, assignment, combinedStatus };

    const counts = columns.map(c=>`${c.header}=${c.items.length}`).join(" • ");
    log(`Computation complete. ${counts}`, "ok");
  }catch(e){ log(e?.message||String(e), "err"); }
});

/* ----------------- Explain panel ----------- */
$inspectBtn.addEventListener('click', ()=>{
  if (!state){
    $inspectOut.textContent = "Run Compute first.";
    return;
  }

  const targets = $inspectInput.value
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!targets.length){
    $inspectOut.textContent = "Paste one job per line.";
    return;
  }

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
    return `"${title}" — ${phase} — %=${pct || 0} — Completed=${done || ""}`;
  }

  for (const job of targets){
    // Use the same key logic as the main grouping:
    const key = makeJobKey(job);
    const recs = jobGroups.get(key);

    if (!recs){
      lines.push(`• ${job} — NOT FOUND`);
      lines.push("");
      continue;
    }

    const pick = assignment.get(key) || { bucket:null, reason:"(none)" };

    // Show the nice name from the data if available:
    const displayName = recs[0]?.rawJob || job;

    lines.push(`• ${displayName}`);
    lines.push(`  Bucket: ${pick.bucket || "(none)"}  |  Reason: ${pick.reason}`);
    const aliases = ALIASES.columns;
lines.push(`  Debug Aliases:`);
lines.push(`    Paid → ${aliases.paid.join(", ")}`);
lines.push(`    Complete → ${aliases.complete.join(", ")}`);

const debugPaid = recs
  .map(({ r }) => {
    const rawTitle = safeCell(r[info.titleIdx]);
    const normTitle = norm(rawTitle);
    const matched = aliases.paid.some(a => normTitle.includes(norm(a)));
    return `    ${matched ? "✅" : "❌"} ${rawTitle}`;
  })
  .filter(Boolean);

if (debugPaid.length) lines.push(...debugPaid);


    const invoicedRows = recs.filter(({r}) =>
      String(safeCell(r[info.titleIdx])).toLowerCase().includes("invoiced")
    );

    if (invoicedRows.length){
      const flag = invoicedRows.some(({r})=>{
        const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
        const done = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
        return done || (!isNaN(pct) && pct>=100);
      }) ? "✅" : "🟡";
      lines.push(`  ${flag} 📄 Invoiced row present (${invoicedRows.length})`);
    }

    const tradeHints = [];
    for (const t of TRADES){
      const token = buildTradeTitlePattern(t);
      const paidRx = new RegExp(`\\bpaid\\b[^a-z0-9]*${token}`, 'i');

      const paidAny = recs.some(({r}) => paidRx.test(safeCell(r[info.titleIdx])));
      if (paidAny){
        const paidDone = recs.some(({r})=>{
          const title = safeCell(r[info.titleIdx]);
          if (!paidRx.test(title)) return false;
          const pct = info.percentCompleteIdx>=0 ? Number(r[info.percentCompleteIdx]) : NaN;
          const done = info.completedIdx>=0 ? isTruthy(r[info.completedIdx]) : false;
          return done || (!isNaN(pct) && pct>=100);
        });
        tradeHints.push(`${paidDone ? "✅" : "🟡"} Paid ${t}`);
      }

      const complete = hasTradeCompleteSignal(t, recs, info);
      if (complete) tradeHints.push(`✅ ${t} Complete`);
    }

    if (tradeHints.length) {
      lines.push(`  Trades: ${tradeHints.join(" • ")}`);
    }

    const shortlist = recs
      .slice(0, 5)
      .map(({r}) => `  - ${rowMini(r)}`);

    if (shortlist.length) {
      lines.push("  Key rows:");
      lines.push(...shortlist);
    }
    lines.push("");
  }

  $inspectOut.textContent = lines.join("\n");
});


// --- FINAL ROW DETECTORS ---
function isFinalCompleteRow(title){
  const t = String(title || "").toLowerCase();
  return /100\s*%.*job\s*complete/.test(t) ||
         /job\s*complete\s*[/-]?\s*inspected/.test(t) ||
         /final\b/.test(t);
}

function hasFinalCompleteDone(records, info){
  return Array.isArray(records) && records.some(({ r }) => {
    const title = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]) : "";
    if (!isFinalCompleteRow(title)) return false;
    const pct   = info.percentCompleteIdx >= 0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const done  = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
    return done === true || (!Number.isNaN(pct) && pct >= 100);
  });
}
function hasFinalCompletePresentButNotDone(records, info){
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

function readRow(r, info){
  const rawTitle = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]) : "";
  const title    = rawTitle.toLowerCase();           // keep spaces and %, just lower-case
  const done     = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
  const pct      = info.percentCompleteIdx >= 0 ? numberish(r[info.percentCompleteIdx]) : NaN;
  return { title, done, pct };
}

function rowIsDone(done, pct){ return !!done || pct === 100; }
function isFalseComplete(title, done){ return (title.includes("complete") || title.includes("completed")) && !done; }

function anyDoneByTitle(records, info, aliases) {
  const aliasNorm = (aliases || []).map(a => norm(a));

  const debug = []; // collect diagnostics
  for (const { r } of records) {
    const { title, done, pct } = readRow(r, info);
    const matched = aliasNorm.some(a => title.includes(a));

    debug.push({
      title,
      done,
      pct,
      matchedAliases: aliasNorm.filter(a => title.includes(a))
    });

    if (matched) {
      if (isFalseComplete(title, done)) continue;
      if (rowIsDone(done, pct)) {
        console.groupCollapsed("✅ anyDoneByTitle → match");
        console.table(debug);
        console.groupEnd();
        return true;
      }
    }
  }

  console.groupCollapsed("🧩 anyDoneByTitle → no match");
  console.table(debug);
  console.groupEnd();
  return false;
}



const ALIASES = {
  columns: {
    complete: ["column complete","columns complete","column completed","columns completed"],
    paid:     ["paid column","paid columns"]  // singular + plural
  }
};
// ---------- Title aliases (singular/plural, variants) ----------
const TITLE_ALIASES = {
  columns: {
    complete: [
      "column complete", "columns complete", "columns completed",
      "column completed"
    ],
    paid: [
      "paid column", "paid columns"
    ]
  },

  // Add other trades here as needed:
  // porch: { complete: [...], paid: [...] },
  // screenPorch: { complete: [...], paid: [...] },
  // rails: { complete: [...], paid: [...] },
  // siding: { complete: ["job complete/inspected", "100% job complete", ...],
  //           paid: ["paid siding sub", "siding paid"] },
};

// ---------- Core unpaid-finished detector ----------
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
  if (colFinished && !colPaid) {
    trades.push("Columns");
  }

  // Defensive: remove Columns if any Paid-row exists (even incomplete)
  if (colPaid) {
    const idx = trades.indexOf("Columns");
    if (idx >= 0) trades.splice(idx, 1);
  }

  return trades;
}

function makeJobKey(rawJob, extraFields = {}){
  // Wrapper so we can keep all key logic in one place.
  // rawJob is whatever is in the job column (e.g., "2 Sugar Creek").
  return getJobKey(rawJob, extraFields);
}

function getJobKey(jobName, extraFields = {}){
  const name = norm(jobName).replace(/\s+/g, " "); // collapse spaces

  // If you have structured fields later, build a composite:
  const lot  = extraFields.lot ? norm(extraFields.lot) : "";
  const addr = extraFields.address ? norm(extraFields.address) : "";

  // Compose a strict key; different numbers (2 vs 22) remain distinct:
  // norm() already lowercases and strips punctuation.
  return [name, lot, addr].filter(Boolean).join(" | ");
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

function hasFinalCompleteDone(records, info){
  return Array.isArray(records) && records.some(({ r }) => {
    const title = info.titleIdx >= 0 ? safeCell(r[info.titleIdx]) : "";
    if (!isFinalCompleteRow(title)) return false;
    const pct   = info.percentCompleteIdx >= 0 ? Number(r[info.percentCompleteIdx]) : NaN;
    const done  = info.completedIdx >= 0 ? isTruthy(r[info.completedIdx]) : false;
    return done === true || (!Number.isNaN(pct) && pct >= 100);
  });
}

