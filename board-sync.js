/* ============================================================================
   VYT's Zone — board-sync add-on
   ----------------------------------------------------------------------------
   Adds three buttons to the board: Import, Export, Backup.
   Does NOT modify or depend on the internals of index.html — it only reads and
   writes the same localStorage keys the app already uses, then reloads the page
   so the app picks the changes up on its next boot.

   Install: put this file next to index.html and add ONE line just before the
   closing </body> tag of index.html:

       <script src="board-sync.js"></script>

   Safe to remove at any time — deleting the line restores the original app.
   ========================================================================== */
(function () {
  "use strict";

  var K_CARDS = "vytzone.tickets.v2";
  var K_SEQ   = "vytzone.seq.v1";
  var K_EPICS = "vytzone.epics.v1";

  // Notes have been through more than one storage version. Rather than hard-code
  // one, find the newest key that actually holds data — so a future version bump
  // can't silently drop notes out of backups.
  function notesKey() {
    var best = null, bestV = -1;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      var m = k && k.match(/^vytzone\.notes\.v(\d+)$/);
      if (m) {
        var v = parseInt(m[1], 10);
        var raw = localStorage.getItem(k);
        var populated = raw && raw !== "[]" && raw !== "null";
        if (populated && v > bestV) { bestV = v; best = k; }
      }
    }
    return best;
  }

  // Everything this app owns, so backups can't miss a key we didn't know about.
  // The session token is deliberately excluded — it's a credential, not data.
  function appKeys() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf("vytzone.") === 0 && k.indexOf("session") === -1) out.push(k);
    }
    return out;
  }

  var COLUMNS = ["todo", "progress", "blocked", "done"];
  var PRIORITIES = ["low", "medium", "high", "urgent"];

  // Friendly names people (and Claude) might use -> internal column ids
  var STATUS_ALIASES = {
    "todo": "todo", "to do": "todo", "to-do": "todo", "backlog": "todo", "new": "todo", "open": "todo",
    "progress": "progress", "in progress": "progress", "in-progress": "progress", "doing": "progress",
    "active": "progress", "wip": "progress",
    "blocked": "blocked", "waiting": "blocked", "waiting on": "blocked", "on hold": "blocked", "stuck": "blocked",
    "done": "done", "complete": "done", "completed": "done", "closed": "done", "shipped": "done"
  };

  // ---------- storage helpers -------------------------------------------------

  function load(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }

  // The app pushes to its cloud backend after every save. We do the same, so an
  // import syncs to your account rather than only living in this browser.
  function cloudPush() {
    if (typeof window.cloudSchedulePush === "function") {
      try { window.cloudSchedulePush(); } catch (e) {}
    }
  }

  function save(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      cloudPush();
      return true;
    } catch (e) { return false; }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function nextSeq() {
    var n = (load(K_SEQ, 0) || 0) + 1;
    save(K_SEQ, n);
    return "VYT-" + String(n).padStart(3, "0");
  }

  function nowISO() { return new Date().toISOString(); }

  function getCards() {
    var cards = load(K_CARDS, null);
    if (!cards || typeof cards !== "object") cards = {};
    COLUMNS.forEach(function (c) { if (!Array.isArray(cards[c])) cards[c] = []; });
    return cards;
  }

  function eachCard(cards, fn) {
    COLUMNS.forEach(function (col) {
      (cards[col] || []).forEach(function (c, i) { fn(c, col, i); });
    });
  }

  // ---------- normalisation ---------------------------------------------------

  function normStatus(s) {
    if (!s) return "todo";
    var k = String(s).trim().toLowerCase();
    return STATUS_ALIASES[k] || (COLUMNS.indexOf(k) !== -1 ? k : "todo");
  }

  function normPriority(p) {
    if (!p) return "medium";
    var k = String(p).trim().toLowerCase();
    if (k === "critical" || k === "p0") return "urgent";
    if (k === "p1") return "high";
    if (k === "p2") return "medium";
    if (k === "p3") return "low";
    return PRIORITIES.indexOf(k) !== -1 ? k : "medium";
  }

  function normDue(d) {
    if (!d) return "";
    var s = String(d).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var parsed = new Date(s);
    if (isNaN(parsed.getTime())) return "";
    var m = String(parsed.getMonth() + 1).padStart(2, "0");
    var day = String(parsed.getDate()).padStart(2, "0");
    return parsed.getFullYear() + "-" + m + "-" + day;
  }

  function normLabels(l) {
    if (!l) return [];
    if (typeof l === "string") l = l.split(",");
    if (!Array.isArray(l)) return [];
    return l.map(function (x) { return String(x).trim(); }).filter(Boolean);
  }

  // Loose title match so the same action item doesn't land twice when the
  // wording drifts slightly between meetings.
  function titleKey(t) {
    return String(t || "")
      .toLowerCase()
      .replace(/<[^>]*>/g, " ")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\b(the|a|an|to|for|of|on|and|with|please|need|needs|should)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Accept either plain text or HTML for the description. Plain text gets
  // wrapped so the app's rich-text editor renders line breaks properly.
  function toDescHTML(s) {
    if (!s) return "";
    var str = String(s);
    if (/<(p|div|ul|ol|li|h[1-3]|br|strong|em|table)\b/i.test(str)) return str;
    return str.split(/\n{2,}/).map(function (para) {
      return "<p>" + escapeHTML(para).replace(/\n/g, "<br>") + "</p>";
    }).join("");
  }

  // ---------- epics -----------------------------------------------------------

  var EPIC_COLORS = ["#7c3aed", "#2563eb", "#0891b2", "#059669", "#ca8a04", "#ea580c", "#dc2626", "#db2777"];

  function findEpicByName(epics, name) {
    var want = String(name || "").trim().toLowerCase();
    if (!want) return null;
    for (var i = 0; i < epics.length; i++) {
      if (String(epics[i].name || "").trim().toLowerCase() === want) return epics[i];
    }
    return null;
  }

  // Build a new epic that matches the shape of existing epics where possible,
  // so we never write a record the app can't read.
  function makeEpic(epics, name, description, color) {
    var template = epics.length ? epics[0] : null;
    var epic = {};
    if (template) {
      Object.keys(template).forEach(function (k) {
        var v = template[k];
        epic[k] = Array.isArray(v) ? [] : (v && typeof v === "object" ? {} : (typeof v === "number" ? 0 : ""));
      });
    }
    epic.id = uid();
    epic.name = String(name).trim();
    if ("description" in epic || !template) epic.description = description || "";
    if ("desc" in epic) epic.desc = description || "";
    epic.color = color || EPIC_COLORS[epics.length % EPIC_COLORS.length];
    if ("status" in epic || !template) epic.status = epic.status || "active";
    if ("created" in epic || !template) epic.created = nowISO();
    if ("updated" in epic || !template) epic.updated = nowISO();
    return epic;
  }

  // ---------- the merge -------------------------------------------------------
  // Returns a plan describing exactly what would change. Nothing is written
  // until applyPlan() is called, so Import can always show a preview first.

  function buildPlan(payload) {
    var cards = getCards();
    var epics = load(K_EPICS, []) || [];
    var incoming = (payload && (payload.tickets || payload.items)) || [];
    if (!Array.isArray(incoming)) incoming = [];

    var byKey = {}, byTitle = {};
    eachCard(cards, function (c, col) {
      if (c.syncKey) byKey[c.syncKey] = { card: c, col: col };
      var tk = titleKey(c.title);
      if (tk && !byTitle[tk]) byTitle[tk] = { card: c, col: col };
    });

    var plan = { created: [], updated: [], skipped: [], newEpics: [], payload: payload };
    var seenThisRun = {};

    // Epics referenced by name that don't exist yet
    var declaredEpics = (payload && payload.epics) || [];
    declaredEpics.forEach(function (e) {
      var name = typeof e === "string" ? e : e.name;
      if (name && !findEpicByName(epics, name) && plan.newEpics.indexOf(name) === -1) {
        plan.newEpics.push(name);
      }
    });

    incoming.forEach(function (raw) {
      if (!raw || !raw.title) return;

      var key = raw.key || raw.syncKey || "";
      var tk = titleKey(raw.title);

      // Guard against the same item appearing twice in one payload
      var dedupe = key || tk;
      if (dedupe && seenThisRun[dedupe]) {
        plan.skipped.push({ title: raw.title, reason: "duplicate in payload" });
        return;
      }
      if (dedupe) seenThisRun[dedupe] = true;

      var match = (key && byKey[key]) || (tk && byTitle[tk]) || null;

      if (raw.epic && !findEpicByName(epics, raw.epic) && plan.newEpics.indexOf(raw.epic) === -1) {
        plan.newEpics.push(raw.epic);
      }

      if (!match) {
        plan.created.push(raw);
        return;
      }

      // Existing ticket — work out whether anything actually changed.
      var changes = [];
      var c = match.card;

      if (raw.priority && normPriority(raw.priority) !== c.priority) {
        changes.push({ field: "priority", from: c.priority, to: normPriority(raw.priority) });
      }
      if (raw.due && normDue(raw.due) !== c.due) {
        changes.push({ field: "due", from: c.due, to: normDue(raw.due) });
      }
      // Never drag a finished ticket backwards — if it's Done, it stays Done.
      if (raw.status && match.col !== "done") {
        var target = normStatus(raw.status);
        if (target !== match.col) changes.push({ field: "status", from: match.col, to: target });
      }
      var newLabels = normLabels(raw.labels).filter(function (l) {
        return (c.labels || []).indexOf(l) === -1;
      });
      if (newLabels.length) changes.push({ field: "labels", add: newLabels });

      // Only append a note if this exact note isn't already on the ticket —
      // otherwise re-importing the same meeting duplicates the text.
      var noteText = raw.note || raw.desc;
      if (noteText) {
        var noteId = titleKey(noteText);
        var alreadyLogged = (c.syncNotes || []).indexOf(noteId) !== -1;
        var alreadyInDesc = noteId && titleKey(c.desc).indexOf(noteId) !== -1;
        if (!alreadyLogged && !alreadyInDesc) {
          changes.push({ field: "note", to: noteText, noteId: noteId });
        }
      }

      if (!changes.length) {
        plan.skipped.push({ title: raw.title, reason: "already up to date" });
      } else {
        plan.updated.push({ raw: raw, card: c, col: match.col, changes: changes });
      }
    });

    return plan;
  }

  function applyPlan(plan) {
    var cards = getCards();
    var epics = load(K_EPICS, []) || [];
    var payload = plan.payload || {};
    var stamp = payload.meeting ? ("Meeting: " + payload.meeting) : "Imported";

    // 1. epics first, so tickets can reference them
    plan.newEpics.forEach(function (name) {
      if (findEpicByName(epics, name)) return;
      var declared = ((payload.epics || []).filter(function (e) {
        return typeof e === "object" && e.name === name;
      })[0]) || {};
      epics.push(makeEpic(epics, name, declared.description, declared.color));
    });

    function epicIdFor(name) {
      var e = findEpicByName(epics, name);
      return e ? e.id : "";
    }

    // 2. new tickets
    plan.created.forEach(function (raw) {
      var col = normStatus(raw.status);
      var ticket = {
        id: uid(),
        ticketId: nextSeq(),
        title: String(raw.title).trim(),
        desc: toDescHTML(raw.desc),
        priority: normPriority(raw.priority),
        status: col,
        due: normDue(raw.due),
        labels: normLabels(raw.labels),
        epic: raw.epic ? epicIdFor(raw.epic) : "",
        attachments: [],
        links: [],
        created: nowISO(),
        updated: nowISO(),
        log: [{ text: "Created from " + stamp, at: nowISO() }]
      };
      if (raw.key || raw.syncKey) ticket.syncKey = raw.key || raw.syncKey;
      if (raw.source) ticket.syncSource = raw.source;
      cards[col].push(ticket);
    });

    // 3. updates to existing tickets
    plan.updated.forEach(function (u) {
      var c = null, fromCol = null;
      eachCard(cards, function (card, col) {
        if (card.id === u.card.id) { c = card; fromCol = col; }
      });
      if (!c) return;

      var moveTo = null;
      u.changes.forEach(function (ch) {
        if (ch.field === "priority") {
          c.priority = ch.to;
          c.log = (c.log || []).concat({ text: "Priority " + ch.from + " → " + ch.to + " (" + stamp + ")", at: nowISO() });
        } else if (ch.field === "due") {
          c.due = ch.to;
          c.log = (c.log || []).concat({ text: "Due date set to " + ch.to + " (" + stamp + ")", at: nowISO() });
        } else if (ch.field === "status") {
          moveTo = ch.to;
          c.status = ch.to;
          c.log = (c.log || []).concat({ text: "Moved to " + ch.to + " (" + stamp + ")", at: nowISO() });
        } else if (ch.field === "labels") {
          c.labels = (c.labels || []).concat(ch.add);
        } else if (ch.field === "note") {
          var addition = toDescHTML(u.raw.note || u.raw.desc);
          c.desc = (c.desc || "") + "<p><em>" + escapeHTML(stamp) + "</em></p>" + addition;
          c.log = (c.log || []).concat({ text: "Note added from " + stamp, at: nowISO() });
          if (ch.noteId) c.syncNotes = (c.syncNotes || []).concat(ch.noteId);
        }
      });

      if (u.raw.epic && !c.epic) c.epic = epicIdFor(u.raw.epic);
      if ((u.raw.key || u.raw.syncKey) && !c.syncKey) c.syncKey = u.raw.key || u.raw.syncKey;
      c.updated = nowISO();

      if (moveTo && moveTo !== fromCol) {
        cards[fromCol] = cards[fromCol].filter(function (x) { return x.id !== c.id; });
        cards[moveTo].push(c);
      }
    });

    var okE = save(K_EPICS, epics);
    var okC = save(K_CARDS, cards);
    return okE && okC;
  }

  // ---------- export ----------------------------------------------------------

  // Compact view of the board, safe to paste into a chat. Attachments and note
  // bodies are deliberately left out — they're large and rarely useful there.
  function buildSummary() {
    var cards = getCards();
    var epics = load(K_EPICS, []) || [];
    var nk = notesKey();
    var notes = nk ? (load(nk, []) || []) : [];
    var epicName = {};
    epics.forEach(function (e) { epicName[e.id] = e.name; });

    var out = { exported: nowISO(), epics: epics.map(function (e) { return e.name; }), tickets: [] };

    eachCard(cards, function (c, col) {
      out.tickets.push({
        ticketId: c.ticketId,
        title: c.title,
        status: col,
        priority: c.priority,
        due: c.due || "",
        labels: c.labels || [],
        epic: epicName[c.epic] || "",
        updated: c.updated,
        created: c.created,
        hasDesc: !!(c.desc && c.desc.length > 10),
        key: c.syncKey || ""
      });
    });

    out.notes = (Array.isArray(notes) ? notes : []).map(function (n) {
      return {
        subject: n.subject || "",
        priority: n.priority || "",
        updated: n.updated || n.created || ""
      };
    });

    return out;
  }

  function buildFullBackup() {
    var data = {};
    appKeys().forEach(function (k) {
      var raw = localStorage.getItem(k);
      try { data[k] = JSON.parse(raw); }
      catch (e) { data[k] = raw; }
    });
    if (!(K_CARDS in data)) data[K_CARDS] = load(K_CARDS, null);
    return {
      app: "VYT's Zone",
      backupVersion: 2,
      takenAt: nowISO(),
      keys: Object.keys(data),
      data: data
    };
  }

  // What a backup actually contains, so the user can see it before trusting it.
  function backupContents() {
    var b = buildFullBackup();
    var cards = b.data[K_CARDS] || {};
    var tickets = COLUMNS.reduce(function (n, c) { return n + ((cards[c] || []).length); }, 0);
    var nk = notesKey();
    var notes = nk && Array.isArray(b.data[nk]) ? b.data[nk].length : 0;
    var epics = Array.isArray(b.data[K_EPICS]) ? b.data[K_EPICS].length : 0;
    return { tickets: tickets, notes: notes, epics: epics, keys: b.keys, json: JSON.stringify(b) };
  }

  function restoreBackup(obj) {
    if (!obj || !obj.data) throw new Error("That file doesn't look like a VYT's Zone backup.");
    var d = obj.data;
    if (!d["vytzone.tickets.v2"]) throw new Error("Backup is missing its ticket data.");
    Object.keys(d).forEach(function (k) {
      if (d[k] !== null && d[k] !== undefined) localStorage.setItem(k, JSON.stringify(d[k]));
    });
    cloudPush();
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); resolve(); }
      catch (e) { reject(e); }
      finally { document.body.removeChild(ta); }
    });
  }

  function todayStamp() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // ---------- UI --------------------------------------------------------------

  var CSS = [
    "#bsync-bar{position:fixed;right:16px;bottom:16px;z-index:1800;display:flex;gap:6px;font-family:inherit}",
    "#bsync-bar button{border:1px solid #d9dcea;background:#fff;color:#3a3f55;border-radius:999px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 10px rgba(20,28,48,.12)}",
    "#bsync-bar button:hover{background:#eef0fe;color:#4f46e5;border-color:#c7ccf5}",
    "#bsync-overlay{position:fixed;inset:0;z-index:2200;display:none;align-items:center;justify-content:center;background:rgba(15,20,35,.55);padding:20px}",
    "#bsync-overlay.open{display:flex}",
    "#bsync-modal{background:#fff;border-radius:14px;max-width:640px;width:100%;max-height:86vh;overflow:auto;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.3);font-family:inherit;color:#2a2f45}",
    "#bsync-modal h2{margin:0 0 4px;font-size:19px}",
    "#bsync-modal p.sub{margin:0 0 14px;font-size:13px;color:#6b7192;line-height:1.5}",
    "#bsync-modal textarea{width:100%;min-height:170px;border:1px solid #d9dcea;border-radius:10px;padding:10px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.45;resize:vertical;box-sizing:border-box}",
    "#bsync-modal .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}",
    "#bsync-modal .row button{border-radius:9px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #d9dcea;background:#fff;color:#3a3f55}",
    "#bsync-modal .row button.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}",
    "#bsync-modal .row button.primary:disabled{opacity:.45;cursor:not-allowed}",
    "#bsync-modal .row button.danger{border-color:#e6b4b4;color:#b91c1c}",
    "#bsync-preview{margin-top:14px;font-size:13px;line-height:1.6}",
    "#bsync-preview .grp{margin-bottom:10px}",
    "#bsync-preview .grp b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7192;margin-bottom:3px}",
    "#bsync-preview ul{margin:0;padding-left:18px}",
    "#bsync-preview li{margin:2px 0}",
    "#bsync-preview .muted{color:#8b90ab}",
    "#bsync-err{color:#b91c1c;font-size:13px;margin-top:10px;display:none}",
    "#bsync-ok{color:#0f7b46;font-size:13px;margin-top:10px;display:none}",
    "@media(max-width:600px){#bsync-bar{right:10px;bottom:10px}#bsync-bar button{padding:7px 11px;font-size:12px}}"
  ].join("\n");

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }

  var overlay, modal;

  function openModal(html) {
    modal.innerHTML = html;
    overlay.classList.add("open");
  }

  function closeModal() { overlay.classList.remove("open"); }

  function showError(msg) {
    var e = document.getElementById("bsync-err");
    if (e) { e.textContent = msg; e.style.display = "block"; }
  }

  function showOk(msg) {
    var e = document.getElementById("bsync-ok");
    if (e) { e.textContent = msg; e.style.display = "block"; }
  }

  // --- Import ---

  function renderPreview(plan) {
    var box = document.getElementById("bsync-preview");
    var applyBtn = document.getElementById("bsync-apply");
    if (!box) return;

    var parts = [];

    if (plan.newEpics.length) {
      parts.push('<div class="grp"><b>New epics (' + plan.newEpics.length + ')</b><ul>' +
        plan.newEpics.map(function (n) { return "<li>" + escapeHTML(n) + "</li>"; }).join("") + "</ul></div>");
    }
    if (plan.created.length) {
      parts.push('<div class="grp"><b>New tickets (' + plan.created.length + ')</b><ul>' +
        plan.created.map(function (t) {
          var bits = [normStatus(t.status), normPriority(t.priority)];
          if (t.due) bits.push("due " + normDue(t.due));
          return "<li>" + escapeHTML(t.title) + ' <span class="muted">— ' + bits.join(" · ") + "</span></li>";
        }).join("") + "</ul></div>");
    }
    if (plan.updated.length) {
      parts.push('<div class="grp"><b>Updates to existing tickets (' + plan.updated.length + ')</b><ul>' +
        plan.updated.map(function (u) {
          var desc = u.changes.map(function (ch) {
            if (ch.field === "labels") return "add label " + ch.add.join(", ");
            if (ch.field === "note") return "append note";
            return ch.field + " " + (ch.from || "—") + " → " + ch.to;
          }).join("; ");
          return "<li>" + escapeHTML(u.card.ticketId || u.card.title) + " " + escapeHTML(u.card.title) +
                 ' <span class="muted">— ' + escapeHTML(desc) + "</span></li>";
        }).join("") + "</ul></div>");
    }
    if (plan.skipped.length) {
      parts.push('<div class="grp"><b>Skipped (' + plan.skipped.length + ')</b><ul class="muted">' +
        plan.skipped.map(function (s) {
          return "<li>" + escapeHTML(s.title) + " — " + escapeHTML(s.reason) + "</li>";
        }).join("") + "</ul></div>");
    }

    if (!parts.length) parts.push('<div class="muted">Nothing to import — the board already matches this.</div>');

    box.innerHTML = parts.join("");
    if (applyBtn) {
      applyBtn.disabled = !(plan.created.length || plan.updated.length || plan.newEpics.length);
    }
  }

  var currentPlan = null;

  function doPreview() {
    var ta = document.getElementById("bsync-input");
    var errEl = document.getElementById("bsync-err");
    if (errEl) errEl.style.display = "none";
    var text = (ta.value || "").trim();
    if (!text) { showError("Paste the import block first."); return; }

    // Tolerate the block being wrapped in a ```json fence
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

    var payload;
    try { payload = JSON.parse(text); }
    catch (e) { showError("That isn't valid JSON — check nothing got cut off when you copied."); return; }

    if (Array.isArray(payload)) payload = { tickets: payload };
    if (!payload.tickets && !payload.items) {
      showError('No tickets found. The block needs a "tickets" list.');
      return;
    }

    try {
      currentPlan = buildPlan(payload);
      renderPreview(currentPlan);
    } catch (e) {
      showError("Couldn't read that block: " + e.message);
    }
  }

  function doApply() {
    if (!currentPlan) return;
    var ok;
    try { ok = applyPlan(currentPlan); }
    catch (e) { showError("Import failed: " + e.message); return; }

    if (!ok) {
      showError("Couldn't save — browser storage is full. Try Backup, then remove some large attachments.");
      return;
    }
    showOk("Imported. Reloading the board…");
    setTimeout(function () { location.reload(); }, 1800);
  }

  function openImport() {
    currentPlan = null;
    openModal(
      "<h2>Import into the board</h2>" +
      '<p class="sub">Paste the block Claude gave you. You\'ll see exactly what will change before anything is saved. ' +
      "Items already on the board are updated, not duplicated.</p>" +
      '<textarea id="bsync-input" placeholder=\'{"meeting":"Weekly sync","tickets":[{"title":"...","priority":"high","due":"2026-08-15"}]}\'></textarea>' +
      '<div class="row">' +
        '<button id="bsync-paste">Paste from clipboard</button>' +
        '<button id="bsync-preview-btn">Preview changes</button>' +
        '<button id="bsync-apply" class="primary" disabled>Apply</button>' +
        '<button id="bsync-cancel">Cancel</button>' +
      "</div>" +
      '<div id="bsync-err"></div><div id="bsync-ok"></div>' +
      '<div id="bsync-preview"></div>'
    );

    document.getElementById("bsync-paste").onclick = function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        showError("This browser won't let a page read the clipboard — press Cmd+V in the box instead.");
        return;
      }
      navigator.clipboard.readText().then(function (t) {
        document.getElementById("bsync-input").value = t;
        doPreview();
      }).catch(function () {
        showError("Clipboard access was blocked — press Cmd+V in the box instead.");
      });
    };
    document.getElementById("bsync-preview-btn").onclick = doPreview;
    document.getElementById("bsync-apply").onclick = doApply;
    document.getElementById("bsync-cancel").onclick = closeModal;
    document.getElementById("bsync-input").focus();
  }

  // --- Export ---

  function openExport() {
    var summary = buildSummary();
    var count = summary.tickets.length;
    openModal(
      "<h2>Export board</h2>" +
      '<p class="sub">A snapshot of ' + count + ' ticket' + (count === 1 ? "" : "s") +
      " — titles, status, priority, dates and labels. Attachments and note contents are left out. " +
      "Paste this into Claude to get a status update, or to have stale and drifting items flagged.</p>" +
      '<textarea id="bsync-output" readonly></textarea>' +
      '<div class="row">' +
        '<button id="bsync-copy" class="primary">Copy to clipboard</button>' +
        '<button id="bsync-dl">Download as file</button>' +
        '<button id="bsync-cancel">Close</button>' +
      "</div>" +
      '<div id="bsync-err"></div><div id="bsync-ok"></div>'
    );
    var text = JSON.stringify(summary, null, 2);
    document.getElementById("bsync-output").value = text;
    document.getElementById("bsync-copy").onclick = function () {
      copyText(text).then(function () { showOk("Copied. Paste it into Claude."); })
        .catch(function () { showError("Copy was blocked — select the text and copy manually."); });
    };
    document.getElementById("bsync-dl").onclick = function () {
      download("vytzone-export-" + todayStamp() + ".json", text);
    };
    document.getElementById("bsync-cancel").onclick = closeModal;
  }

  // --- Backup / restore ---

  function openBackup() {
    var c = backupContents();
    var mb = (c.json.length / 1048576).toFixed(1);
    openModal(
      "<h2>Backup &amp; restore</h2>" +
      '<p class="sub">This backup contains <b>' + c.tickets + " tickets</b>, <b>" + c.notes +
      " notes</b> and <b>" + c.epics + " epics</b> — about " + mb + " MB, including attachments. " +
      "Your board syncs to your account, but a backup also protects against mistakes sync will happily copy: " +
      "a bad import, a bulk delete.</p>" +
      '<div class="row">' +
        '<button id="bsync-backup" class="primary">Download backup</button>' +
        '<button id="bsync-restore">Restore from file…</button>' +
        '<button id="bsync-cancel">Close</button>' +
      "</div>" +
      '<input type="file" id="bsync-file" accept="application/json,.json" style="display:none">' +
      '<div id="bsync-err"></div><div id="bsync-ok"></div>'
    );

    document.getElementById("bsync-backup").onclick = function () {
      download("vytzone-backup-" + todayStamp() + ".json", c.json);
      showOk("Backup downloaded — " + c.tickets + " tickets, " + c.notes + " notes.");
      try { localStorage.setItem("vytzone.lastBackup", nowISO()); } catch (e) {}
    };

    document.getElementById("bsync-restore").onclick = function () {
      document.getElementById("bsync-file").click();
    };

    document.getElementById("bsync-file").onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var obj;
        try { obj = JSON.parse(reader.result); }
        catch (e) { showError("That file isn't valid JSON."); return; }

        if (!window.confirm("Restore will REPLACE everything currently on the board with the contents of this file. Continue?")) return;

        try { restoreBackup(obj); }
        catch (e) { showError(e.message); return; }
        showOk("Restored. Reloading…");
        setTimeout(function () { location.reload(); }, 1800);
      };
      reader.readAsText(f);
    };

    document.getElementById("bsync-cancel").onclick = closeModal;
  }

  // ---------- boot ------------------------------------------------------------

  function mount() {
    if (document.getElementById("bsync-bar")) return;

    var style = el("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    var bar = el("div", { id: "bsync-bar" });
    var bImport = el("button", { type: "button", title: "Paste in tickets from Claude" }, "Import");
    var bExport = el("button", { type: "button", title: "Copy the board out for analysis" }, "Export");
    var bBackup = el("button", { type: "button", title: "Download a full backup" }, "Backup");
    bImport.onclick = openImport;
    bExport.onclick = openExport;
    bBackup.onclick = openBackup;
    bar.appendChild(bImport); bar.appendChild(bExport); bar.appendChild(bBackup);
    document.body.appendChild(bar);

    overlay = el("div", { id: "bsync-overlay" });
    modal = el("div", { id: "bsync-modal" });
    overlay.appendChild(modal);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("open")) closeModal();
    });
    document.body.appendChild(overlay);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(mount, 300); });
  } else {
    setTimeout(mount, 300);
  }

  // Exposed for testing
  window.__boardSync = {
    buildPlan: buildPlan,
    applyPlan: applyPlan,
    buildSummary: buildSummary,
    buildFullBackup: buildFullBackup,
    backupContents: backupContents,
    notesKey: notesKey,
    appKeys: appKeys,
    restoreBackup: restoreBackup,
    _internals: { titleKey: titleKey, normStatus: normStatus, normPriority: normPriority, normDue: normDue }
  };
})();
