# VYT's Zone

A simple website with a **Kanban board** and a **Notes** tab. Everything saves automatically in your browser — no accounts, no database, no setup.

## Try it locally

Double-click `index.html` to open it in your browser. That's it.

## Put it online with GitHub Pages (free)

You don't need to be technical. Follow these steps once:

1. Go to [github.com](https://github.com) and sign in (or create a free account).
2. Click the **+** in the top-right → **New repository**. Give it a name (e.g. `my-workspace`), keep it **Public**, and click **Create repository**.
3. On the new repository page, click **uploading an existing file** (or the **Add file → Upload files** button).
4. Drag in `index.html` and `README.md`, then click **Commit changes**.
5. Go to the repository's **Settings** tab → **Pages** (left sidebar).
6. Under **Branch**, choose **main** and **/ (root)**, then click **Save**.
7. Wait about a minute, then refresh. GitHub shows a link like
   `https://your-username.github.io/my-workspace/` — that's your live site.

To update the site later, upload a new `index.html` the same way (step 3) and commit. The live page refreshes automatically.

## How your data works

- Your cards and notes are stored **in the browser on the device you're using** (called "local storage").
- This means data is private to you and survives refreshes and restarts.
- It does **not** sync between devices, and clearing your browser data will erase it. If you want cross-device sync or backups later, that's a feature we can add.

## What's here

- **Kanban Board** — four columns (To Do, In Progress, Blocked, Done). Click **+ Add a ticket** to create one, drag tickets between columns, click a ticket to open its full editor, hover and click × to delete.
- **Tickets** — each ticket has an auto-assigned ID (VYT-001…), title, description, priority (Low/Medium/High/Urgent), status, assignee, due date, labels/tags, an optional epic, created/updated timestamps, and a comments & activity log.
- **Notes** — a free-form notepad that saves as you type.
