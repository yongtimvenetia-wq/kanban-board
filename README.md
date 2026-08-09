# VYT's Zone

A personal work hub: a **Kanban board**, an **Epics** view, and a **Notes** tab, with meeting
notes that turn into tickets. Live at
<https://yongtimvenetia-wq.github.io/kanban-board/>

## Signing in

The published site asks you to sign in with a link sent to your email. Once you're in, your
board syncs to your account, so it follows you between browsers and devices.

Opening `index.html` directly from your computer (double-clicking it, or running it from
localhost) skips the login and runs the board off that device's local storage only. That copy
is separate from your synced board — handy for testing, but don't do real work in it.

## What's here

**Board** — four columns: To Do, In Progress, Blocked, Done. Drag tickets between columns,
click a ticket to open its full editor, hover and click × to delete.

**Tickets** — auto-assigned ID (VYT-001…), title, rich-text description, priority
(Low/Medium/High/Urgent), status, due date, labels, an optional epic, linked tickets,
file attachments, comments, and an activity log.

**Epics** — optional groupings with a name, description and colour. Each shows a completion
percentage, and the board can be filtered by epic.

**Notes** — a rich-text scratchpad with headings, lists, checkboxes, tables and images.
Notes can carry a priority and be sorted or filtered.

**Meeting notes** — paste a meeting summary and it becomes a note with a summary, an action-item
checklist and the full transcript, optionally creating a board ticket per action item.

## Import / Export / Backup

Three buttons sit in the bottom-right corner, added by `board-sync.js`.

**Import** — paste in a structured block of tickets (typically generated from meeting notes)
and they're added to the board. You get a preview of exactly what will be created, updated and
skipped before anything saves. Tickets already on the board are matched and updated rather than
duplicated, so importing the same meeting twice is harmless. A ticket already in **Done** is
never moved backwards by an import.

The block looks like this — only `title` is required:

```json
{
  "meeting": "Weekly sync — 8 Aug 2026",
  "epics": [{ "name": "Vendor Onboarding" }],
  "tickets": [
    {
      "title": "Chase legal on the MSA redlines",
      "desc": "Legal flagged three clauses.",
      "priority": "high",
      "status": "todo",
      "due": "2026-08-12",
      "labels": ["waiting-on:Legal"],
      "epic": "Vendor Onboarding",
      "key": "gr-2026-08-08-msa"
    }
  ]
}
```

`status` is `todo`, `progress`, `blocked` or `done`. `priority` is `low`, `medium`, `high` or
`urgent`. `due` is `YYYY-MM-DD`. `key` is a stable id that lets the same item be re-imported
without duplicating — keep it identical across runs. `note` appends to an existing ticket's
description instead of replacing it.

**Export** — copies a snapshot of the board (titles, status, priority, due dates, labels,
epics) to your clipboard. Attachments and note contents are deliberately left out to keep it
small. Useful for generating status updates or spotting stale work.

**Backup** — downloads everything as a single `.json` file, and restores from one. Worth doing
periodically even with cloud sync, since a backup also protects against mistakes you make
yourself — a bad import, a bulk delete — which sync will happily replicate.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app — markup, styles and logic in one file |
| `board-sync.js` | The Import / Export / Backup add-on |
| `README.md` | This file |

`board-sync.js` never modifies the app's own code. It reads and writes the same saved data the
board already uses, and calls the app's cloud-sync function so imports reach your account
rather than sitting in one browser. To remove it, delete this line near the bottom of
`index.html`:

```html
<script src="board-sync.js"></script>
```

## Updating the site

Edit files on github.com (or upload replacements via **Add file → Upload files**) and commit to
`main`. GitHub Pages redeploys within a minute or two. If a change doesn't appear, hard-refresh
with **Cmd + Shift + R**.

## A note on this repository

This repo is **public** — anyone with the URL can read every file in it, and every past version
in the commit history. Don't commit passwords, client names, or anything from work that
shouldn't be in the open. Your board's *contents* are not affected: those live in your synced
account, not in this repository.
