# The brief and the journal

Two files, in a private repository. One is written each morning and read here;
the other is written here and applied there. This document is the contract
between the two — it deliberately carries no real content.

## `today.json` — the brief

Everything is optional except `date`. An empty block does not render.

```jsonc
{
  "date": "2026-01-15",              // LOCAL date. Never toISOString().
  "generated": "2026-01-15T07:35:00+01:00",

  "meta": {
    "summary": "One paragraph: what matters today and in what order.",
    "warnings": ["Anything suppressed, missing or suspicious."]
  },

  // ── vocabulary ────────────────────────────────────────────────────────────
  // The public code has none of its own. These three keys supply all of it.
  "topics": ["alpha", "beta", "gamma"],          // the new-item dropdown
  "topicSlots": { "alpha": 1, "beta": 2 },       // topic → colour slot, 1-9.
                                                 //   omit and a slot is derived
                                                 //   from the name, stably.
  "labels": {
    "title":         "what this dashboard is called",
    "<blockId>":       "the section's visible name",
    "<blockId>.note":  "the small grey note beside it",
    "<blockId>.new":   "placeholder in its new-item form",
    "<blockId>.empty": "what it says when there is nothing"
  },

  // ── content ───────────────────────────────────────────────────────────────
  "calendar": [
    { "time": "09:30", "end": "10:00", "title": "…", "allDay": false,
      "source": "m365",            // badged, so a feed that stopped syncing shows
      "calendar": "…", "location": "…" }
  ],

  "items": [
    { "number": 131,               // the issue number
      "group": "focus",            // which block claims it
      "title": "…",
      "type": "task",              // task | thread | person
      "topic": "alpha",
      "due": "2026-01-15",         // the 📅 Reminder line
      "deadline": "2026-01-29",    // the 📅 Deadline line, informational
      "url": "…",
      "note": "Why this matters TODAY. No note, no item.",
      "subtasks": [ { "number": 132, "title": "…", "due": "…", "url": "…" } ] }
  ],

  "projects": [
    { "title": "…", "topic": "alpha",
      "stage": "…",                // free text, shown as a chip
      "status": "hot",             // hot | steady | stalled — sets the edge colour
      "next": "The single next move. One sentence.",
      "nextDue": "2026-01-16",
      "progress": 80,              // 0-100; omit rather than invent
      "openTasks": 2,
      "lastTouched": "2026-01-14", // drives "nothing logged for N days"
      "url": "…" }
  ],

  "reading": [
    { "id": "stable-id",           // the journal keys decisions on it
      "title": "…", "by": "…", "source": "…",
      "alt": false,                // highlights the source chip
      "date": "2026-01-14", "url": "…", "topic": "beta",
      "why": "What it changes for something that is live right now.",
      "summary": "Optional, collapsed behind 'more'." }
  ],

  "recent": [
    { "date": "2026-01-14", "kind": "done",   // done | log | created
      "title": "…", "note": "…", "url": "…", "number": 129 }
  ],

  "inbox": [
    { "id": "msg-001", "source": "email", "from": "…", "subject": "…",
      "received": "2026-01-15", "note": "…",
      "suggest": "prefilled title", "topic": "beta", "suggestDue": "2026-01-22" }
  ],

  // optional blocks
  "sessions": [                      // one card each; `session` (single) still works
    { "title": "…", "when": "…", "duration": "…", "where": "…", "note": "…",
      "exercises": [ { "name": "…", "prescription": "…",
                       "last": "…", "lastLabel": "last ",   // prefix before `last`
                       "why": "…",                          // small grey line
                       "flag": "…" } ] }                    // warning line
  ],
  "metrics": [ { "name": "…", "value": "…", "delta": "…", "dir": "up" } ],
  "scales":  [ { "id": "s1", "label": "…", "max": 3, "note": "…" } ],

  // daily ticks — journal `checks`
  "checks":  [ { "id": "c1", "label": "…", "note": "…",
                 "done": false,              // already recorded for `date`
                 "streak": "5/7 days" } ],

  // structured log forms — journal `entries`
  "forms": [
    { "id": "f1",                    // [a-z0-9-]; the applier files entries by it
      "label": "…", "note": "…", "add": "button text",
      "fields": [
        { "id": "date", "label": "…", "type": "date" },          // defaults to today
        { "id": "a", "label": "…", "type": "choice", "required": true,
          "options": ["x", "y"] | [ { "value": "x", "label": "…" } ],
          "buttons": 6,               // up to this many render as buttons, else a select
          "default": "x", "wide": true },
        { "id": "b", "label": "…", "type": "text", "keep": true,  // survives Add
          "suggest": ["…"], "placeholder": "…" },
        { "id": "c", "label": "…", "type": "number", "step": "0.5", "unit": "…" }
      ],
      "recent": [ { "id": "entry id", "date": "…", "text": "…" } ] }  // already filed
  ],

  // a file written straight into the data repository (not via the journal)
  "uploads": [ { "id": "u1", "label": "…", "note": "…", "last": "…",
                 "path": "dir/name-{date}.json",   // {date} = local today
                 "accept": ".json", "json": true, "requireKeys": ["k"] } ]
}
```

## `today_changes.json` — the journal

Created empty each morning. The dashboard appends; a workflow applies and
**marks**. Nothing is deleted, so the file reads as a record of the day.

```jsonc
{
  "date": "2026-01-15",
  "updated": "2026-01-15T17:15:00+01:00",

  "changes": {
    "103": { "done": true, "log": "…",
             "applied": { "at": "…", "ops": ["comment", "closed"] } },
    "82":  { "log": "…", "reminder": "2026-01-22" }   // no `applied` = still queued
  },

  "created": [
    { "cid": "c-l8x2-a91k",        // idempotency key: never opens twice
      "title": "…", "topic": "alpha", "due": "…", "deadline": null, "note": "…",
      "parent": "#12",             // optional, makes it a subtask
      "from": "inbox:msg-001",     // or "read:<id>"
      "applied": { "at": "…", "issue": 152, "url": "…" } }
  ],

  "braindump": [ { "id": "b-…", "ts": "…", "kind": "note", "text": "…" } ],
  "inbox":     { "msg-001":  { "status": "task", "cid": "c-…" } },
  "reading":   { "stable-id": { "status": "keep" } },  // keep | task | dismissed
  "readings":  { "s1": 1 },
  "entries":   [ { "id": "e-…", "form": "f1", "date": "…", "ts": "…",
                   "values": { "a": "x", "b": "…" }, "applied": { "at": "…" } } ],
  "checks":    { "c1": { "done": true, "date": "…", "ts": "…" } },   // fresh entry replaces an applied one
  "errors":    [ { "at": "…", "messages": ["…"] } ]    // only if something failed
}
```

### What the applier does

| Entry | Effect |
|---|---|
| `changes[n].log` | comment `**YYYY-MM-DD** — {text}` |
| `changes[n].reminder` / `.deadline` | rewrites that one `📅` line in the body |
| `changes[n].done` | closes the issue |
| `created[]` | opens an issue and marks the entry with its number |
| `braindump[]` | appended verbatim to a markdown file |
| `reading[].keep` | appended to a reading list |
| `readings` | appended to a readings log |
| `entries[]` | one JSON line per entry in `<dir>/<form>.jsonl`, id-deduplicated |
| `checks{}` | one JSON line in `<dir>/checks.jsonl`; the last line per day wins |

## Who writes the brief

Nothing here cares, but the design assumes **one writer**: a script in the data
repository, run by a scheduled workflow and after every journal apply. After a
Save or an upload the dashboard polls for a new `generated` stamp and reloads
itself, so the rebuilt brief shows up without a manual refresh.

Comments and re-dates happen **before** closes, so a closing note is never lost
to a later failure. A failure is recorded in `errors` and the entry stays
unmarked, so a re-run picks it up.

## Two rules that hold the whole thing up

**Only `📅 Reminder:` and `📅 Deadline:` are ever parsed or written.** Dates in
prose are scanned and flagged, never acted on.

**Dates are local, never UTC.** `new Date().toISOString().slice(0,10)` is a bug
in any positive-offset timezone: between local midnight and the offset, it
reports yesterday.
