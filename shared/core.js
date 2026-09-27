/* ─────────────────────────────────────────────────────────────────────────────
   DashCore — shared engine for every dashboard in this repo.

   Adapted from the design of github.com/rfleiro/rfl-ops-dash, with four
   deliberate departures:

     1. LOCAL DATES. The reference computed "today" with toISOString(), which is
        UTC. In Madrid that makes the dashboard think it is still yesterday
        between local midnight and 01:00/02:00. Everything here uses local dates.

     2. APPLIED STATE. The reference cleared the journal when Claude applied it
        in an evening chat. Here a GitHub Action applies the journal seconds
        after Save and marks each entry `applied` instead of deleting it, so a
        card can say "this landed in the issue" rather than "queued somewhere".
        There is no evening ritual.

     3. TYPED SECTION BLOCKS. The reference hardcoded the order and kind of every
        block. Here a manifest lists blocks by `kind`, so a dashboard can mix
        items, projects, reading, recent activity, sessions and metrics in any
        order without touching the engine.

     4. ONE REPO PER DASHBOARD. Settings are namespaced `dash:{id}:*`, so each
        dashboard reads a different private repository.

   This file carries no vocabulary of its own. Section labels, topics, prompts
   and chip colours all come from the brief, so the code can be public while
   what it is used for stays private.

   DATA MODEL — three layers, read in this order
   ─────────────────────────────────────────────
     1. brief      <briefPath>     written each morning by Claude. Read-only here.
     2. journal    <changesPath>   written ONLY by this dashboard; applied by the
                                   Action, which marks entries and never deletes.
     3. local      localStorage    edits not yet pushed to the journal.

   Effective state = brief, overlaid with journal, overlaid with local.

   The dashboard never writes to issues. That single-writer rule is what keeps a
   reload from ever showing a view that contradicts itself, and lets edits made
   on a phone and a laptop merge instead of clobbering each other.
   ───────────────────────────────────────────────────────────────────────────── */
"use strict";

window.DashCore = (function(){

const API   = "https://api.github.com";
const BUILD = "20260927-1900";

let M        = null;     // manifest
let REPO     = "";
let TOKEN    = "";
let view     = "boot";   // setup | loading | ready | error
let errMsg   = "";
let BRIEF    = null;
let J        = null;     // journal (server state)
let J_SHA    = null;     // journal file sha; null when the file doesn't exist
let S        = null;     // local, unpushed
let panels   = {};
let bdPanels = {};
let showNF   = null;   // id of the section whose new-task form is open
let saving   = false;
let saveRes  = null;
let lastLoad = null;
let hideSettled = true;
let COLL     = {};
let WDISM    = {};
let subForms = {};
let watchT   = [];       // timers polling for the Action's applied marks
let REBUILD  = "";       // "" | "asked" | "denied" | "failed" — a stale brief's rebuild
let FDRAFT   = {};       // log-form drafts, in memory: {formId: {fieldId: value}}
let upState  = {};       // upload status per upload id
let FORMSEL  = null;     // which log form is open

// ── dates, in local time ─────────────────────────────────────────────────────
// Never toISOString(): that is UTC, and Madrid is UTC+1/+2. Using it makes the
// first hour or two after local midnight report yesterday's date.
function localDate(d){
  d = d || new Date();
  const p = n => String(n).padStart(2,"0");
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate());
}
function localStamp(d){
  d = d || new Date();
  const p = n => String(n).padStart(2,"0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return localDate(d) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
       + sign + p(Math.floor(Math.abs(off)/60)) + ":" + p(Math.abs(off)%60);
}
let TODAY = localDate();

// ── storage, namespaced per dashboard ────────────────────────────────────────
function K(s){ return "dash:" + M.id + ":" + s; }
function ls(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }

// ── icons ────────────────────────────────────────────────────────────────────
const IC = {
  check:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  msg:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  cal:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  ext:`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  x:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  plus:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  warn:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  refresh:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  up:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  eye:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
  ok:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  bad:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  load:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  back:`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  star:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  starOn:`<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  edit:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  chevDown:`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  chevRight:`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  book:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  dot:`<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>`
};

// ── helpers ──────────────────────────────────────────────────────────────────
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function dc(d){ if(!d) return ""; if(d<TODAY) return "overdue"; if(d===TODAY) return "today"; return ""; }
function fd(d){ if(!d) return ""; const p=String(d).split("-"); return p[2]+"/"+p[1]; }
function hhmm(d){ return d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}); }
// Topic chips are styled by class, not inline hex, so they follow the theme.
// The engine carries no vocabulary of its own: a chip's colour is a numbered
// slot, assigned by the brief if it says so and otherwise derived from the
// label itself, which keeps colours stable without naming anything here.
// A "a:b" topic collapses to "a", so variants of one thing share a colour and
// the label carries the distinction.
const SLOTS = 9;
function tslot(base){
  const map = (BRIEF && BRIEF.topicSlots) || {};
  if(map[base]) return map[base];
  let h = 0;
  for(let i=0;i<base.length;i++) h = (h*31 + base.charCodeAt(i)) >>> 0;
  return (h % SLOTS) + 1;
}
function tclass(t){
  if(!t) return "t0";
  const base = String(t).split(":")[0].toLowerCase().replace(/[^a-z0-9]+/g,"-");
  return "t" + tslot(base);
}
function ttag(t){ if(!t) return ""; return "<span class='tag "+tclass(t)+"'>"+esc(t)+"</span>"; }
// Topics, section labels and prompts all come from the brief when it supplies
// them. The manifest holds neutral fallbacks so the page still works before the
// first brief exists.
function topics(){ return (BRIEF && BRIEF.topics) || M.topics || []; }
function txt(key, dflt){
  const t = (BRIEF && BRIEF.labels) || {};
  return (t[key] === undefined || t[key] === null) ? dflt : t[key];
}
function uid(p){ return p + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,7); }
function emptyJournal(date){
  return {date:date, updated:null, changes:{}, created:[], braindump:[], inbox:{}, reading:{}, readings:{},
          entries:[], checks:{}};
}
// How many days ago, in whole local days. Used to age the "recent" block.
function daysAgo(d){
  if(!d) return null;
  const a = new Date(TODAY + "T00:00:00"), b = new Date(String(d).slice(0,10) + "T00:00:00");
  return Math.round((a - b) / 86400000);
}
function relDay(d){
  const n = daysAgo(d);
  if(n === null) return "";
  if(n === 0) return "today";
  if(n === 1) return "yesterday";
  if(n < 7)   return new Date(String(d).slice(0,10)+"T00:00:00").toLocaleDateString("en-GB",{weekday:"long"});
  return fd(d);
}

// ── local layer ──────────────────────────────────────────────────────────────
function emptyLocal(){ return {ch:{}, nt:[], rm:[], bd:[], bdrm:[], ib:{}, pp:{}, rd:{}, en:[], enrm:[], ck:{}}; }
function localKey(){ return K("local:" + (BRIEF ? BRIEF.date : "none")); }
function loadLocal(){
  try{ S = JSON.parse(ls(localKey())) || {}; }catch(e){ S = {}; }
  S = Object.assign(emptyLocal(), S);
}
function saveLocal(){ lsSet(localKey(), JSON.stringify(S)); }

// ── effective state: journal overlaid with local ─────────────────────────────
const FIELDS = ["done","log","reminder","deadline"];
function jch(n){ return (J && J.changes[String(n)]) || {}; }
function lch(n){ return S.ch[String(n)] || {}; }
// An entry the Action has already written to the issue. Its fields are now part
// of reality, so they still display — but they must never be re-sent.
function isApplied(e){ return !!(e && e.applied); }
function eff(n){
  const out = Object.assign({}, jch(n));
  delete out.applied;
  const l = lch(n);
  FIELDS.forEach(function(f){
    if(!(f in l)) return;
    const v = l[f];
    if(v === false || v === null || v === "") delete out[f];
    else out[f] = v;
  });
  return out;
}

// ── stars: dashboard-only, and only for today ────────────────────────────────
// Deliberately not part of the journal and never written to the issues. A star
// says "this is what I'm on right now", which is a statement about today, so it
// lives in localStorage under the brief's date and starts empty each morning.
let STAR = {};
function starKey(){ return K("star:" + (BRIEF ? BRIEF.date : "none")); }
function loadStars(){ try{ STAR = JSON.parse(ls(starKey())) || {}; }catch(e){ STAR = {}; } }
function isStarred(n){ return !!STAR[String(n)]; }
function toggleStar(n){
  const k = String(n);
  if(STAR[k]) delete STAR[k]; else STAR[k] = true;
  lsSet(starKey(), JSON.stringify(STAR));
  render();
}

// ── inbox / reading: brief-borne items with no issue number ─────────────────
// The journal records only the decision taken about them.
function jDecide(bag,id){ return (J && J[bag] && J[bag][id]) || null; }
function lDecide(bag,id){ return (id in S[bag]) ? S[bag][id] : undefined; }
function effDecide(bag,lbag,id){
  const l = lDecide(lbag,id);
  if(l === undefined) return jDecide(bag,id);
  return (l === null) ? null : l;        // explicit null = undo the decision
}
function effIb(id){ return effDecide("inbox","ib",id); }
function effRead(id){ return effDecide("reading","pp",id); }
function inboxItems(){ return (BRIEF && BRIEF.inbox)  || []; }
function readingItems(){ return (BRIEF && BRIEF.reading) || []; }

function effBraindump(){
  const fromJ = (J ? J.braindump : []).filter(b => S.bdrm.indexOf(b.id) === -1)
                                      .map(b => Object.assign({}, b, {queued:true}));
  const fromL = S.bd.map(b => Object.assign({}, b, {queued:false}));
  return fromJ.concat(fromL).sort((a,b) => String(b.ts).localeCompare(String(a.ts)));
}
function effCreated(){
  const fromJ = (J ? J.created : []).filter(c => S.rm.indexOf(c.cid) === -1)
                                    .map(c => Object.assign({}, c, {queued:true}));
  const fromL = S.nt.map(c => Object.assign({}, c, {queued:false}));
  return fromJ.concat(fromL);
}

// ── counting what is where ───────────────────────────────────────────────────
// Unpushed edits sitting in localStorage on this device.
function localCount(){
  let n = 0;
  Object.keys(S.ch).forEach(function(k){
    const j = jch(k), l = S.ch[k];
    FIELDS.forEach(function(f){
      if(!(f in l)) return;
      const v = l[f], had = (f in j);
      if(v === false || v === null || v === ""){ if(had) n++; }
      else if(j[f] !== v) n++;
    });
  });
  ["ib","pp"].forEach(function(lbag){
    const bag = lbag === "ib" ? "inbox" : "reading";
    Object.keys(S[lbag]).forEach(function(id){
      const l = S[lbag][id], j = jDecide(bag,id);
      if(l === null){ if(j) n++; }
      else if(!j || j.status !== l.status) n++;
    });
  });
  n += Object.keys(S.rd).length;
  Object.keys(S.ck).forEach(function(id){ if(S.ck[id] !== baseCheck(id)) n++; });
  return n + S.nt.length + S.rm.length + S.bd.length + S.bdrm.length + S.en.length + S.enrm.length;
}
// In the journal, written but not yet applied to the issues by the Action.
function queuedCount(){
  if(!J) return 0;
  let n = 0;
  Object.keys(J.changes).forEach(function(k){
    const e = J.changes[k];
    if(isApplied(e)) return;
    n += Object.keys(e).filter(f => FIELDS.indexOf(f) >= 0).length;
  });
  n += J.created.length   - J.created.filter(isApplied).length;
  n += J.braindump.length - J.braindump.filter(isApplied).length;
  n += J.entries.length   - J.entries.filter(isApplied).length;
  Object.keys(J.checks).forEach(function(id){ if(!isApplied(J.checks[id])) n++; });
  ["inbox","reading"].forEach(function(bag){
    Object.keys(J[bag]||{}).forEach(function(id){ if(!isApplied(J[bag][id])) n++; });
  });
  return n;
}
// Already written to the issues by the Action.
function appliedCount(){
  if(!J) return 0;
  let n = 0;
  Object.keys(J.changes).forEach(k => { if(isApplied(J.changes[k])) n++; });
  n += J.created.filter(isApplied).length;
  n += J.braindump.filter(isApplied).length;
  n += J.entries.filter(isApplied).length;
  Object.keys(J.checks).forEach(function(id){ if(isApplied(J.checks[id])) n++; });
  ["inbox","reading"].forEach(function(bag){
    Object.keys(J[bag]||{}).forEach(function(id){ if(isApplied(J[bag][id])) n++; });
  });
  return n;
}
function setCh(n,p){
  const key = String(n);
  S.ch[key] = Object.assign({}, lch(key), p);
  saveLocal(); render();
}

// ── settled / collapsed / dismissed ──────────────────────────────────────────
function isSettled(item){ const c = eff(item.number); return !!(c.done || c.reminder); }
function settledCount(){ return BRIEF ? (BRIEF.items||[]).filter(isSettled).length : 0; }
function toggleHide(){
  hideSettled = !hideSettled;
  lsSet(K("hide"), hideSettled ? "1" : "0");
  render();
}
function collKey(){ return K("coll"); }
function loadColl(){ try{ COLL = JSON.parse(ls(collKey())) || {}; }catch(e){ COLL = {}; } }
function isCollapsed(id){ return !!COLL[id]; }
function isSubCollapsed(n){ return !COLL["sub-"+n]; }
function toggleSection(id){ COLL[id] = !COLL[id]; lsSet(collKey(), JSON.stringify(COLL)); render(); }
function wdismKey(){ return K("wdism:"+(BRIEF?BRIEF.date:"none")); }
function loadWdism(){ try{ WDISM = JSON.parse(ls(wdismKey())) || {}; }catch(e){ WDISM = {}; } }
function dismissWarn(i){ WDISM[i]=true; lsSet(wdismKey(),JSON.stringify(WDISM)); render(); }
function secChev(id){
  return "<button class='sec-chev' onclick='DashCore.toggleSection(\""+id+"\")' title='"
    + (isCollapsed(id)?"Expand":"Collapse") + "'>" + (isCollapsed(id)?IC.chevRight:IC.chevDown) + "</button>";
}
function secId(label){ return "sec-" + String(label).toLowerCase().replace(/[^a-z0-9]+/g,"-"); }

// ── GitHub API ───────────────────────────────────────────────────────────────
async function api(path, method, body){
  const h = {
    "Authorization":"Bearer " + TOKEN,
    "Accept":"application/vnd.github+json",
    "X-GitHub-Api-Version":"2022-11-28"
  };
  if(body) h["Content-Type"] = "application/json";
  let r;
  try{
    r = await fetch(API + path, {method:method||"GET", headers:h,
                                body: body?JSON.stringify(body):undefined, cache:"no-store"});
  }catch(e){ throw new Error("Can't reach GitHub. Check your connection."); }
  if(!r.ok){
    let msg = String(r.status);
    try{ const j = await r.json(); if(j && j.message) msg += " · " + j.message; }catch(e){}
    if(r.status===401) msg = "401 · Token invalid or revoked.";
    if(r.status===404) msg = "404 · Not found. Check the configured repo and that the token has access to it.";
    if(r.status===403) msg += " · Insufficient permissions, or rate limited.";
    if(r.status===409 || r.status===422)
      msg = String(r.status) + " · Conflict — the journal changed underneath. Reload and try again.";
    throw new Error(msg);
  }
  return r.status===204 ? null : r.json();
}
function b64utf8(b64){
  const bin = atob(String(b64).replace(/\s/g,""));
  const b = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) b[i]=bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(b);
}
function utf8b64(str){
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ── load ─────────────────────────────────────────────────────────────────────
async function fetchJournal(){
  try{
    const f = await api("/repos/"+REPO+"/contents/"+M.changesPath+"?ref=HEAD&t="+Date.now());
    J_SHA = f.sha;
    const p = JSON.parse(b64utf8(f.content));
    p.changes = p.changes || {}; p.created  = p.created  || [];
    p.braindump = p.braindump || {}; p.inbox = p.inbox || {};
    p.braindump = Array.isArray(p.braindump) ? p.braindump : [];
    p.reading = p.reading || {}; p.readings = p.readings || {};
    p.entries = Array.isArray(p.entries) ? p.entries : []; p.checks = p.checks || {};
    // A journal left over from an earlier day is not ours — start clean.
    J = (p.date === BRIEF.date) ? p : emptyJournal(BRIEF.date);
  }catch(e){
    if(String(e.message).indexOf("404") === 0){ J = emptyJournal(BRIEF.date); J_SHA = null; }
    else throw e;
  }
}
async function loadBrief(){
  if(!TOKEN || !REPO){ view="setup"; render(); return; }
  TODAY = localDate();
  view="loading"; render();
  try{
    const f = await api("/repos/"+REPO+"/contents/"+M.briefPath+"?ref=HEAD&t="+Date.now());
    BRIEF = JSON.parse(b64utf8(f.content));
    BRIEF.items    = BRIEF.items    || [];
    BRIEF.calendar = BRIEF.calendar || [];
    BRIEF.projects = BRIEF.projects || [];
    BRIEF.reading   = BRIEF.reading   || [];
    BRIEF.recent   = BRIEF.recent   || [];
    BRIEF.inbox    = BRIEF.inbox    || [];
    BRIEF.meta     = BRIEF.meta     || {};
    BRIEF.meta.warnings = BRIEF.meta.warnings || [];
    await fetchJournal();
    loadLocal(); loadStars(); loadColl(); loadWdism();
    lastLoad = new Date();
    document.title = txt("title", M.title);
    view="ready";
    if(BRIEF.date >= TODAY) REBUILD = "";
  }catch(e){
    errMsg = e.message || String(e);
    view="error";
  }
  render();
  if(view === "ready") rebuildStale(false);
}

// ── push local edits into the journal ────────────────────────────────────────
function mergeLocalInto(j){
  Object.keys(S.ch).forEach(function(key){
    const src = S.ch[key];
    // An applied entry has already landed in the issue. Starting a fresh entry
    // beside it is what lets you re-open something the Action just closed.
    const prev = j.changes[key] || {};
    const dst  = isApplied(prev) ? {} : Object.assign({}, prev);
    delete dst.applied;
    FIELDS.forEach(function(f){
      if(!(f in src)) return;
      const v = src[f];
      if(v === false || v === null || v === "") delete dst[f];
      else dst[f] = v;
    });
    if(Object.keys(dst).length) j.changes[key] = dst;
    else if(!isApplied(prev)) delete j.changes[key];
  });
  j.created = j.created.filter(c => S.rm.indexOf(c.cid) === -1 || isApplied(c));
  S.nt.forEach(function(t){ if(!j.created.some(c => c.cid === t.cid)) j.created.push(t); });

  j.braindump = (j.braindump||[]).filter(b => S.bdrm.indexOf(b.id) === -1 || isApplied(b));
  S.bd.forEach(function(b){ if(!j.braindump.some(x => x.id === b.id)) j.braindump.push(b); });
  j.braindump.sort((a,b) => String(a.ts).localeCompare(String(b.ts)));

  [["ib","inbox"],["pp","reading"]].forEach(function(pair){
    const lbag = pair[0], bag = pair[1];
    j[bag] = j[bag] || {};
    Object.keys(S[lbag]).forEach(function(id){
      const l = S[lbag][id];
      if(l === null){ if(!isApplied(j[bag][id])) delete j[bag][id]; }
      else j[bag][id] = l;
    });
  });
  j.readings = Object.assign({}, j.readings||{}, S.rd);

  j.entries = (j.entries||[]).filter(e => S.enrm.indexOf(e.id) === -1 || isApplied(e));
  S.en.forEach(function(e){ if(!j.entries.some(x => x.id === e.id)) j.entries.push(e); });
  j.checks = j.checks || {};
  Object.keys(S.ck).forEach(function(id){
    const prev = j.checks[id];
    if(prev && !!prev.done === S.ck[id] && prev.date === TODAY) return;
    // A fresh entry beside an applied one is how an applied tick is undone.
    j.checks[id] = {done:S.ck[id], date:TODAY, ts:localStamp()};
  });
  j.date = BRIEF.date;
  j.updated = localStamp();
  return j;
}

async function push(){
  if(saving) return;
  if(!localCount()) return;
  saving = true; saveRes = null; openModal(); renderModal();
  try{
    // Re-read first, so a concurrent edit from another device isn't clobbered
    // and so entries the Action applied in the meantime are respected.
    await fetchJournal();
    const merged = mergeLocalInto(J);
    const body = {
      message: M.id + ": journal " + BRIEF.date,
      content: utf8b64(JSON.stringify(merged, null, 2) + "\n")
    };
    if(J_SHA) body.sha = J_SHA;
    const res = await api("/repos/"+REPO+"/contents/"+M.changesPath, "PUT", body);
    J_SHA = res.content.sha;
    J = merged;
    S = emptyLocal();
    saveLocal();
    saveRes = {ok:true, queued:queuedCount()};
    watchForApply();
  }catch(e){
    saveRes = {ok:false, error: e.message || String(e)};
  }
  saving = false; renderModal(); render();
}

// The Action usually lands within ~30s of the push. Re-read the journal a few
// times so the "queued" chips turn into "applied" without a manual reload.
function watchForApply(){
  watchT.forEach(clearTimeout); watchT = [];
  [8000, 20000, 40000, 70000].forEach(function(ms){
    watchT.push(setTimeout(async function(){
      if(view !== "ready" || saving || localCount()) return;
      try{
        const before = appliedCount();
        await fetchJournal();
        if(appliedCount() !== before){
          if(await briefChanged()) loadBrief(); else render();
        }
      }catch(e){ /* a failed poll is not worth surfacing */ }
    }, ms));
  });
}

// A scheduled workflow can run hours late (GitHub queues cron jobs behind
// everything else), so a brief from yesterday is rebuilt on demand: the
// manifest names the workflow and this page dispatches it — at most once every
// ten minutes per device — then waits for the new brief. Needs a token with
// Actions: read and write; without it the page says so and carries on.
async function rebuildStale(force){
  if(!M.rebuild || !BRIEF || BRIEF.date >= TODAY) return;
  const key = K("rebuilt"), last = Number(ls(key) || 0);
  if(!force && Date.now() - last < 600000){ REBUILD = REBUILD || "asked"; watchBrief(); return; }
  try{
    await api("/repos/"+REPO+"/actions/workflows/"+encodeURIComponent(M.rebuild)+"/dispatches", "POST", {ref:"main"});
    lsSet(key, String(Date.now()));
    REBUILD = "asked";
    watchBrief();
  }catch(e){
    REBUILD = /^(403|404)/.test(e.message||"") ? "denied" : "failed";
  }
  render();
}

// The brief is rebuilt by a workflow whenever the data under it changes, so a
// save or an upload is followed, a minute later, by a new brief.
async function briefChanged(){
  try{
    const f = await api("/repos/"+REPO+"/contents/"+M.briefPath+"?ref=HEAD&t="+Date.now());
    const b = JSON.parse(b64utf8(f.content));
    return !!BRIEF && (b.generated !== BRIEF.generated || b.date !== BRIEF.date);
  }catch(e){ return false; }
}
function watchBrief(){
  [30000, 60000, 100000, 160000].forEach(function(ms){
    watchT.push(setTimeout(async function(){
      if(view !== "ready" || saving) return;
      if(await briefChanged()) loadBrief();
    }, ms));
  });
}

/* ─── actions ─────────────────────────────────────────────────────────────── */

// ── new tasks ────────────────────────────────────────────────────────────────
function addTask(){
  const el = document.getElementById("nt-t");
  const title = el ? el.value.trim() : "";
  if(!title){ document.getElementById("nt-err").textContent = "Title is required."; return; }
  S.nt.push({
    cid:      uid("c"),
    title:    title,
    topic:    document.getElementById("nt-tp").value,
    due:      document.getElementById("nt-d").value  || null,
    deadline: document.getElementById("nt-dl").value || null,
    note:     document.getElementById("nt-n").value.trim() || null
  });
  showNF = null; saveLocal(); render();
}
function addSubtask(n){
  const el = document.getElementById("sf-"+n);
  const title = el ? el.value.trim() : "";
  if(!title) return;
  const par = BRIEF ? BRIEF.items.find(i => i.number === n) : null;
  S.nt.push({ cid:uid("c"), title:title, topic:(par?par.topic:(M.topics[0]||"admin")),
              due:null, parent:"#"+n });
  subForms[n] = false;
  saveLocal(); render();
}
function toggleSubForm(n){ subForms[n] = !subForms[n]; render(); }
function rmTask(c){
  const i = S.nt.findIndex(t => t.cid === c);
  if(i >= 0) S.nt.splice(i,1);
  else if(S.rm.indexOf(c) === -1) S.rm.push(c);   // already in the journal — mark for removal
  saveLocal(); render();
}
// Editing an item that is already in the journal: pull a copy down into the
// local layer and mark the journal copy for removal, so the merge replaces it.
function ensureNtLocal(cid_val, mutate){
  const i = S.nt.findIndex(t => t.cid === cid_val);
  if(i >= 0){ mutate(S.nt[i]); return; }
  const q = J ? J.created.find(c => c.cid === cid_val) : null;
  if(q && !isApplied(q)){
    const copy = Object.assign({}, q);
    mutate(copy);
    if(S.rm.indexOf(cid_val) === -1) S.rm.push(cid_val);
    S.nt.push(copy);
  }
}
function toggleNtP(cid_val, w){
  const key = "nt-" + cid_val, cur = panels[key] || {};
  panels[key] = {log:false, date:false}; panels[key][w] = !cur[w];
  render();
}
function saveNtLog(cid_val){
  const el = document.getElementById("nlt-" + cid_val);
  const v = el ? el.value.trim() : "";
  if(v) ensureNtLocal(cid_val, t => { t.log = v; });
  panels["nt-" + cid_val] = {}; saveLocal(); render();
}
function saveNtDate(cid_val){
  const rv = (document.getElementById("ndt-" + cid_val)||{value:""}).value;
  const dv = (document.getElementById("ndl-" + cid_val)||{value:""}).value;
  ensureNtLocal(cid_val, t => { if(rv) t.due = rv; if(dv) t.deadline = dv; });
  panels["nt-" + cid_val] = {}; saveLocal(); render();
}
function toggleStarNt(cid_val){
  if(STAR[cid_val]) delete STAR[cid_val]; else STAR[cid_val] = true;
  lsSet(starKey(), JSON.stringify(STAR)); render();
}
function toggleNtDone(cid_val){ ensureNtLocal(cid_val, t => { t.done = !t.done; }); saveLocal(); render(); }

// ── inbox ────────────────────────────────────────────────────────────────────
function dismissInbox(id){
  const cur = effIb(id);
  S.ib[id] = (cur && cur.status === "dismissed") ? null
           : {status:"dismissed", ts:localStamp()};
  saveLocal(); render();
}
function toggleIB(id){ const c = panels["ib-"+id] || {}; panels["ib-"+id] = {open: !c.open}; render(); }
function convertInbox(id){
  const t = document.getElementById("ib-t-"+id);
  const title = t ? t.value.trim() : "";
  if(!title){ document.getElementById("ib-err-"+id).textContent = "Title is required."; return; }
  const c = uid("c");
  S.nt.push({
    cid:c, title:title,
    topic: document.getElementById("ib-tp-"+id).value,
    due:   document.getElementById("ib-d-"+id).value || null,
    note:  document.getElementById("ib-n-"+id).value.trim() || null,
    from:  "inbox:" + id
  });
  S.ib[id] = {status:"task", cid:c, ts:localStamp()};
  panels["ib-"+id] = {}; saveLocal(); render();
}

// ── reading ──────────────────────────────────────────────────────────────────
// Three outcomes, and they are genuinely different: keep it for the reading
// list, turn it into a task because it needs real work, or let it go.
function keepRead(id){
  const cur = effRead(id);
  S.pp[id] = (cur && cur.status === "keep") ? null : {status:"keep", ts:localStamp()};
  saveLocal(); render();
}
function dismissRead(id){
  const cur = effRead(id);
  S.pp[id] = (cur && cur.status === "dismissed") ? null : {status:"dismissed", ts:localStamp()};
  saveLocal(); render();
}
function togglePP(id){ const c = panels["pp-"+id] || {}; panels["pp-"+id] = {open: !c.open}; render(); }
function toggleAbs(id){ const c = panels["abs-"+id] || {}; panels["abs-"+id] = {open: !c.open}; render(); }
function readToTask(id){
  const p = readingItems().find(x => String(x.id) === String(id));
  const el = document.getElementById("pp-t-"+id);
  const title = el ? el.value.trim() : (p ? "Read — " + p.title : "");
  if(!title){ document.getElementById("pp-err-"+id).textContent = "Title is required."; return; }
  const c = uid("c");
  S.nt.push({
    cid:c, title:title,
    topic: document.getElementById("pp-tp-"+id).value,
    due:   document.getElementById("pp-d-"+id).value || null,
    note:  (p && p.url) ? p.url : null,
    from:  "read:" + id
  });
  S.pp[id] = {status:"task", cid:c, ts:localStamp()};
  panels["pp-"+id] = {}; saveLocal(); render();
}

// ── braindump ────────────────────────────────────────────────────────────────
function addBraindump(){
  const ta = document.getElementById("bd-t");
  const text = ta ? ta.value.trim() : "";
  if(!text){ document.getElementById("bd-err").textContent = "Nothing to add."; return; }
  const kindEl = document.getElementById("bd-k");
  S.bd.push({ id:uid("b"), ts:localStamp(), kind:(kindEl?kindEl.value:"note"), text:text });
  saveLocal(); render();
}
function rmBraindump(id){
  const i = S.bd.findIndex(b => b.id === id);
  if(i >= 0) S.bd.splice(i,1);
  else if(S.bdrm.indexOf(id) === -1) S.bdrm.push(id);
  saveLocal(); render();
}
function toggleBDExpand(id){
  bdPanels[id] = Object.assign({}, bdPanels[id]||{}, {expanded: !((bdPanels[id]||{}).expanded)});
  render();
}
function toggleBDEdit(id){ const c = bdPanels[id] || {}; bdPanels[id] = {editing: !c.editing}; render(); }
function saveBDEdit(id){
  const el = document.getElementById("bdet-" + id);
  const v  = el ? el.value.trim() : "";
  if(v){
    const i = S.bd.findIndex(b => b.id === id);
    if(i >= 0) S.bd[i].text = v;
    else {
      const q = J ? J.braindump.find(b => b.id === id) : null;
      if(q && !isApplied(q)){
        const copy = Object.assign({}, q, {text:v});
        if(S.bdrm.indexOf(id) === -1) S.bdrm.push(id);
        S.bd.push(copy);
      }
    }
    saveLocal();
  }
  bdPanels[id] = {}; render();
}

// ── readings: a daily 0-N scale, whatever the brief defines ──────────────────
function setReading(id, v){
  const cur = (S.rd[id] !== undefined) ? S.rd[id] : ((J && J.readings) ? J.readings[id] : undefined);
  if(cur === v) delete S.rd[id]; else S.rd[id] = v;
  saveLocal(); render();
}
function effReading(id){
  if(S.rd[id] !== undefined) return S.rd[id];
  return (J && J.readings) ? J.readings[id] : undefined;
}

// ── daily checks: done today or not ──────────────────────────────────────────
// The brief says what the files already hold for today (`done`); the journal
// and the local layer say what has been ticked since. Keyed by the LOCAL date,
// so a stale brief never files a tick under yesterday.
function checkItems(){ return (BRIEF && BRIEF.checks) || []; }
function baseCheck(id){
  const j = J && J.checks ? J.checks[id] : null;
  if(j && j.date === TODAY) return !!j.done;
  const b = checkItems().find(c => String(c.id) === String(id));
  return !!(b && b.done && BRIEF.date === TODAY);
}
function effCheck(id){ return (id in S.ck) ? S.ck[id] : baseCheck(id); }
function toggleCheck(id){
  const v = !effCheck(id);
  if(v === baseCheck(id)) delete S.ck[id]; else S.ck[id] = v;
  saveLocal(); render();
}

// ── log forms: structured entries, defined entirely by the brief ─────────────
function formDefs(){ return (BRIEF && BRIEF.forms) || []; }
function formDef(fid){ return formDefs().find(f => f.id === fid); }
function draft(fid){
  if(!FDRAFT[fid]){
    const f = formDef(fid) || {fields:[]}, d = {};
    (f.fields||[]).forEach(function(x){ if(x.default !== undefined) d[x.id] = x.default; });
    FDRAFT[fid] = d;
  }
  return FDRAFT[fid];
}
// Pull whatever has been typed into the draft, so a re-render keeps it.
function readForm(fid){
  const f = formDef(fid); if(!f) return;
  const d = draft(fid);
  (f.fields||[]).forEach(function(x){
    // Button choices live in the draft already; a long list is a <select>.
    const el = document.getElementById("ff-"+fid+"-"+x.id);
    if(el) d[x.id] = el.value;
  });
}
function pickChoice(fid, field, val){
  readForm(fid);
  const d = draft(fid);
  d[field] = (d[field] === val) ? "" : val;
  render();
}
function addEntry(fid){
  readForm(fid);
  const f = formDef(fid), d = draft(fid), values = {};
  let missing = [];
  (f.fields||[]).forEach(function(x){
    const v = (d[x.id] === undefined || d[x.id] === null) ? "" : String(d[x.id]).trim();
    if(x.type === "date") return;
    if(v) values[x.id] = (x.type === "number") ? Number(v) : v;
    else if(x.required) missing.push(x.label || x.id);
  });
  const el = document.getElementById("ff-err-"+fid);
  if(missing.length){ if(el) el.textContent = "Missing: " + missing.join(", "); return; }
  const df = (f.fields||[]).find(x => x.type === "date");
  const date = (df && d[df.id]) || TODAY;
  S.en.push({id:uid("e"), form:fid, date:date, ts:localStamp(), values:values});
  // Keep the choices (the next entry is usually the same kind, same place);
  // clear what is typed per entry.
  (f.fields||[]).forEach(function(x){
    if(x.type === "date") return;
    if(x.type === "choice"){ if(x.keep === false) d[x.id] = (x.default !== undefined) ? x.default : ""; }
    else if(!x.keep) d[x.id] = "";
  });
  saveLocal(); render();
}
function rmEntry(id){
  const i = S.en.findIndex(e => e.id === id);
  if(i >= 0) S.en.splice(i,1);
  else if(S.enrm.indexOf(id) === -1) S.enrm.push(id);
  saveLocal(); render();
}
function effEntries(fid){
  const fromJ = (J ? J.entries : []).filter(e => e.form === fid && S.enrm.indexOf(e.id) === -1)
                                    .map(e => Object.assign({}, e, {queued:true}));
  const fromL = S.en.filter(e => e.form === fid).map(e => Object.assign({}, e, {queued:false}));
  return fromJ.concat(fromL).sort((a,b) => String(b.ts).localeCompare(String(a.ts)));
}
function entryText(f, e){
  return (f.fields||[]).filter(x => x.type !== "date" && e.values[x.id] !== undefined && e.values[x.id] !== "")
    .map(x => String(e.values[x.id]) + (x.unit ? " " + x.unit : "")).join(" · ");
}

// ── uploads: a file straight into the data repository ────────────────────────
// Not a journal entry: it is a whole new file with one writer, and the brief
// is rebuilt from it by the workflow a minute later.
function uploadDefs(){ return (BRIEF && BRIEF.uploads) || []; }
async function doUpload(uid_){
  const u = uploadDefs().find(x => x.id === uid_); if(!u) return;
  const inp = document.getElementById("up-"+uid_);
  const file = inp && inp.files && inp.files[0];
  if(!file){ upState[uid_] = {err:"Choose a file first."}; render(); return; }
  upState[uid_] = {busy:true}; render();
  try{
    const text = await file.text();
    if(u.json){
      let obj;
      try{ obj = JSON.parse(text); }catch(e){ throw new Error("Not valid JSON."); }
      (u.requireKeys||[]).forEach(function(k){ if(!(k in obj)) throw new Error("Missing key: " + k); });
    }
    const path = String(u.path).replace("{date}", TODAY);
    let sha = null;
    try{ sha = (await api("/repos/"+REPO+"/contents/"+path+"?ref=HEAD&t="+Date.now())).sha; }
    catch(e){ if(String(e.message).indexOf("404") !== 0) throw e; }
    const body = {message: M.id + ": upload " + path, content: utf8b64(text)};
    if(sha) body.sha = sha;
    await api("/repos/"+REPO+"/contents/"+path, "PUT", body);
    upState[uid_] = {ok:path};
    watchT.forEach(clearTimeout); watchT = [];
    watchBrief();
  }catch(e){ upState[uid_] = {err: e.message || String(e)}; }
  render();
}

// ── issue panels ─────────────────────────────────────────────────────────────
function toggleP(n,w){
  const cur = panels[n] || {};
  panels[n] = {log:false, date:false}; panels[n][w] = !cur[w];
  render();
}
function saveLog(n){
  const v = document.getElementById("lt-"+n).value.trim();
  panels[n] = {}; setCh(n,{log: v || false});
}
function saveDate(n){
  const rv = document.getElementById("dt-"+n).value;
  const dv = document.getElementById("dl-"+n).value;
  panels[n] = {}; setCh(n,{reminder: rv || false, deadline: dv || false});
}

// ── config ───────────────────────────────────────────────────────────────────
function saveConfig(){
  const rp = document.getElementById("rp").value.trim()
    .replace(/^https?:\/\/github\.com\//,"").replace(/\.git$/,"").replace(/\/+$/,"");
  const tk = document.getElementById("tk").value.trim();
  const e  = document.getElementById("tk-err");
  if(!/^[\w.-]+\/[\w.-]+$/.test(rp)){ e.textContent = "Repository format: owner/name"; return; }
  if(!tk){ e.textContent = "Paste the token."; return; }
  REPO = rp; TOKEN = tk;
  lsSet(K("repo"),rp); lsSet(K("pat"),tk);
  loadBrief();
}
function resetConfig(){
  if(!confirm("Clear the saved repository and token for “"+M.id+"” on this device?")) return;
  REPO=""; TOKEN=""; lsDel(K("repo")); lsDel(K("pat"));
  view="setup"; render();
}

// ── modal ────────────────────────────────────────────────────────────────────
function openModal(){ document.getElementById("overlay").classList.add("open"); }
function closeModal(){
  if(saving) return;
  document.getElementById("overlay").classList.remove("open");
  saveRes = null; if(BRIEF) render();
}
function renderModal(){
  const m = document.getElementById("modal");
  if(saving){
    m.innerHTML = "<h2>Saving…</h2><p>Writing your changes to the journal.</p>"
      + "<div class='load'><span class='spin'>"+IC.load+"</span></div>";
    return;
  }
  if(!saveRes){ m.innerHTML = ""; return; }
  if(saveRes.ok){
    m.innerHTML = "<h2>"+IC.ok+" Saved</h2>"
      + "<p>"+saveRes.queued+" change"+(saveRes.queued===1?"":"s")+" written to the journal. "
      + "The apply workflow picks them up automatically — usually within a minute — and the "
      + "cards here switch from <b>queued</b> to <b>applied</b> on their own.</p>"
      + "<div class='mbtns'><button class='btn btn-p' onclick='DashCore.closeModal()'>Close</button></div>";
  } else {
    m.innerHTML = "<h2>"+IC.bad+" Couldn't save</h2><div class='ebox'>"+esc(saveRes.error)+"</div>"
      + "<p>Your edits are still held on this device, so nothing is lost. Try again, or reload "
      + "first if you have been editing from another device.</p>"
      + "<div class='mbtns'><button class='btn' onclick='DashCore.closeModal()'>Close</button>"
      + "<button class='btn btn-p' onclick='DashCore.push()'>Retry</button></div>";
  }
}

/* ─── rendering ───────────────────────────────────────────────────────────── */

// ── an issue card ────────────────────────────────────────────────────────────
function card(item){
  const n = item.number, c = eff(n), l = lch(n), p = panels[n] || {};
  const dd = c.reminder || item.reminder || item.due, dcs = dc(dd), done = !!c.done;
  const ddl = c.deadline || item.deadline;
  const isTask = item.type === "task", isPerson = item.type === "person";
  const dlabel = isPerson ? M.dateField.person : M.dateField.default;
  const applied = isApplied(jch(n));
  // Is any part of this card's state still only on this device?
  const unsaved = FIELDS.some(function(f){
    if(!(f in l)) return false;
    const v = l[f], j = jch(n);
    return (v===false||v===null||v==="") ? (f in j) : (j[f] !== v);
  });
  const star = isStarred(n);

  const subHtml = (function(){
    const pendingSubs = effCreated().filter(t => t.parent === "#"+n);
    const confirmed   = item.subtasks || [];
    const hasSubs     = confirmed.length > 0 || pendingSubs.length > 0;
    const showForm    = !!subForms[n];
    // A person is a standing thread, not a piece of work: offering to break one
    // into subtasks is noise on every card in the People column.
    if(isPerson && !hasSubs) return "";
    if(!hasSubs && !showForm)
      return "<button class='sub-trigger' onclick='DashCore.toggleSubForm("+n+")'>"+IC.plus+" subtask</button>";
    const subId  = "sub-"+n, subCol = isSubCollapsed(n);
    const total  = confirmed.length + pendingSubs.length;
    const doneN  = confirmed.filter(s => eff(s.number).done).length;
    let h = "<div class='sub-hdr'>";
    h += hasSubs
      ? "<span class='sub-label' onclick='DashCore.toggleSection(\""+subId+"\")'>"
        + total + " subtask" + (total!==1?"s":"") + (doneN ? " · "+doneN+" done" : "") + "</span>"
      : "<span class='sub-label'>Add subtask</span>";
    h += "<div class='sec-r'>"
      + "<button class='sec-add' onclick='event.stopPropagation();DashCore.toggleSubForm("+n+")'>"+IC.plus+" subtask</button>"
      + (hasSubs ? "<span onclick='event.stopPropagation();DashCore.toggleSection(\""+subId+"\")' style='display:flex;align-items:center;cursor:pointer'>"
                   + (subCol?IC.chevRight:IC.chevDown) + "</span>" : "")
      + "</div></div>";
    if(showForm){
      h += "<div class='sub-form'>"
        + "<input id='sf-"+n+"' type='text' placeholder='Subtask title…' onkeydown='if(event.key===\"Enter\")DashCore.addSubtask("+n+")'>"
        + "<div class='sf-btns'><button class='btn btn-p' onclick='DashCore.addSubtask("+n+")'>Add</button>"
        + "<button class='btn' onclick='DashCore.toggleSubForm("+n+")'>Cancel</button></div></div>";
    }
    if(hasSubs && !subCol){
      h += "<div class='sub-list'>";
      confirmed.forEach(function(s){
        const sc = eff(s.number), sdone = !!sc.done, sdd = sc.reminder || s.due;
        h += "<div class='sub-item"+(sdone?" done":"")+"'>"
          + "<button class='act"+(sdone?" on-green":"")+"' onclick='event.stopPropagation();DashCore.setCh("+s.number+",{done:"+(!sdone)+"})' title='"+(sdone?"Undo":"Done")+"'>"+IC.check+"</button>"
          + "<span class='sub-title"+(sdone?" struck":"")+"'>"+esc(s.title)+"</span>"
          + (sdd ? "<span class='chip "+dc(sdd)+"'>"+fd(sdd)+"</span>" : "")
          + (s.url ? "<a class='act' href='"+esc(s.url)+"' target='_blank' rel='noopener' title='GitHub'>"+IC.ext+"</a>" : "")
          + "</div>";
      });
      pendingSubs.forEach(function(t){
        h += "<div class='sub-item isnew'><span class='sub-title'>"+esc(t.title)+"</span>"
          + "<span class='chip "+(t.applied?"applied":"new")+"'>"+(t.applied?"created":"new")+"</span>"
          + (t.applied ? "" : "<button class='act rm' onclick='event.stopPropagation();DashCore.rmTask(\""+esc(t.cid)+"\")' title='Remove'>"+IC.x+"</button>")
          + "</div>";
      });
      h += "</div>";
    }
    return h;
  })();

  return "<div class='card "+dcs+(done?" done":"")+(star?" starred":"")+(applied?" applied":"")+"'>"
    + "<div class='card-row'><span class='card-title"+(done?" struck":"")+"'>"+esc(item.title)+"</span><div class='acts'>"
    + "<button class='act"+(star?" on-star":"")+"' onclick='DashCore.toggleStar("+n+")' title='"+(star?"Unstar":"Star — what I'm on right now")+"'>"+(star?IC.starOn:IC.star)+"</button>"
    + (isTask?"<button class='act"+(done?" on-green":"")+"' onclick='DashCore.setCh("+n+",{done:"+(!done)+"})' title='"+(done?"Undo":"Done")+"'>"+IC.check+"</button>":"")
    + "<button class='act"+(p.log?" on":"")+(c.log&&!p.log?" on-green":"")+"' onclick='DashCore.toggleP("+n+",\"log\")' title='Log a note'>"+IC.msg+"</button>"
    + "<button class='act"+(p.date?" on":"")+"' onclick='DashCore.toggleP("+n+",\"date\")' title='"+esc(dlabel)+"'>"+IC.cal+"</button>"
    + (item.url?"<a class='act' href='"+esc(item.url)+"' target='_blank' rel='noopener' title='GitHub'>"+IC.ext+"</a>":"")
    + "</div></div><div class='card-meta'>" + ttag(item.topic)
    + (dd?"<span class='chip "+dcs+"'>"+(dcs==="overdue"?"overdue · ":"")+fd(dd)+(c.reminder?" ✓":"")+"</span>":"")
    + (ddl?"<span class='chip dl "+dc(ddl)+"'>deadline "+fd(ddl)+(c.deadline?" ✓":"")+"</span>":"")
    + (c.log?"<span class='chip logged'>"+IC.msg+" note</span>":"")
    + (unsaved ? "<span class='chip unsaved'>unsaved</span>"
               : applied ? "<span class='chip applied'>applied</span>"
               : (Object.keys(c).length ? "<span class='chip queued'>queued</span>" : ""))
    + "</div>"
    + (item.note?"<div class='cnote'>"+esc(item.note)+"</div>":"")
    + subHtml
    + (p.log?"<div class='panel'><textarea id='lt-"+n+"' placeholder='Note…'>"+esc(c.log||"")+"</textarea>"
       + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleP("+n+",\"log\")'>Cancel</button>"
       + "<button class='btn btn-p' onclick='DashCore.saveLog("+n+")'>Save</button></div></div>":"")
    + (p.date?"<div class='panel'><div class='grid' style='display:grid;grid-template-columns:1fr 1fr;gap:8px'>"
       + "<div class='field'><label>"+esc(dlabel)+"</label><input type='date' id='dt-"+n+"' value='"+(dd||"")+"'></div>"
       + "<div class='field'><label>Deadline</label><input type='date' id='dl-"+n+"' value='"+(ddl||"")+"'></div></div>"
       + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleP("+n+",\"date\")'>Cancel</button>"
       + "<button class='btn btn-p' onclick='DashCore.saveDate("+n+")'>Set</button></div></div>":"")
    + "</div>";
}

// ── a queued/created task that has no issue number yet ───────────────────────
function newCard(t){
  const p = panels["nt-"+t.cid] || {}, dcs = dc(t.due);
  const done = !!t.done, star = !!STAR[t.cid], applied = isApplied(t);
  return "<div class='card isnew"+(dcs?" "+dcs:"")+(done?" done":"")+(star?" starred":"")+(applied?" applied":"")+"'>"
    + "<div class='card-row'><span class='card-title"+(done?" struck":"")+"'>"+esc(t.title)+"</span><div class='acts'>"
    + "<button class='act"+(star?" on-star":"")+"' onclick='DashCore.toggleStarNt(\""+esc(t.cid)+"\")' title='"+(star?"Unstar":"Star")+"'>"+(star?IC.starOn:IC.star)+"</button>"
    + (applied?"":"<button class='act"+(done?" on-green":"")+"' onclick='DashCore.toggleNtDone(\""+esc(t.cid)+"\")' title='"+(done?"Undo":"Done")+"'>"+IC.check+"</button>"
    + "<button class='act"+(p.log?" on":"")+(t.log&&!p.log?" on-green":"")+"' onclick='DashCore.toggleNtP(\""+esc(t.cid)+"\",\"log\")' title='Log'>"+IC.msg+"</button>"
    + "<button class='act"+(p.date?" on":"")+"' onclick='DashCore.toggleNtP(\""+esc(t.cid)+"\",\"date\")' title='Reminder'>"+IC.cal+"</button>"
    + "<button class='act rm' onclick='DashCore.rmTask(\""+esc(t.cid)+"\")' title='Remove'>"+IC.x+"</button>")
    + (applied && t.applied.url ? "<a class='act' href='"+esc(t.applied.url)+"' target='_blank' rel='noopener' title='GitHub'>"+IC.ext+"</a>" : "")
    + "</div></div>"
    + "<div class='card-meta'>" + ttag(t.topic) + ""
    + (t.due?"<span class='chip "+dcs+"'>"+fd(t.due)+"</span>":"")
    + (t.deadline?"<span class='chip dl "+dc(t.deadline)+"'>deadline "+fd(t.deadline)+"</span>":"")
    + (t.log?"<span class='chip logged'>"+IC.msg+" note</span>":"")
    + (done&&!applied?"<span class='chip logged'>done — will create + close</span>":"")
    + (applied ? "<span class='chip applied'>created"+(t.applied.issue?" #"+t.applied.issue:"")+"</span>"
               : (t.queued ? "<span class='chip queued'>queued</span>" : "<span class='chip unsaved'>unsaved</span>"))
    + "</div>"
    + (t.note?"<div class='cnote'>"+esc(t.note)+"</div>":"")
    + (p.log?"<div class='panel'><textarea id='nlt-"+esc(t.cid)+"' placeholder='Note…'>"+esc(t.log||"")+"</textarea>"
       + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleNtP(\""+esc(t.cid)+"\",\"log\")'>Cancel</button>"
       + "<button class='btn btn-p' onclick='DashCore.saveNtLog(\""+esc(t.cid)+"\")'>Save</button></div></div>":"")
    + (p.date?"<div class='panel'><div class='grid' style='display:grid;grid-template-columns:1fr 1fr;gap:8px'>"
       + "<div class='field'><label>Reminder</label><input type='date' id='ndt-"+esc(t.cid)+"' value='"+(t.due||"")+"'></div>"
       + "<div class='field'><label>Deadline</label><input type='date' id='ndl-"+esc(t.cid)+"' value='"+(t.deadline||"")+"'></div></div>"
       + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleNtP(\""+esc(t.cid)+"\",\"date\")'>Cancel</button>"
       + "<button class='btn btn-p' onclick='DashCore.saveNtDate(\""+esc(t.cid)+"\")'>Set</button></div></div>":"")
    + "</div>";
}

// ── projects: the long view ──────────────────────────────────────────────────
// Not a to-do list. One line per project saying where it stands and what the
// single next move is, so a week of no progress on something is visible.
function projectBlock(p){
  const quiet = daysAgo(p.lastTouched);
  const cls = p.status === "stalled" ? "stalled" : (p.status === "hot" ? "hot" : "");
  const pct = (typeof p.progress === "number") ? Math.max(0, Math.min(100, p.progress)) : null;
  return "<div class='pj "+cls+"'>"
    + "<div class='pj-row'><span class='pj-title'>"
    + (p.url ? "<a href='"+esc(p.url)+"' target='_blank' rel='noopener' style='color:inherit;text-decoration:none'>"+esc(p.title)+"</a>" : esc(p.title))
    + "</span>"
    + (p.stage ? "<span class='pj-stage'>"+esc(p.stage)+"</span>" : "")
    + "</div>"
    + (p.next ? "<div class='pj-next'><b>Next:</b> "+esc(p.next)+"</div>" : "")
    + (pct !== null ? "<div class='pj-bar'><i style='width:"+pct+"%'></i></div>" : "")
    + "<div class='pj-meta'>"
    + ttag(p.topic)
    + (p.nextDue ? "<span class='chip "+dc(p.nextDue)+"'>"+(dc(p.nextDue)==="overdue"?"overdue · ":"")+fd(p.nextDue)+"</span>" : "")
    + (p.openTasks ? "<span class='chip'>"+p.openTasks+" open</span>" : "")
    + "</div>"
    + (quiet !== null && quiet >= 7
        ? "<div class='pj-quiet'>Nothing logged for "+quiet+" days.</div>"
        : (p.note ? "<div class='pj-quiet'>"+esc(p.note)+"</div>" : ""))
    + "</div>";
}

// ── reading ──────────────────────────────────────────────────────────────────
function readingBlock(x){
  const id = String(x.id);
  const st = effRead(id), l = lDecide("pp",id);
  const unsaved = (l !== undefined) && (l === null ? !!jDecide("reading",id)
                                                   : (!jDecide("reading",id) || jDecide("reading",id).status !== l.status));
  const applied = isApplied(jDecide("reading",id)) && l === undefined;
  const p    = panels["pp-"+id]  || {};
  const abs  = panels["abs-"+id] || {};
  const kept = st && st.status === "keep";
  const gone = st && st.status === "dismissed";
  const task = st && st.status === "task";
  return "<div class='pp"+(kept?" kept":"")+(gone?" dismissed":"")+"'>"
    + "<div class='pp-row'><span class='pp-title'>"
    + (x.url ? "<a href='"+esc(x.url)+"' target='_blank' rel='noopener' style='color:inherit;text-decoration:none'>"+esc(x.title)+"</a>" : esc(x.title))
    + "</span><div class='acts'>"
    + "<button class='act"+(kept?" on-green":"")+"' onclick='DashCore.keepRead(\""+esc(id)+"\")' title='"+(kept?"Remove from the list":"Keep")+"'>"+IC.book+"</button>"
    + "<button class='act"+(p.open?" on":"")+(task?" on-green":"")+"' onclick='DashCore.togglePP(\""+esc(id)+"\")' title='Turn into a task'>"+IC.plus+"</button>"
    + "<button class='act"+(gone?" on":"")+"' onclick='DashCore.dismissRead(\""+esc(id)+"\")' title='"+(gone?"Undo":"Not for me")+"'>"+IC.x+"</button>"
    + (x.url?"<a class='act' href='"+esc(x.url)+"' target='_blank' rel='noopener' title='Open'>"+IC.ext+"</a>":"")
    + "</div></div>"
    + (x.by?"<div class='pp-authors'>"+esc(x.by)+"</div>":"")
    + "<div class='pp-meta'>"
    + (x.source?"<span class='pp-src"+(x.alt?" alt":"")+"'>"+esc(x.source)+"</span>":"")
    + (x.date?"<span class='chip'>"+esc(String(x.date).slice(0,10).split("-").reverse().slice(0,2).join("/"))+"</span>":"")
    + ttag(x.topic)
    + (task?"<span class='chip logged'>→ task</span>":"")
    + (kept?"<span class='chip logged'>reading list</span>":"")
    + (unsaved ? "<span class='chip unsaved'>unsaved</span>"
               : applied ? "<span class='chip applied'>applied</span>"
               : (st ? "<span class='chip queued'>queued</span>" : ""))
    + "</div>"
    + (x.why?"<div class='pp-why'>"+esc(x.why)+"</div>":"")
    + (x.summary
        ? "<div class='pj-quiet' style='cursor:pointer' onclick='DashCore.toggleAbs(\""+esc(id)+"\")'>"
          + (abs.open ? "less" : "more") + "</div>"
          + (abs.open ? "<div class='pp-abs'>"+esc(x.summary)+"</div>" : "")
        : "")
    + (p.open?"<div class='panel'>"
        + "<div class='field'><label>Task title</label><input id='pp-t-"+esc(id)+"' type='text' value='"+esc("Read — "+x.title)+"'></div>"
        + "<div class='grid' style='display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0'>"
        + "<div class='field'><label>Topic</label><select id='pp-tp-"+esc(id)+"'>"
        + (topics()).map(t=>"<option"+(t===(x.topic||"")?" selected":"")+">"+esc(t)+"</option>").join("")+"</select></div>"
        + "<div class='field'><label>Reminder</label><input id='pp-d-"+esc(id)+"' type='date' value='"+TODAY+"'></div></div>"
        + "<p class='err' id='pp-err-"+esc(id)+"'></p>"
        + "<div class='pbtns'><button class='btn' onclick='DashCore.togglePP(\""+esc(id)+"\")'>Cancel</button>"
        + "<button class='btn btn-p' onclick='DashCore.readToTask(\""+esc(id)+"\")'>Create task</button></div></div>":"")
    + "</div>";
}

// ── recently done ────────────────────────────────────────────────────────────
// Grouped by day, newest first. Answers "what have I actually been doing",
// which is the question a week of head-down work makes impossible to answer.
function recentBlock(rows){
  if(!rows.length) return "<div class='rc-empty'>Nothing logged in the last few days.</div>";
  const byDay = {};
  rows.forEach(function(r){ (byDay[r.date] = byDay[r.date] || []).push(r); });
  return Object.keys(byDay).sort().reverse().map(function(d){
    return "<div class='rc-day'>"+esc(relDay(d))+"</div>"
      + byDay[d].map(function(r){
          return "<div class='rc'>"
            + "<span class='rc-ic"+(r.kind==="done"?" done":"")+"'>"+(r.kind==="done"?IC.check:IC.dot)+"</span>"
            + "<div class='rc-t'>"
            + (r.url ? "<a href='"+esc(r.url)+"' target='_blank' rel='noopener'>"+esc(r.title)+"</a>" : esc(r.title))
            + (r.note ? "<div class='rc-note'>"+esc(r.note)+"</div>" : "")
            + "</div></div>";
        }).join("");
  }).join("");
}

// ── session, metrics, and a daily scale ──────────────────────────────────────
function sessionBlock(s){
  if(!s) return "<div class='rc-empty'>No session planned for today.</div>";
  return "<div class='ses"+(s.kind?" k-"+esc(s.kind):"")+"'>"
    + "<div class='ses-t'>"+esc(s.title)+"</div>"
    + "<div class='ses-sub'>"+esc([s.when, s.duration, s.where].filter(Boolean).join(" · "))+"</div>"
    + (s.note?"<div class='cnote'>"+esc(s.note)+"</div>":"")
    + (s.exercises||[]).map(function(e){
        return "<div class='ex'><div class='ex-top'><span class='ex-n'>"+esc(e.name)+"</span>"
          + (e.prescription?"<span class='ex-p'>"+esc(e.prescription)+"</span>":"")
          + "</div>"
          + (e.last?"<div class='ex-last'>"+esc(e.lastLabel===undefined?"last ":e.lastLabel)+esc(e.last)+"</div>":"")
          + (e.why?"<div class='ex-why'>"+esc(e.why)+"</div>":"")
          + (e.flag?"<div class='ex-flag'>"+IC.warn+"<span>"+esc(e.flag)+"</span></div>":"")
          + "</div>";
      }).join("")
    + "</div>";
}
function metricsBlock(rows){
  if(!rows.length) return "<div class='rc-empty'>No metrics in this brief.</div>";
  return "<div class='pj'>" + rows.map(function(m){
    return "<div class='mtr'><span class='mtr-n'>"+esc(m.name)+"</span>"
      + "<span class='mtr-v'>"+esc(m.value)+"</span>"
      + (m.delta?"<span class='mtr-d "+esc(m.dir||"")+"'>"+esc(m.delta)+"</span>":"")
      + "</div>";
  }).join("") + "</div>";
}
function scaleBlock(sc){
  const cur = effReading(sc.id);
  const max = sc.max || 3;
  let btns = "";
  for(let i=0;i<=max;i++){
    btns += "<button class='"+(cur===i?"on":"")+"' onclick='DashCore.setReading(\""+esc(sc.id)+"\","+i+")'>"+i+"</button>";
  }
  return "<div class='pj'><div class='pj-row'><span class='pj-title'>"+esc(sc.label)+"</span>"
    + (cur!==undefined?"<span class='pj-stage'>logged</span>":"")+"</div>"
    + (sc.note?"<div class='pj-quiet'>"+esc(sc.note)+"</div>":"")
    + "<div class='scale'>"+btns+"</div></div>";
}

function checksBlock(list){
  return "<div class='pj'>" + list.map(function(c){
    const on = effCheck(c.id), l = (c.id in S.ck);
    const j = J && J.checks ? J.checks[c.id] : null;
    const st = l ? "<span class='chip unsaved'>unsaved</span>"
             : (j && j.date === TODAY) ? (isApplied(j) ? "<span class='chip applied'>applied</span>" : "<span class='chip queued'>queued</span>")
             : "";
    return "<div class='ck"+(on?" on":"")+"' onclick='DashCore.toggleCheck(\""+esc(c.id)+"\")'>"
      + "<span class='ck-box'>"+(on?IC.check:"")+"</span>"
      + "<div class='ck-t'><div class='ck-l'>"+esc(c.label)+" "+st+"</div>"
      + (c.note?"<div class='ck-n'>"+esc(c.note)+"</div>":"")
      + "</div>"
      + (c.streak?"<span class='ck-s'>"+esc(c.streak)+"</span>":"")
      + "</div>";
  }).join("") + "</div>";
}

function formBlock(f){
  const d = draft(f.id);
  let h = "<div class='lf'><div class='lf-t'>"+esc(f.label||f.id)+"</div>"
        + (f.note?"<div class='pj-quiet'>"+esc(f.note)+"</div>":"")
        + "<div class='lf-fields'>";
  (f.fields||[]).forEach(function(x){
    const id = "ff-"+f.id+"-"+x.id, v = (d[x.id] === undefined || d[x.id] === null) ? "" : String(d[x.id]);
    h += "<div class='lf-f"+(x.wide?" wide":"")+"'><label>"+esc(x.label||x.id)+(x.required?"":" <i>optional</i>")+"</label>";
    if(x.type === "choice"){
      const opts = x.options || [];
      if(opts.length <= (x.buttons || 6)){
        h += "<div class='seg'>" + opts.map(function(o){
          const val = (typeof o === "object") ? o.value : o, lab = (typeof o === "object") ? (o.label||o.value) : o;
          return "<button class='"+(v===String(val)?"on":"")+"' onclick='DashCore.pickChoice(\""+esc(f.id)+"\",\""+esc(x.id)+"\",\""+esc(val)+"\")'>"+esc(lab)+"</button>";
        }).join("") + "</div>";
      } else {
        h += "<select id='"+id+"' onchange='DashCore.readForm(\""+esc(f.id)+"\")'><option value=''>—</option>"
          + opts.map(function(o){
              const val = (typeof o === "object") ? o.value : o, lab = (typeof o === "object") ? (o.label||o.value) : o;
              return "<option value='"+esc(val)+"'"+(v===String(val)?" selected":"")+">"+esc(lab)+"</option>";
            }).join("") + "</select>";
      }
    } else if(x.type === "date"){
      h += "<input id='"+id+"' type='date' value='"+esc(v||TODAY)+"'>";
    } else if(x.type === "number"){
      h += "<input id='"+id+"' type='number' inputmode='decimal' step='"+esc(x.step||"any")+"' value='"+esc(v)+"' placeholder='"+esc(x.placeholder||"")+"'>";
    } else {
      const dl = (x.suggest||[]).length ? "dl-"+f.id+"-"+x.id : "";
      h += "<input id='"+id+"' type='text' value='"+esc(v)+"' placeholder='"+esc(x.placeholder||"")+"'"+(dl?" list='"+dl+"'":"")+">"
        + (dl ? "<datalist id='"+dl+"'>"+x.suggest.map(o=>"<option value='"+esc(o)+"'>").join("")+"</datalist>" : "");
    }
    h += "</div>";
  });
  h += "</div><div class='pbtns'><span class='err' id='ff-err-"+esc(f.id)+"'></span>"
     + "<button class='btn btn-p' onclick='DashCore.addEntry(\""+esc(f.id)+"\")'>"+IC.plus+" "+esc(f.add||"Add")+"</button></div>";
  const mine = effEntries(f.id), seen = {};
  mine.forEach(e => seen[e.id] = true);
  if(mine.length){
    h += "<div class='lf-list'>" + mine.map(function(e){
      const applied = isApplied(e);
      return "<div class='lf-row'><span class='lf-d'>"+esc(relDay(e.date))+"</span><span class='lf-x'>"+esc(entryText(f,e))+"</span>"
        + (applied ? "<span class='chip applied'>applied</span>"
                   : (e.queued ? "<span class='chip queued'>queued</span>" : "<span class='chip unsaved'>unsaved</span>"))
        + (applied ? "" : "<button class='act rm' onclick='DashCore.rmEntry(\""+esc(e.id)+"\")' title='Remove'>"+IC.x+"</button>")
        + "</div>";
    }).join("") + "</div>";
  }
  const hist = (f.recent||[]).filter(r => !seen[r.id]);
  if(hist.length){
    h += "<div class='lf-list past'>" + hist.map(function(r){
      return "<div class='lf-row'><span class='lf-d'>"+esc(relDay(r.date))+"</span><span class='lf-x'>"+esc(r.text)+"</span></div>";
    }).join("") + "</div>";
  }
  return h + "</div>";
}

function uploadBlock(u){
  const st = upState[u.id] || {};
  return "<div class='pj'><div class='pj-row'><span class='pj-title'>"+esc(u.label||u.id)+"</span>"
    + (u.last?"<span class='pj-stage'>"+esc(u.last)+"</span>":"")+"</div>"
    + (u.note?"<div class='pj-quiet'>"+esc(u.note)+"</div>":"")
    + "<div class='up'><input id='up-"+esc(u.id)+"' type='file' accept='"+esc(u.accept||"")+"'>"
    + "<button class='btn btn-p' "+(st.busy?"disabled":"")+" onclick='DashCore.doUpload(\""+esc(u.id)+"\")'>"+(st.busy?IC.load:IC.up)+" Upload</button></div>"
    + (st.err?"<p class='err'>"+esc(st.err)+"</p>":"")
    + (st.ok?"<div class='pj-quiet'>"+IC.ok+" Saved as "+esc(st.ok)+". The page reloads itself when the rebuilt brief lands (about a minute).</div>":"")
    + "</div>";
}

// ── section wrapper ──────────────────────────────────────────────────────────
function section(label, bodyFn, opts){
  opts = opts || {};
  const id = secId(label), col = isCollapsed(id);
  let h = "<div class='sec"+(opts.cls?" "+opts.cls:"")+"'><div class='sec-hdr'>"
        + "<span class='sec-label'>"+esc(label)+"</span><div class='sec-r'>"
        + (opts.note ? "<span class='sec-note'>"+esc(opts.note)+"</span>" : "")
        + (opts.add  ? opts.add : "")
        + secChev(id) + "</div></div>";
  if(!col) h += bodyFn();
  h += "</div>";
  return h;
}

// ── the week strip ───────────────────────────────────────────────────────────
// Seven cells, one per day, straight from `BRIEF.week`. The brief decides what a
// day holds and whether it happened (`done`: true / false / null); this only
// draws it. `extra` marks something done that the plan did not ask for.
function weekStrip(week){
  return "<div class='week' role='list' aria-label='"+esc(txt("week","Week"))+"'>" + week.map(function(w){
    const day = String(w.date||"").split("-")[2] || "";
    return "<div class='wk-day"+(w.today?" today":"")+"' role='listitem'>"
      + "<div class='wk-h'><span class='wk-n'>"+esc(w.day||"")+"</span><span class='wk-d'>"+esc(day.replace(/^0/,""))+"</span></div>"
      + "<div class='wk-its'>" + (w.items||[]).map(function(it){
          const st = it.done === true ? " done" : it.done === false ? " missed" : "";
          return "<div class='wk-it tag "+tclass(it.topic)+st+(it.extra?" extra":"")+"'"
            + (it.done === false ? " title='not logged'" : it.extra ? " title='not in the plan'" : "")+">"
            + (it.done === true ? IC.check : "") + "<span>"+esc(it.text||"")+"</span></div>";
        }).join("") + "</div>"
      + "</div>";
  }).join("") + "</div>";
}

// ── the calendar strip ───────────────────────────────────────────────────────
function calendarBlock(cal){
  const now = hhmm(new Date());
  return "<div class='cal-list'>" + cal.map(function(e){
    const past    = !e.allDay && e.end && e.end < now;
    const current = !e.allDay && e.time && e.end && e.time <= now && e.end >= now;
    const src     = String(e.source||"").toLowerCase();
    return "<div class='cal-row"+(current?" now":"")+(past?" past":"")+"'>"
      + "<span class='cal-time'>"+(e.allDay?"":esc(e.time))+"</span>"
      + "<span class='cal-ev'>"+esc(e.title)
      + (e.location?"<span class='cal-loc'> · "+esc(e.location)+"</span>":"")
      + "</span>"
      + (e.allDay?"<span class='cal-ad'>all day</span>":"")
      + (src?"<span class='cal-src "+esc(src)+"'>"+esc(e.calendar||src)+"</span>":"")
      + "</div>";
  }).join("") + "</div>";
}

// A block claims the items whose `group` matches its id. The brief decides what
// goes in which group, so no block here needs to know what the groups mean.
// `filter` in a manifest still wins, for a dashboard that wants to be explicit.
function itemPicker(b){
  if(b.filter) return b.filter;
  return i => String(i.group || "") === b.id;
}
function newPicker(b){
  if(b.newFilter) return b.newFilter;
  return t => String(t.group || b.defaultGroup || b.id) === b.id;
}

// ── one manifest block → html ────────────────────────────────────────────────
function renderBlock(b){
  const items = BRIEF.items;
  // The visible name of a block comes from the brief when it supplies one.
  const L = txt(b.id, b.label);

  if(b.kind === "items"){
    const all    = items.filter(itemPicker(b));
    const hidden = hideSettled ? all.filter(isSettled) : [];
    let   list   = hideSettled ? all.filter(i => !isSettled(i)) : all;
    // starred first, original order preserved within each group
    list = list.filter(i => isStarred(i.number)).concat(list.filter(i => !isStarred(i.number)));
    const created = b.allowNew ? effCreated().filter(t => !t.parent && newPicker(b)(t)) : [];
    if(!all.length && !b.allowNew) return "";
    const sid = secId(b.id || b.label);
    const add = b.allowNew
      ? "<button class='sec-add' onclick='event.stopPropagation();DashCore.toggleNew(\""+sid+"\")'>"+IC.plus+" new</button>"
      : "";
    return section(L, function(){
      let h = "";
      if(b.allowNew && showNF === sid){
        h += "<div class='nform'>"
          + "<div class='field'><label>Title</label><input id='nt-t' type='text' placeholder='"+esc(txt(b.id+".new", b.placeholder)||"Title…")+"'></div>"
          + "<div class='grid' style='grid-template-columns:1fr 1fr 1fr'>"
          + "<div class='field'><label>Topic</label><select id='nt-tp'>"
          + (topics()).map(t=>"<option"+(t===b.defaultTopic?" selected":"")+">"+esc(t)+"</option>").join("")+"</select></div>"
          + "<div class='field'><label>Reminder</label><input id='nt-d' type='date' value='"+TODAY+"'></div>"
          + "<div class='field'><label>Deadline</label><input id='nt-dl' type='date'></div></div>"
          + "<div class='field'><label>Note (optional)</label><textarea id='nt-n' placeholder='Context…'></textarea></div>"
          + "<p class='err' id='nt-err'></p>"
          + "<div class='pbtns' style='margin-top:8px'><button class='btn' onclick='DashCore.toggleNew(\""+sid+"\")'>Cancel</button>"
          + "<button class='btn btn-p' onclick='DashCore.addTask()'>Add</button></div></div>";
      }
      h += list.map(card).join("");
      h += created.map(newCard).join("");
      if(!list.length && !created.length && !hidden.length)
        h += "<div class='rc-empty'>"+esc(txt(b.id+".empty", b.empty)||"Nothing here today.")+"</div>";
      if(hidden.length)
        h += "<div class='hidden-row'>"+hidden.length+" hidden until applied"
           + " <button class='lnk' onclick='DashCore.toggleHide()'>show</button></div>";
      return h;
    }, {add:add});
  }

  if(b.kind === "projects"){
    const list = (BRIEF.projects||[]).filter(b.filter || (()=>true));
    if(!list.length) return "";
    return section(L, () => list.map(projectBlock).join(""), {note:txt(b.id+".note", b.note)});
  }

  if(b.kind === "reading"){
    const all  = readingItems();
    if(!all.length) return "";
    const decided = all.filter(x => !!effRead(String(x.id)));
    const list    = hideSettled ? all.filter(x => !effRead(String(x.id))) : all;
    return section(L, function(){
      let h = list.map(readingBlock).join("");
      if(!list.length) h += "<div class='rc-empty'>All triaged.</div>";
      if(hideSettled && decided.length)
        h += "<div class='hidden-row'>"+decided.length+" triaged"
           + " <button class='lnk' onclick='DashCore.toggleHide()'>show</button></div>";
      return h;
    }, {note: txt(b.id+".note", b.note)});
  }

  if(b.kind === "recent"){
    const list = (BRIEF.recent||[]).slice(0, b.limit || 40);
    return section(L, () => recentBlock(list), {note:txt(b.id+".note", b.note)});
  }

  if(b.kind === "inbox"){
    const all = inboxItems();
    if(!all.length) return "";
    const decided = all.filter(x => !!effIb(x.id));
    const list    = hideSettled ? all.filter(x => !effIb(x.id)) : all;
    return section(L, function(){
      let h = list.map(function(x){
        const st = effIb(x.id), l = lDecide("ib",x.id);
        const unsaved = (l !== undefined) && (l === null ? !!jDecide("inbox",x.id)
                        : (!jDecide("inbox",x.id) || jDecide("inbox",x.id).status !== l.status));
        const applied = isApplied(jDecide("inbox",x.id)) && l === undefined;
        const p = panels["ib-"+x.id] || {};
        const gone = st && st.status === "dismissed";
        const task = st && st.status === "task";
        return "<div class='card ib"+(gone?" done":"")+"'>"
          + "<div class='card-row'><span class='card-title"+(gone?" struck":"")+"'>"+esc(x.subject)+"</span><div class='acts'>"
          + "<button class='act"+(p.open?" on":"")+(task?" on-green":"")+"' onclick='DashCore.toggleIB(\""+esc(x.id)+"\")' title='Turn into a task'>"+IC.plus+"</button>"
          + "<button class='act"+(gone?" on":"")+"' onclick='DashCore.dismissInbox(\""+esc(x.id)+"\")' title='"+(gone?"Undo dismiss":"Dismiss")+"'>"+IC.x+"</button>"
          + (x.url?"<a class='act' href='"+esc(x.url)+"' target='_blank' rel='noopener' title='Open message'>"+IC.ext+"</a>":"")
          + "</div></div><div class='card-meta'>"
          + "<span class='chip src'>"+esc(x.source||"email")+"</span>"
          + (x.from?"<span class='chip'>"+esc(x.from)+"</span>":"")
          + (x.received?"<span class='chip'>"+fd(String(x.received).slice(0,10))+"</span>":"")
          + (task?"<span class='chip logged'>→ task</span>":"")
          + (unsaved ? "<span class='chip unsaved'>unsaved</span>"
                     : applied ? "<span class='chip applied'>applied</span>"
                     : (st ? "<span class='chip queued'>queued</span>" : ""))
          + "</div>"
          + (x.note?"<div class='cnote'>"+esc(x.note)+"</div>":"")
          + (p.open?"<div class='panel'>"
              + "<div class='field'><label>Task title</label><input id='ib-t-"+esc(x.id)+"' type='text' value='"+esc(x.suggest||x.subject)+"'></div>"
              + "<div class='grid' style='display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0'>"
              + "<div class='field'><label>Topic</label><select id='ib-tp-"+esc(x.id)+"'>"
              + (topics()).map(t=>"<option"+(t===(x.topic||"")?" selected":"")+">"+esc(t)+"</option>").join("")+"</select></div>"
              + "<div class='field'><label>Reminder</label><input id='ib-d-"+esc(x.id)+"' type='date' value='"+esc(x.suggestDue||TODAY)+"'></div></div>"
              + "<div class='field'><label>Note (optional)</label><textarea id='ib-n-"+esc(x.id)+"'>"+esc(x.note||"")+"</textarea></div>"
              + "<p class='err' id='ib-err-"+esc(x.id)+"'></p>"
              + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleIB(\""+esc(x.id)+"\")'>Cancel</button>"
              + "<button class='btn btn-p' onclick='DashCore.convertInbox(\""+esc(x.id)+"\")'>Create task</button></div></div>":"")
          + "</div>";
      }).join("");
      if(hideSettled && decided.length)
        h += "<div class='hidden-row'>"+decided.length+" handled"
           + " <button class='lnk' onclick='DashCore.toggleHide()'>show</button></div>";
      return h;
    }, {note: txt(b.id+".note", b.note)});
  }

  if(b.kind === "session"){
    const list = BRIEF.sessions || (BRIEF.session ? [BRIEF.session] : []);
    return section(L, () => list.length ? list.map(sessionBlock).join("") : sessionBlock(null),
                   {note:txt(b.id+".note", b.note)});
  }
  if(b.kind === "checks"){
    const list = checkItems();
    if(!list.length) return "";
    return section(L, () => checksBlock(list), {note:txt(b.id+".note", b.note)});
  }
  if(b.kind === "log"){
    const list = formDefs();
    if(!list.length) return "";
    if(!FORMSEL || !list.some(f => f.id === FORMSEL))
      FORMSEL = (BRIEF.defaultForm && list.some(f => f.id === BRIEF.defaultForm)) ? BRIEF.defaultForm : list[0].id;
    return section(L, function(){
      const pending = id => effEntries(id).filter(e => !isApplied(e)).length;
      let h = list.length > 1 ? "<div class='seg lf-tabs'>" + list.map(function(f){
        const n = pending(f.id);
        return "<button class='"+(f.id===FORMSEL?"on":"")+"' onclick='DashCore.pickForm(\""+esc(f.id)+"\")'>"
          + esc(f.label||f.id) + (n ? " · "+n : "") + "</button>";
      }).join("") + "</div>" : "";
      return h + formBlock(list.find(f => f.id === FORMSEL));
    }, {note:txt(b.id+".note", b.note)});
  }
  if(b.kind === "upload"){
    const list = uploadDefs();
    if(!list.length) return "";
    return section(L, () => list.map(uploadBlock).join(""), {note:txt(b.id+".note", b.note)});
  }
  if(b.kind === "metrics")  return section(L, () => metricsBlock(BRIEF.metrics||[]), {note:txt(b.id+".note", b.note)});
  if(b.kind === "scales"){
    const list = BRIEF.scales || [];
    if(!list.length) return "";
    return section(L, () => list.map(scaleBlock).join(""), {note:txt(b.id+".note", b.note)});
  }

  if(b.kind === "braindump"){
    const bd = effBraindump();
    return section(L, function(){
      // Always-on capture box: no click needed before you can start typing.
      let h = "<div class='bd-capture'>"
        + "<textarea id='bd-t' placeholder='"+esc(txt(b.id+".new", b.placeholder)||"Drop a thought…")+"'></textarea>"
        + "<div class='bd-bar'><select id='bd-k'>"
        + (b.kinds || ["note","meeting","idea","decision","result"]).map(k=>"<option value='"+esc(k)+"'>"+esc(k)+"</option>").join("")
        + "</select><span class='err' id='bd-err'></span>"
        + "<button class='btn btn-p' onclick='DashCore.addBraindump()'>"+IC.plus+" Add</button></div></div>";
      if(!bd.length)
        return h + "<div class='bd-empty'>"+esc(txt(b.id+".empty", b.empty)||"Nothing yet today.")+"</div>";
      return h + bd.map(function(x){
        const t = new Date(x.ts), ep = bdPanels[x.id] || {}, applied = isApplied(x);
        return "<div class='bd-item'>"
          + "<div class='bd-head'><span class='bd-ts'>"+esc(isNaN(t)?x.ts:hhmm(t))+"</span>"
          + "<span class='bd-kind bd-"+esc(x.kind||"note")+"'>"+esc(x.kind||"note")+"</span>"
          + (applied ? "<span class='chip applied'>applied</span>"
                     : (x.queued?"<span class='chip queued'>queued</span>":"<span class='chip unsaved'>unsaved</span>"))
          + (applied ? "" :
             "<button class='act"+(ep.editing?" on":"")+"' onclick='DashCore.toggleBDEdit(\""+esc(x.id)+"\")' title='Edit'>"+IC.edit+"</button>"
           + "<button class='act rm' onclick='DashCore.rmBraindump(\""+esc(x.id)+"\")' title='Remove'>"+IC.x+"</button>")
          + "</div>"
          + (ep.editing
              ? "<div class='panel'><textarea id='bdet-"+esc(x.id)+"'>"+esc(x.text)+"</textarea>"
                + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleBDEdit(\""+esc(x.id)+"\")'>Cancel</button>"
                + "<button class='btn btn-p' onclick='DashCore.saveBDEdit(\""+esc(x.id)+"\")'>Save</button></div></div>"
              : "<div class='bd-text"+(ep.expanded?" expanded":"")+"' onclick='DashCore.toggleBDExpand(\""+esc(x.id)+"\")' title='"+(ep.expanded?"Collapse":"Expand")+"'>"
                + esc(x.text).replace(/\n/g,"<br>") + "</div>")
          + "</div>";
      }).join("");
    }, {note: hhmm(new Date()), cls:"bd-sec"});
  }

  return "";
}

// ── the page ─────────────────────────────────────────────────────────────────
function render(){
  const app = document.getElementById("app");

  if(view === "setup"){
    app.innerHTML = "<div class='center'>"
      + "<a class='back' href='../'>"+IC.back+" dashboards</a>"
      + "<h2>"+esc(M.title)+"</h2>"
      + "<p>Enter the data repository and a token with access to it. Both are stored only on "
      + "this device, for this dashboard.</p>"
      + "<div class='steps'><ol>"
      + "<li>Create a token at <a href='https://github.com/settings/personal-access-tokens/new' target='_blank' rel='noopener'>Settings → Developer settings → Fine-grained tokens</a></li>"
      + "<li><b>Repository access</b> → Only select repositories → <code>your data repository</code></li>"
      + "<li><b>Permissions</b> → Contents: <code>Read and write</code>. Nothing else.</li>"
      + "</ol></div>"
      + "<div class='pfield' style='margin-bottom:8px'><label>Data repository</label>"
      + "<input id='rp' type='text' placeholder='"+"owner/repo"+"' autocomplete='off' spellcheck='false'></div>"
      + "<div class='pfield'><label>Token</label>"
      + "<input id='tk' type='password' placeholder='github_pat_…' autocomplete='off' spellcheck='false'></div>"
      + "<p class='err' id='tk-err'></p>"
      + "<div class='pbtns' style='margin-top:10px'><button class='btn btn-p' onclick='DashCore.saveConfig()'>Save and continue</button></div>"
      + "<p class='muted'>This dashboard never writes to your issues — it appends to a change "
      + "journal, which a workflow in your own repository applies. Requests go only to "
      + "api.github.com. No analytics, no third-party scripts.</p></div>";
    ["rp","tk"].forEach(function(id){
      document.getElementById(id).addEventListener("keydown", function(e){ if(e.key==="Enter") saveConfig(); });
    });
    document.getElementById("rp").focus();
    return;
  }

  if(view === "loading"){
    app.innerHTML = "<div class='load'><span class='spin'>"+IC.load+"</span> Loading…</div>";
    return;
  }

  if(view === "error"){
    app.innerHTML = "<div class='center'>"
      + "<a class='back' href='../'>"+IC.back+" dashboards</a>"
      + "<h2>Couldn't load</h2><div class='ebox'>"+esc(errMsg)+"</div>"
      + (errMsg.indexOf("404")===0
          ? "<p>If the repository and token are right, <code>"+esc(M.briefPath)+"</code> may not exist yet — the brief workflow in the data repository has not run.</p>"
          : "")
      + "<div class='pbtns'><button class='lnk' onclick='DashCore.resetConfig()'>Change repository/token</button>"
      + "<button class='btn btn-p' onclick='DashCore.loadBrief()'>Retry</button></div></div>";
    return;
  }

  const meta = BRIEF.meta, cal = BRIEF.calendar;
  const nLocal = localCount(), nQueued = queuedCount(), nApplied = appliedCount(), nSettled = settledCount();

  let h = "<div class='wrap'>";
  h += "<a class='back' href='../'>"+IC.back+" dashboards</a>";
  const heading = txt("title", M.title);
  h += "<div class='hdr'><div><h1>"+esc(heading)+"</h1>"
     + "<div class='hdr-date'>"+esc(new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"}))+"</div></div>"
     + "<div class='hdr-r'>"
     + "<button class='btn btn-icon' onclick='DashCore.loadBrief()' title='Reload'>"+IC.refresh+"</button>"
     + (nSettled ? "<button class='btn btn-icon"+(hideSettled?" on":"")+"' onclick='DashCore.toggleHide()' title='"
         + (hideSettled ? "Show "+nSettled+" settled" : "Hide "+nSettled+" settled") + "'>"
         + (hideSettled?IC.eyeOff:IC.eye)+"</button>" : "")
     + "<button class='btn "+(nLocal?"btn-p pulse":"")+"' onclick='DashCore.push()' "+(nLocal?"":"disabled")+">"
     + IC.up + (nLocal ? " Save ("+nLocal+")" : " Save") + "</button></div></div>";

  if(Array.isArray(BRIEF.week) && BRIEF.week.length) h += weekStrip(BRIEF.week);

  if(BRIEF.date !== TODAY){
    const why = !M.rebuild ? " Check the brief workflow in the data repository."
      : REBUILD === "asked"  ? " Building today's now — it reloads by itself in a minute or two."
      : REBUILD === "denied" ? " Couldn't start the build: the token needs Actions → Read and write."
      : REBUILD === "failed" ? " Couldn't start the build."
      : "";
    h += "<div class='warn'>"+IC.warn+"<span style='flex:1'>This brief is from "+fd(BRIEF.date)+" — today's has not been built yet."+why+"</span>"
       + (M.rebuild && REBUILD !== "asked" ? "<button class='lnk' onclick='DashCore.rebuild()'>build now</button>" : "")
       + "</div>";
  }
  meta.warnings.forEach(function(w,i){
    if(WDISM[i]) return;
    h += "<div class='warn'>"+IC.warn+"<span style='flex:1'>"+esc(w)+"</span>"
       + "<button class='warn-x' onclick='DashCore.dismissWarn("+i+")' title='Dismiss'>"+IC.x+"</button></div>";
  });

  // Summary and calendar sit above the columns: they are the "what is today"
  // answer, and pushing them into a column buries them on a wide screen.
  h += "<div class='topgrid'>";
  if(meta.summary){
    h += section("Brief", () => "<div class='summary'>"+esc(meta.summary)+"</div>");
  }
  if(cal.length){
    h += section("Today", () => calendarBlock(cal));
  }
  h += "</div>";

  h += "<div class='cols'>";
  (M.blocks||[]).forEach(function(b){ h += renderBlock(b); });
  h += "</div>";

  h += "<div class='foot'><span>"+esc(BRIEF.date)+(lastLoad?" · "+hhmm(lastLoad):"")
     + " · <span class='build'>build "+BUILD+"</span>"
     + (nQueued?" · "+nQueued+" queued":"")
     + (nApplied?" · "+nApplied+" applied":"")
     + (nLocal?" · "+nLocal+" unsaved":"") + "</span>"
     + "<button class='lnk' onclick='DashCore.resetConfig()'>change repository/token</button></div></div>";

  app.innerHTML = h;
}

// ── start ────────────────────────────────────────────────────────────────────
function start(manifest){
  M = Object.assign({
    id:"dash", title:"dash",
    briefPath:"brief/today.json", changesPath:"brief/today_changes.json",
    topics:[], blocks:[],
    dateField:{default:"Reminder", person:"Next follow-up"}
  }, manifest);
  S     = emptyLocal();
  REPO  = ls(K("repo")) || "";
  TOKEN = ls(K("pat"))  || "";
  const hv = ls(K("hide"));
  hideSettled = (hv === null) ? true : (hv === "1");
  document.title = M.title;
  document.getElementById("overlay").addEventListener("click", function(e){
    if(e.target.id === "overlay") closeModal();
  });
  // Coming back to a tab left open overnight must not show yesterday's brief.
  document.addEventListener("visibilitychange", function(){
    if(document.hidden || view !== "ready") return;
    if(localDate() !== TODAY){ loadBrief(); return; }
    if(lastLoad && (Date.now() - lastLoad.getTime()) > 600000) loadBrief();
  });
  loadBrief();
}

return {
  start, loadBrief, saveConfig, resetConfig, rebuild:function(){ rebuildStale(true); },
  setCh, toggleP, saveLog, saveDate,
  addTask, rmTask, addSubtask, toggleSubForm, toggleNew:function(id){ showNF = (showNF === id) ? null : id; render(); },
  toggleNtP, saveNtLog, saveNtDate, toggleStarNt, toggleNtDone,
  addBraindump, rmBraindump, toggleBDEdit, saveBDEdit, toggleBDExpand,
  dismissInbox, toggleIB, convertInbox,
  keepRead, dismissRead, togglePP, toggleAbs, readToTask,
  setReading, toggleCheck, pickForm:function(id){ if(FORMSEL) readForm(FORMSEL); FORMSEL = id; render(); }, pickChoice, readForm, addEntry, rmEntry, doUpload,
  toggleStar, push, toggleHide, toggleSection, dismissWarn, closeModal
};
})();
