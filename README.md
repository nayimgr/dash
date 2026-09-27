# ngr-dashboard

Static dashboards. No build step, no backend, no dependencies, no tracking.

## The point

This repository is public so GitHub Pages will serve it for free, so it is
written to be **useless to a reader**. It has the structure of the dashboards and
none of their vocabulary: every visible word — the title of a dashboard, the name
of a section, the list of topics, the prompts, which topic gets which colour —
comes from a brief file in a private repository, at runtime.

What is left here is an engine.

## Layout

    index.html          the launcher
    shared/
      core.js           engine: config, API client, state, sync, rendering
      style.css         design tokens and components
    <id>/
      index.html        one dashboard: its block structure only
    docs/
      BRIEF-SCHEMA.md   the contract between this and the private side

## How it holds together

Three layers, read in this order:

1. **brief** — `today.json`, built in the private repository by a scheduled
   workflow (and rebuilt whenever its data changes). Read-only here.
2. **journal** — `today_changes.json`, written **only** by the dashboard.
3. **local** — `localStorage`, edits not yet pushed to the journal.

Effective state is the brief, overlaid with the journal, overlaid with local.

The dashboard never writes to issues. A workflow in the private repository is the
single writer, which is what keeps a reload from ever showing a view that
contradicts itself, and lets edits from a phone and a laptop merge instead of
clobbering each other. Applied entries are **marked**, never deleted, so a card
can say "this landed" rather than "queued somewhere".

## Blocks

A dashboard is a list of typed blocks. Each has an `id`; a block claims the brief
items whose `group` matches it, and takes its visible name from the brief.

`items` · `projects` · `reading` · `recent` · `inbox` · `braindump` ·
`session` · `metrics` · `scales` · `checks` · `log` · `upload` · `heatmap`

`log` renders whatever forms the brief defines, `checks` whatever daily ticks it
defines, and `upload` writes a chosen file to a path the brief names — so a new
kind of log needs no change here.

Adding a dashboard: copy a folder, edit the block list, add a row to the launcher,
bump the `?v=` cache-buster and `BUILD` in `core.js`.

## Configuration

The data repository and access token are entered at runtime, per dashboard, and
stored only in that browser's `localStorage`. Nothing is committed here — no
data, no credentials, no analytics, no third-party scripts. Every network request
goes to `api.github.com` and nowhere else.

## A brief that is late

Scheduled workflows on GitHub can start hours late. A dashboard whose manifest
names `rebuild` (the brief workflow's file name) dispatches that workflow when
it loads a brief dated before today, then reloads when the new one lands. The
token then also needs **Actions: read and write**; without it the page says so.

## Deploying

GitHub Pages, `main`, `/ (root)`. Pages caches assets for around ten minutes, so
bump the cache-buster on every change or a deploy silently does nothing. The
footer shows the build string.

## Credit

The architecture — issues as the database, a static page, a journal as the only
write path — is adapted from
[rfleiro/rfl-ops-dash](https://github.com/rfleiro/rfl-ops-dash).
