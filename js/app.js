(function () {
  var ROOMS = ["Küche", "Bad", "Wohnzimmer", "Schlafzimmer", "Flur", "Überall"];
  var INTERVALS = [[1, "täglich"], [3, "alle 3 Tage"], [7, "wöchentlich"], [14, "alle 2 Wochen"], [30, "monatlich"], [90, "vierteljährlich"]];
  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function $(id) { return document.getElementById(id); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var db = null;
  var tasks = null;          // null = lädt noch
  var logs = [];             // Protokoll aller Erledigungen
  var dbMissing = false;
  var me = lsGet("pp-me");
  if (me !== "F" && me !== "C") me = null;
  var filter = lsGet("pp-filter");
  if (filter !== "F" && filter !== "C") filter = "alle";
  var open = {};
  var confirmDel = null;
  var confirmExamples = false;
  var period = "30";
  var view = "plan";
  var toastTimer = null;
  var sv = lsGet("pp-section");
  var section = sv === "shop" || sv === "cook" || sv === "meal" || sv === "spend" ? sv : "putz";
  var budgets = null;        // null = lädt noch
  var spends = [];
  var curBudget = lsGet("pp-budget");
  var budgetForm = null;     // null | "new" | "edit"
  var confirmBudgetDel = false;
  var formBudget = null;     // für welches Budget das Datum im Formular gesetzt wurde
  var recipes = null;        // null = lädt noch
  var picked = {};           // gewählte Gerichte (id -> true)
  var pantry = { rows: [] };
  var draft = null;
  var cookMode = "list";
  var confirmRecDel = false;
  var confirmCookEx = false;
  var plan = {};             // Datum (JJJJ-MM-TT) -> { dishes: [{id, name}] }
  var planLoaded = false;
  var weekOffset = 0;
  var pickDay = null;
  var cookTab = "menu";
  var cookPeriod = "90";
  var mealIds = [];
  var stores = null;         // null = lädt noch
  var items = [];            // Einkaufsartikel aller Läden
  var curStore = lsGet("pp-store");
  var addingStore = false;
  var confirmStoreDel = false;
  var confirmClean = false;

  function h(tag, attrs) {
    var e = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === false || v == null) return;
      if (k === "class") e.className = v;
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else e.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      e.append(c);
    }
    return e;
  }

  /* Datum */
  function pad(n) { return String(n).padStart(2, "0"); }
  function todayStr() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function dn(s) { var p = s.split("-").map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); }
  function fmt(s) { var p = s.split("-"); return p[2] + "." + p[1] + "."; }
  function weekStart(n) { return n - ((n + 3) % 7); }   // Montag
  function dayLabel(n) { var d = new Date(n * 864e5); return pad(d.getUTCDate()) + "." + pad(d.getUTCMonth() + 1) + "."; }
  function intervalLabel(n) { for (var i = 0; i < INTERVALS.length; i++) if (INTERVALS[i][0] === n) return INTERVALS[i][1]; return "alle " + n + " Tage"; }
  function dueText(d) {
    if (d < -1) return "seit " + (-d) + " Tagen überfällig";
    if (d === -1) return "seit gestern überfällig";
    if (d === 0) return "heute fällig";
    if (d === 1) return "morgen";
    return "in " + d + " Tagen";
  }
  function info(t) {
    var today = dn(todayStr());
    var days = Number(t.intervalDays) || 7;
    var due = t.lastDone ? dn(t.lastDone) + days : today;
    var who = t.assignee === "abwechselnd" ? (t.turn === "C" ? "C" : "F") : (t.assignee === "C" ? "C" : "F");
    return { d: due - today, who: who };
  }

  /* Hinweis unten */
  function toast(msg, actionLabel, action, long) {
    $("toasttext").textContent = msg;
    var b = $("toastbtn");
    if (actionLabel) {
      b.hidden = false;
      b.textContent = actionLabel;
      b.onclick = function () { hideToast(); action(); };
    } else { b.hidden = true; b.onclick = null; }
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, long ? 15000 : actionLabel ? 7000 : 4500);
  }
  function hideToast() { $("toast").hidden = true; }
  function writeFail(e) {
    var code = e && e.code ? String(e.code) : "";
    if (code === "permission-denied") toast("Kein Zugriff zum Speichern. Melde dich ab und wieder an. Falls das bleibt, prüfe die Sicherheitsregeln (Anleitung).", null, null, true);
    else if (code === "unavailable") toast("Keine Verbindung. Versuch es gleich noch einmal.");
    else toast("Speichern hat nicht geklappt" + (code ? " (" + code + ")" : "") + ". Versuch es gleich noch einmal.");
  }
  var dbErr = "";
  function connText() {
    return "Keine Verbindung zum Speicher" + (dbErr ? " (" + dbErr + ")" : "") + ". Prüfe deine Internetverbindung und lade die Seite neu. Hilfe steht in der Anleitung unter „Wenn etwas nicht klappt“.";
  }
  var readFailShown = false;
  function readFail(e) {
    var code = e && e.code ? String(e.code) : "";
    dbMissing = true; dbErr = code;
    if (!readFailShown) {
      readFailShown = true;
      if (code === "permission-denied") toast("Kein Zugriff auf die Daten. Prüft das SQL-Setup und die E-Mail-Adressen in der Mitglieder-Liste (Anleitung).", null, null, true);
      else toast("Die Verbindung zum Speicher ist abgebrochen" + (code ? " (" + code + ")" : "") + ". Lade die Seite neu.", null, null, true);
    }
    render();
  }

  /* Aktionen */
  function markDone(t) {
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    if (!me) {
      toast("Wähle oben zuerst, ob du F oder C bist.");
      var seg = $("me");
      seg.classList.remove("nudge"); void seg.offsetWidth; seg.classList.add("nudge");
      seg.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    var prev = {
      lastDone: t.lastDone || "",
      lastBy: t.lastBy || "",
      turn: t.turn || "",
      countF: t.countF || 0,
      countC: t.countC || 0
    };
    var next = {
      lastDone: todayStr(),
      lastBy: me,
      countF: prev.countF + (me === "F" ? 1 : 0),
      countC: prev.countC + (me === "C" ? 1 : 0),
      turn: t.assignee === "abwechselnd" ? (me === "F" ? "C" : "F") : ""
    };
    var ref = db.doc("tasks/" + t.id);
    var lref = db.collection("log").doc();
    var entry = { taskId: t.id, task: t.name, room: t.room || "Überall", by: me, date: todayStr(), at: Date.now() };
    Promise.all([ref.update(next), lref.set(entry)]).then(function () {
      var days = Number(t.intervalDays) || 7;
      toast("„" + t.name + "“ erledigt. Wieder dran " + (days === 1 ? "morgen" : "in " + days + " Tagen") + ".", "Rückgängig", function () {
        Promise.all([ref.update(prev), lref.delete()]).catch(writeFail);
      });
    }).catch(writeFail);
  }
  function deleteTask(t) {
    confirmDel = null;
    db.doc("tasks/" + t.id).delete().catch(writeFail);
  }
  function removeExamples() {
    var ex = (tasks || []).filter(function (t) { return t.example === true; });
    confirmExamples = false;
    var chain = Promise.resolve();
    ex.forEach(function (t) { chain = chain.then(function () { return db.doc("tasks/" + t.id).delete(); }); });
    chain.then(function () { toast("Beispielaufgaben entfernt."); }).catch(writeFail);
  }

  /* Darstellung: Plan */
  function row(t) {
    var inf = info(t);
    var status = inf.d < 0 ? "late" : inf.d === 0 ? "today" : "ok";
    var isOpen = !!open[t.id];
    var metaParts = [t.room || "Überall", intervalLabel(Number(t.intervalDays))];
    if (t.assignee === "abwechselnd") metaParts.push("abwechselnd");
    var li = h("li", { class: "task" });
    var check = h("button", { class: "check", type: "button", "aria-label": "Erledigt: " + t.name, onclick: function () { markDone(t); } });
    check.innerHTML = CHECK;
    var title = h("button", { class: "title", type: "button", "aria-expanded": isOpen ? "true" : "false", onclick: function () {
      if (open[t.id]) delete open[t.id]; else open[t.id] = true;
      confirmDel = null; render();
    } }, t.name);
    li.append(
      check,
      h("div", { class: "body" }, title, h("div", { class: "meta" }, metaParts.join(" · ")), h("div", { class: "due " + status }, dueText(inf.d))),
      h("span", { class: "chip " + inf.who, title: "Zuständig: " + inf.who, "aria-label": "Zuständig: " + inf.who }, inf.who)
    );
    if (isOpen) {
      var last = t.lastDone ? "Zuletzt erledigt von " + (t.lastBy || "?") + " am " + fmt(t.lastDone) + "." : "Noch nie erledigt.";
      var actions = h("div", { class: "row" });
      if (confirmDel === t.id) {
        actions.append(
          h("button", { class: "linkbtn danger", type: "button", onclick: function () { deleteTask(t); } }, "Ja, löschen"),
          h("button", { class: "linkbtn", type: "button", onclick: function () { confirmDel = null; render(); } }, "Abbrechen")
        );
      } else {
        actions.append(h("button", { class: "linkbtn", type: "button", onclick: function () { confirmDel = t.id; render(); } }, "Aufgabe löschen"));
      }
      li.append(h("div", { class: "more" }, h("div", null, last), actions));
    }
    return li;
  }

  function renderSummary() {
    var head = $("headline");
    if (tasks === null) { head.textContent = "Putzplan wird geladen …"; $("share").hidden = true; return; }
    var n = 0, cf = 0, cc = 0;
    tasks.forEach(function (t) {
      if (info(t).d <= 0) n++;
      cf += t.countF || 0; cc += t.countC || 0;
    });
    if (!tasks.length) head.textContent = "Noch keine Aufgaben";
    else if (n === 0) head.textContent = "Heute ist alles erledigt.";
    else head.textContent = n === 1 ? "1 Aufgabe ist heute dran." : n + " Aufgaben sind heute dran.";
    var total = cf + cc;
    $("share").hidden = total === 0;
    if (total > 0) {
      $("nf").textContent = cf; $("nc").textContent = cc;
      $("bf").style.width = (cf / total * 100) + "%";
      $("bc").style.width = (cc / total * 100) + "%";
    }
  }

  function renderBanner() {
    var box = $("banner");
    box.replaceChildren();
    if (dbMissing) {
      box.append(h("div", { class: "banner" }, h("p", null, connText())));
      return;
    }
    if (tasks && tasks.some(function (t) { return t.example === true; })) {
      var btn = confirmExamples
        ? h("button", { class: "linkbtn danger", type: "button", onclick: removeExamples }, "Ja, alle Beispiele löschen")
        : h("button", { class: "linkbtn", type: "button", onclick: function () { confirmExamples = true; renderBanner(); } }, "Beispiele entfernen");
      box.append(h("div", { class: "banner" }, h("p", null, "Das sind Beispielaufgaben zum Ausprobieren. Entfernt sie, sobald ihr eure eigenen eingetragen habt."), btn));
    }
  }

  function render() {
    $("today").textContent = new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
    renderSummary();
    renderBanner();
    renderStats();
    renderShop();
    renderCook();
    renderMeal();
    renderSpend();
    var list = $("list");
    list.replaceChildren();
    if (tasks === null) return;
    if (!tasks.length) {
      list.append(h("div", { class: "empty" }, h("b", null, "Hier ist noch nichts eingetragen"), h("span", null, "Öffne unten „Aufgabe hinzufügen“ und lege die erste Aufgabe an, zum Beispiel „Bad putzen“ alle 7 Tage.")));
      return;
    }
    var shown = tasks.map(function (t) { var i = info(t); return { t: t, d: i.d, who: i.who }; })
      .filter(function (x) { return filter === "alle" || x.who === filter; })
      .sort(function (a, b) { return a.d - b.d || String(a.t.name).localeCompare(String(b.t.name), "de"); });
    if (!shown.length) {
      list.append(h("p", { class: "note" }, "Für " + filter + " ist gerade nichts eingetragen."));
      return;
    }
    var groups = [
      ["Heute und überfällig", function (d) { return d <= 0; }],
      ["Diese Woche", function (d) { return d >= 1 && d <= 7; }],
      ["Später", function (d) { return d > 7; }]
    ];
    groups.forEach(function (g) {
      var items = shown.filter(function (x) { return g[1](x.d); });
      if (!items.length) return;
      var ul = h("ul", { class: "tasks" });
      items.forEach(function (x) { ul.append(row(x.t)); });
      list.append(h("section", { class: "group" }, h("h2", null, g[0], h("span", { class: "n" }, String(items.length))), ul));
    });
  }

  /* Darstellung: Statistik */
  function renderStats() {
    var box = $("stats");
    box.replaceChildren();
    var today = dn(todayStr());
    var span = period === "all" ? null : Number(period);
    var items = logs.filter(function (l) { return l.date && (span === null || dn(l.date) >= today - (span - 1)); });
    if (!items.length) {
      box.append(h("div", { class: "empty" },
        h("b", null, "Noch keine Erledigungen in diesem Zeitraum"),
        h("span", null, "Sobald ihr Aufgaben abhakt, seht ihr hier, wer wie viel übernimmt. Die Zählung beginnt mit dem ersten Abhaken.")));
      return;
    }
    var f = 0, c = 0, rooms = {};
    items.forEach(function (l) {
      var r = l.room || "Überall";
      if (!rooms[r]) rooms[r] = { F: 0, C: 0 };
      if (l.by === "C") { c++; rooms[r].C++; } else { f++; rooms[r].F++; }
    });
    var total = f + c;
    var pf = Math.round(f / total * 100), pc = 100 - pf;
    var fairText = f === c ? "Ihr teilt euch die Arbeit gleichmäßig auf."
      : (f > c ? "F" : "C") + " hat " + Math.max(pf, pc) + " % der erledigten Aufgaben übernommen.";

    box.append(h("div", { class: "panel" },
      h("h2", null, total + (total === 1 ? " Aufgabe erledigt" : " Aufgaben erledigt")),
      h("div", { class: "duo" },
        h("div", { class: "who F" }, h("span", { class: "num" }, String(f)), h("span", { class: "lbl" }, "F · " + pf + " %")),
        h("div", { class: "who C" }, h("span", { class: "num" }, String(c)), h("span", { class: "lbl" }, "C · " + pc + " %"))),
      h("div", { class: "bar", role: "img", "aria-label": "F " + pf + " Prozent, C " + pc + " Prozent" },
        h("span", { class: "bf", style: "width:" + pf + "%" }), h("span", { class: "bc", style: "width:" + pc + "%" })),
      h("p", { class: "fair" }, fairText)));

    /* letzte 8 Wochen, unabhängig vom gewählten Zeitraum */
    var w0 = weekStart(today) - 49;
    var weeks = [];
    for (var i = 0; i < 8; i++) weeks.push({ start: w0 + i * 7, F: 0, C: 0 });
    logs.forEach(function (l) {
      if (!l.date) return;
      var idx = Math.floor((weekStart(dn(l.date)) - w0) / 7);
      if (idx >= 0 && idx < 8) weeks[idx][l.by === "C" ? "C" : "F"]++;
    });
    var wmax = 1;
    weeks.forEach(function (w) { if (w.F + w.C > wmax) wmax = w.F + w.C; });
    var unit = 96 / wmax;
    var cols = h("div", { class: "weeks" });
    var labels = h("div", { class: "wklabels" });
    weeks.forEach(function (w, i) {
      var t = w.F + w.C;
      cols.append(h("div", { class: "wk", title: "Woche ab " + dayLabel(w.start) + ": F " + w.F + ", C " + w.C },
        h("span", { class: "tot" }, t ? String(t) : ""),
        h("div", { class: "stack", style: "height:" + (t * unit) + "px" },
          h("div", { class: "sc", style: "height:" + (w.C * unit) + "px" }),
          h("div", { class: "sf", style: "height:" + (w.F * unit) + "px" }))));
      labels.append(h("span", { class: i === 7 ? "cur" : "" }, dayLabel(w.start)));
    });
    box.append(h("div", { class: "panel" }, h("h2", null, "Erledigt pro Woche"), cols, labels,
      h("div", { class: "legend" },
        h("span", null, h("i", { style: "background:var(--f)" }), "F"),
        h("span", null, h("i", { style: "background:var(--c)" }), "C"),
        h("span", null, "Woche beginnt montags"))));

    var names = Object.keys(rooms).sort(function (a, b) { return (rooms[b].F + rooms[b].C) - (rooms[a].F + rooms[a].C) || a.localeCompare(b, "de"); });
    var max = rooms[names[0]].F + rooms[names[0]].C;
    var roomPanel = h("div", { class: "panel" }, h("h2", null, "Nach Bereich"));
    names.forEach(function (n) {
      var r = rooms[n];
      roomPanel.append(h("div", { class: "rrow" },
        h("span", { class: "rn" }, n),
        h("div", { class: "rbar", role: "img", "aria-label": n + ": F " + r.F + ", C " + r.C },
          h("span", { class: "bf", style: "width:" + (r.F / max * 100) + "%" }),
          h("span", { class: "bc", style: "width:" + (r.C / max * 100) + "%" })),
        h("span", { class: "rc" }, "F " + r.F + " · C " + r.C)));
    });
    box.append(roomPanel);

    var recent = items.slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0) || String(b.date).localeCompare(String(a.date)); }).slice(0, 8);
    var ul = h("ul", { class: "recent" });
    recent.forEach(function (l) {
      var who = l.by === "C" ? "C" : "F";
      ul.append(h("li", null, h("span", { class: "chip " + who }, who), h("span", { class: "rt" }, l.task || "Aufgabe"), h("span", { class: "rd" }, fmt(l.date))));
    });
    box.append(h("div", { class: "panel" }, h("h2", null, "Zuletzt erledigt"), ul));
    box.append(h("p", { class: "foot" }, "Gezählt wird ab dem ersten Abhaken in dieser Version."));
  }

  /* Einkauf: Aktionen */
  function setDone(it, done) {
    if (!db) return;
    var upd = done ? { done: true, doneAt: Date.now(), by: me || "" } : { done: false, at: Date.now(), by: me || "" };
    db.doc("shop/" + it.id).update(upd).catch(writeFail);
  }
  function delItem(it) { if (db) db.doc("shop/" + it.id).delete().catch(writeFail); }
  function addItems(text) {
    if (!db || !curStore) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var seen = {};
    text.split(",").map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (n) {
      var key = n.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      if (putOnList(curStore, n) === "dup") toast("„" + n + "“ steht schon auf der Liste.");
    });
  }
  function addStore(name) {
    name = name.trim();
    if (!name) return;
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var dup = (stores || []).filter(function (s) { return String(s.name).toLowerCase() === name.toLowerCase(); })[0];
    if (dup) { curStore = dup.id; lsSet("pp-store", dup.id); addingStore = false; $("newstore").value = ""; renderShop(); return; }
    db.collection("stores").add({ name: name, at: Date.now() }).then(function (ref) {
      curStore = ref.id; lsSet("pp-store", ref.id); addingStore = false; $("newstore").value = ""; renderShop();
    }).catch(writeFail);
  }
  function removeStore(st) {
    confirmStoreDel = false;
    var chain = Promise.resolve();
    items.filter(function (i) { return i.store === st.id; }).forEach(function (i) {
      chain = chain.then(function () { return db.doc("shop/" + i.id).delete(); });
    });
    chain.then(function () { return db.doc("stores/" + st.id).delete(); }).then(function () {
      curStore = null; toast("„" + st.name + "“ wurde entfernt.");
    }).catch(writeFail);
  }
  function cleanBought(st) {
    confirmClean = false;
    var chain = Promise.resolve();
    items.filter(function (i) { return i.store === st.id && i.done; }).forEach(function (i) {
      chain = chain.then(function () { return db.doc("shop/" + i.id).delete(); });
    });
    chain.catch(writeFail);
  }

  /* Einkauf: Darstellung */
  function shopCount(id) { var n = 0; items.forEach(function (i) { if (i.store === id && !i.done) n++; }); return n; }
  function renderShop() {
    var head = $("shophead"), bar = $("stores"), body = $("shopbody");
    bar.replaceChildren(); body.replaceChildren();
    if (stores === null) { head.textContent = "Einkaufsliste wird geladen …"; $("quickform").hidden = true; $("storeform").hidden = true; return; }
    var list = stores.slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0) || String(a.name).localeCompare(String(b.name), "de"); });
    if (!list.some(function (s) { return s.id === curStore; })) curStore = list.length ? list[0].id : null;
    var st = list.filter(function (s) { return s.id === curStore; })[0] || null;
    var openAll = items.filter(function (i) { return !i.done; }).length;
    head.textContent = !items.length ? "Noch nichts auf der Liste." : openAll === 0 ? "Alles eingekauft." : openAll === 1 ? "1 Artikel steht auf der Liste." : openAll + " Artikel stehen auf der Liste.";

    list.forEach(function (s) {
      bar.append(h("button", { class: "store", type: "button", "aria-pressed": String(s.id === curStore), onclick: function () {
        curStore = s.id; lsSet("pp-store", s.id); addingStore = false; confirmStoreDel = false; confirmClean = false; renderShop();
      } }, s.name, h("span", { class: "cnt" }, String(shopCount(s.id)))));
    });
    bar.append(h("button", { class: "store add", type: "button", onclick: function () { addingStore = true; renderShop(); $("newstore").focus(); } }, "+ Laden"));

    var showStoreForm = addingStore || !st;
    $("storeform").hidden = !showStoreForm;
    $("storecancel").hidden = !st;
    $("storetitle").textContent = st ? "Neuer Laden" : "Euren ersten Laden anlegen";
    $("quickform").hidden = !st || showStoreForm;
    $("quickname").placeholder = st ? "Zu " + st.name + " hinzufügen …" : "Artikel hinzufügen …";

    var dl = $("knownitems"); dl.replaceChildren();
    var known = {};
    items.forEach(function (i) { if (i.store === curStore && i.done && !known[i.name]) { known[i.name] = true; dl.append(h("option", { value: i.name })); } });

    if (dbMissing) {
      body.append(h("div", { class: "banner" }, h("p", null, connText())));
      return;
    }
    if (!st) return;

    var mine = items.filter(function (i) { return i.store === st.id; });
    var open = mine.filter(function (i) { return !i.done; }).sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var done = mine.filter(function (i) { return i.done; }).sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });

    if (!open.length) {
      body.append(h("div", { class: "empty" },
        h("b", null, mine.length ? "Alles für " + st.name + " eingekauft" : "Noch nichts für " + st.name),
        h("span", null, mine.length ? "Tippe unten auf einen Artikel, um ihn wieder auf die Liste zu setzen." : "Schreib oben den ersten Artikel hinein. Mehrere gehen mit Komma: Milch, Brot, Butter.")));
    } else {
      var ul = h("ul", { class: "items" });
      open.forEach(function (it) {
        var chk = h("button", { class: "check", type: "button", "aria-label": "Gekauft: " + it.name, onclick: function () { setDone(it, true); } });
        chk.innerHTML = CHECK;
        ul.append(h("li", null, chk, h("span", { class: "nm" }, it.name),
          h("button", { class: "x", type: "button", "aria-label": it.name + " von der Liste entfernen", onclick: function () { delItem(it); } }, "×")));
      });
      body.append(ul);
    }

    if (done.length) {
      var chips = h("div", { class: "bought" });
      done.forEach(function (it) { chips.append(h("button", { class: "bchip", type: "button", onclick: function () { setDone(it, false); } }, it.name)); });
      var cleanRow = h("div", { class: "row" });
      if (confirmClean) {
        cleanRow.append(
          h("button", { class: "linkbtn danger", type: "button", onclick: function () { cleanBought(st); } }, "Ja, alle löschen"),
          h("button", { class: "linkbtn", type: "button", onclick: function () { confirmClean = false; renderShop(); } }, "Abbrechen"));
      } else {
        cleanRow.append(h("button", { class: "linkbtn", type: "button", onclick: function () { confirmClean = true; renderShop(); } }, "Gekaufte Artikel aufräumen"));
      }
      body.append(h("section", { class: "group" },
        h("h2", null, "Schon gekauft", h("span", { class: "n" }, String(done.length))),
        chips, cleanRow));
    }

    var delRow = h("div", { class: "row" });
    if (confirmStoreDel) {
      delRow.append(
        h("button", { class: "linkbtn danger", type: "button", onclick: function () { removeStore(st); } }, "Ja, " + st.name + " samt Liste löschen"),
        h("button", { class: "linkbtn", type: "button", onclick: function () { confirmStoreDel = false; renderShop(); } }, "Abbrechen"));
    } else {
      delRow.append(h("button", { class: "linkbtn", type: "button", onclick: function () { confirmStoreDel = true; renderShop(); } }, "Laden entfernen"));
    }
    body.append(delRow);
  }

  /* Gemeinsame Helfer für Läden und Einkaufsliste */
  function sortedStores() { return (stores || []).slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0) || String(a.name).localeCompare(String(b.name), "de"); }); }
  function storeName(id) { var s = (stores || []).filter(function (x) { return x.id === id; })[0]; return s ? s.name : ""; }
  function resolveStore(id) { if (id && storeName(id)) return id; var l = sortedStores(); return l.length ? l[0].id : ""; }
  function putOnList(storeId, name) {
    var key = String(name).toLowerCase();
    var ex = items.filter(function (i) { return i.store === storeId && String(i.name).toLowerCase() === key; })[0];
    if (ex && ex.done) { setDone(ex, false); return "back"; }
    if (ex) return "dup";
    db.collection("shop").add({ store: storeId, name: name, done: false, by: me || "", at: Date.now() }).catch(writeFail);
    return "added";
  }
  function guessStore(name) {
    var key = String(name).trim().toLowerCase();
    if (!key) return "";
    var found = "";
    (recipes || []).forEach(function (r) { (r.ingredients || []).forEach(function (g) { if (!found && String(g.name).toLowerCase() === key && storeName(g.store)) found = g.store; }); });
    if (!found) items.forEach(function (i) { if (!found && String(i.name).toLowerCase() === key && storeName(i.store)) found = i.store; });
    return found;
  }

  /* Kochbuch: Ablauf */
  function setCookMode(m) {
    cookMode = m;
    $("cooklist").hidden = m !== "list";
    $("cookpanel").hidden = m !== "pantry";
    $("recform").hidden = m !== "edit";
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  function dishEl(r) {
    var on = !!picked[r.id];
    var ings = r.ingredients || [];
    var pick = h("button", { class: "pick", type: "button", "aria-pressed": String(on), "aria-label": (on ? "Abwählen: " : "Auswählen: ") + r.name, onclick: function () {
      if (picked[r.id]) delete picked[r.id]; else picked[r.id] = true;
      renderCook();
    } });
    pick.innerHTML = CHECK;
    var names = ings.map(function (g) { return g.name; }).join(" · ");
    return h("li", { class: "dish" + (on ? " on" : "") }, pick,
      h("div", { class: "dbody" },
        h("div", { class: "dishhead" }, h("span", { class: "dname" }, r.name), h("span", { class: "lead" }), h("span", { class: "dcount" }, ings.length + (ings.length === 1 ? " Zutat" : " Zutaten"))),
        h("p", { class: "dings" }, names || "Noch keine Zutaten eingetragen."),
        h("button", { class: "linkbtn dedit", type: "button", onclick: function () { openEditor(r); } }, "Bearbeiten")));
  }
  function renderCookStats() {
    var box = $("cookstats");
    box.replaceChildren();
    if (recipes === null || !planLoaded) { box.append(h("p", { class: "note" }, "Statistik wird geladen …")); return; }
    var today = dn(todayStr());
    var span = cookPeriod === "all" ? null : Number(cookPeriod);
    var counts = {}, total = 0, everEaten = {};
    Object.keys(plan).forEach(function (ds) {
      var n = dn(ds);
      if (isNaN(n) || n > today) return;
      (plan[ds].dishes || []).forEach(function (d) {
        var rec = recipes.filter(function (r) { return r.id === d.id; })[0];
        var key = d.id || d.name;
        everEaten[key] = true;
        if (span !== null && n < today - (span - 1)) return;
        if (!counts[key]) counts[key] = { name: rec ? rec.name : d.name, n: 0, last: ds };
        counts[key].n++; total++;
        if (ds > counts[key].last) counts[key].last = ds;
      });
    });

    var seg = h("div", { class: "seg", role: "group", "aria-label": "Zeitraum" });
    [["30", "30 Tage"], ["90", "90 Tage"], ["all", "Gesamt"]].forEach(function (p) {
      seg.append(h("button", { type: "button", "aria-pressed": String(cookPeriod === p[0]), onclick: function () { cookPeriod = p[0]; renderCookStats(); } }, p[1]));
    });
    box.append(h("div", { class: "cookhead" }, h("p", { class: "headline" }, "Was ihr esst"), seg));

    var names = Object.keys(counts).sort(function (a, b) { return counts[b].n - counts[a].n || String(counts[a].name).localeCompare(String(counts[b].name), "de"); });
    if (!names.length) {
      box.append(h("div", { class: "empty" }, h("b", null, "Noch nichts gegessen in diesem Zeitraum"), h("span", null, "Plane Gerichte im Essensplan ein. Gezählt werden alle Tage bis einschließlich heute.")));
    } else {
      var top = counts[names[0]];
      box.append(h("div", { class: "panel" },
        h("h2", null, "Überblick"),
        h("div", { class: "duo" },
          h("div", { class: "who K" }, h("span", { class: "num" }, String(total)), h("span", { class: "lbl" }, total === 1 ? "Mahlzeit" : "Mahlzeiten")),
          h("div", { class: "who K C" }, h("span", { class: "num" }, String(names.length)), h("span", { class: "lbl" }, names.length === 1 ? "Gericht" : "verschiedene Gerichte"))),
        h("p", { class: "fair" }, "Am häufigsten: " + top.name + " (" + top.n + "×).")));
      var max = counts[names[0]].n;
      var rank = h("div", { class: "panel" }, h("h2", null, "Rangliste"));
      names.forEach(function (k) {
        var c = counts[k];
        rank.append(h("div", { class: "rrow" },
          h("span", { class: "rn" }, c.name),
          h("div", { class: "rbar", role: "img", "aria-label": c.name + ": " + c.n + " mal" }, h("span", { class: "bk", style: "width:" + (c.n / max * 100) + "%" })),
          h("span", { class: "rc" }, c.n + "× · zuletzt " + fmt(c.last))));
      });
      box.append(rank);
    }

    var never = recipes.filter(function (r) { return !everEaten[r.id]; }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "de"); });
    if (never.length) {
      var nl = h("div", { class: "never" });
      never.forEach(function (r) { nl.append(h("span", null, r.name)); });
      box.append(h("div", { class: "panel" }, h("h2", null, "Noch nie gegessen"), nl));
    }
  }

  function renderCook() {
    var box = $("cookmain");
    box.replaceChildren();
    if (recipes === null) { $("cookhead").textContent = "Kochbuch wird geladen …"; $("pickbar").hidden = true; return; }
    var statsOn = cookTab === "stats";
    $("cookstats").hidden = !statsOn;
    $("cookheadrow").hidden = statsOn;
    box.hidden = statsOn;
    Array.prototype.forEach.call($("cookseg").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === cookTab)); });
    if (statsOn) { $("pickbar").hidden = true; renderCookStats(); return; }
    Object.keys(picked).forEach(function (id) { if (!recipes.some(function (r) { return r.id === id; })) delete picked[id]; });
    $("cookhead").textContent = recipes.length ? "Speisekarte" : "Noch keine Gerichte";
    if (dbMissing) {
      box.append(h("div", { class: "banner" }, h("p", null, connText())));
    } else if (recipes.some(function (r) { return r.example === true; })) {
      var btn = confirmCookEx
        ? h("button", { class: "linkbtn danger", type: "button", onclick: removeCookExamples }, "Ja, alle Beispiele löschen")
        : h("button", { class: "linkbtn", type: "button", onclick: function () { confirmCookEx = true; renderCook(); } }, "Beispiele entfernen");
      box.append(h("div", { class: "banner" }, h("p", null, "Das sind Beispielgerichte zum Ausprobieren. Entfernt sie, sobald ihr eure eigenen eingetragen habt."), btn));
    }
    if (!recipes.length) {
      box.append(h("div", { class: "empty" }, h("b", null, "Eure Speisekarte ist noch leer"), h("span", null, "Tippe oben auf „+ Gericht“ und trag ein Gericht mit seinen Zutaten ein. Jede Zutat bekommt den Laden, in dem ihr sie kauft.")));
    } else {
      var ul = h("ul", { class: "dishes" });
      recipes.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "de"); }).forEach(function (r) { ul.append(dishEl(r)); });
      box.append(ul);
    }
    var n = Object.keys(picked).length;
    $("pickbar").hidden = n === 0;
    $("pickcount").textContent = n === 1 ? "1 Gericht gewählt" : n + " Gerichte gewählt";
  }
  function removeCookExamples() {
    confirmCookEx = false;
    var chain = Promise.resolve();
    (recipes || []).filter(function (r) { return r.example === true; }).forEach(function (r) {
      chain = chain.then(function () { return db.doc("recipes/" + r.id).delete(); });
    });
    chain.then(function () { toast("Beispielgerichte entfernt."); }).catch(writeFail);
  }

  /* Kochbuch: Vorrat abfragen, dann auf die Listen setzen */
  function openPantry() {
    var map = {}, order = [];
    recipes.filter(function (r) { return picked[r.id]; }).forEach(function (r) {
      (r.ingredients || []).forEach(function (g) {
        var sid = resolveStore(g.store);
        var key = sid + "|" + String(g.name).toLowerCase();
        if (!map[key]) { map[key] = { name: g.name, store: sid, dishes: [], home: false }; order.push(key); }
        if (map[key].dishes.indexOf(r.name) < 0) map[key].dishes.push(r.name);
      });
    });
    pantry = { rows: order.map(function (k) { return map[k]; }) };
    setCookMode("pantry");
    renderPantry();
  }
  function renderPantry() {
    var box = $("cookpanel");
    box.replaceChildren();
    var rows = pantry.rows;
    var need = rows.filter(function (r) { return !r.home; }).length;
    var panel = h("div", { class: "panel" },
      h("h2", null, "Was ist schon zuhause?"),
      h("p", { class: "fair" }, "Hake an, was ihr noch auf Vorrat habt. Alles andere kommt auf die Einkaufslisten."));
    if (!rows.length) {
      panel.append(h("p", { class: "note" }, "Die gewählten Gerichte haben noch keine Zutaten."));
    }
    var ids = sortedStores().map(function (s) { return s.id; });
    if (rows.some(function (r) { return ids.indexOf(r.store) < 0; })) ids.push("");
    ids.forEach(function (sid) {
      var mine = rows.filter(function (r) { return r.store === sid; });
      if (!mine.length) return;
      var grp = h("div", { class: "pgroup" }, h("h3", null, sid ? storeName(sid) : "Ohne Laden"));
      mine.forEach(function (r) {
        var bx = h("span", { class: "box" });
        bx.innerHTML = CHECK;
        grp.append(h("button", { class: "have", type: "button", "aria-pressed": String(r.home), onclick: function () { r.home = !r.home; renderPantry(); } },
          bx, h("span", null, h("span", { class: "pn" }, r.name), h("span", { class: "pfor" }, "für " + r.dishes.join(", ")))));
      });
      panel.append(grp);
    });
    panel.append(h("div", { class: "row" },
      h("button", { class: "primary", type: "button", onclick: confirmPantry }, need ? "Auf die Listen setzen (" + need + ")" : "Nichts kaufen, alles da"),
      h("button", { class: "linkbtn", type: "button", onclick: function () { setCookMode("list"); renderCook(); } }, "Zurück")));
    box.append(panel);
  }
  function confirmPantry() {
    var need = pantry.rows.filter(function (r) { return !r.home; });
    if (!need.length) { picked = {}; setCookMode("list"); renderCook(); toast("Alles ist zuhause, es muss nichts gekauft werden."); return; }
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    if (!(stores || []).length) { toast("Lege zuerst im Einkauf einen Laden an."); return; }
    var counts = {};
    need.forEach(function (r) {
      var sid = resolveStore(r.store);
      if (putOnList(sid, r.name) !== "dup") counts[sid] = (counts[sid] || 0) + 1;
    });
    var ids = Object.keys(counts);
    picked = {};
    setCookMode("list");
    renderCook();
    if (!ids.length) { toast("Alles stand schon auf euren Listen."); return; }
    var parts = ids.map(function (id) { return storeName(id) + " " + counts[id]; }).join(", ");
    toast("Auf den Listen: " + parts + ".", "Zum Einkauf", function () {
      section = "shop"; lsSet("pp-section", "shop");
      curStore = ids[0]; lsSet("pp-store", ids[0]);
      syncControls(); renderShop();
    });
  }

  /* Kochbuch: Gericht anlegen oder bearbeiten */
  function openEditor(r) {
    confirmRecDel = false;
    if (r) {
      draft = { id: r.id, name: r.name || "", at: r.at || 0, ings: (r.ingredients || []).map(function (g) { return { name: g.name || "", store: resolveStore(g.store), touched: true }; }) };
    } else {
      draft = { id: null, name: "", at: 0, ings: [] };
    }
    if (!draft.ings.length) draft.ings.push({ name: "", store: resolveStore(curStore), touched: false });
    setCookMode("edit");
    renderEditor();
    if (!r) $("recname").focus();
  }
  function addIngRow() {
    var last = draft.ings[draft.ings.length - 1];
    draft.ings.push({ name: "", store: last ? last.store : resolveStore(curStore), touched: false });
    renderEditor();
    var inputs = $("recform").querySelectorAll(".ingname");
    if (inputs.length) inputs[inputs.length - 1].focus();
  }
  function renderEditor() {
    var box = $("recform");
    box.replaceChildren();
    var storeList = sortedStores();
    var nameIn = h("input", { id: "recname", type: "text", maxlength: "80", placeholder: "z. B. Spaghetti Bolognese", "aria-label": "Name des Gerichts", value: draft.name, oninput: function (e) { draft.name = e.target.value; } });
    var panel = h("div", { class: "panel" }, h("h2", null, draft.id ? "Gericht bearbeiten" : "Neues Gericht"), nameIn, h("h2", null, "Zutaten und Laden"));
    draft.ings.forEach(function (g, idx) {
      var sel = h("select", { "aria-label": "Laden für Zutat " + (idx + 1), onchange: function (e) { g.store = e.target.value; g.touched = true; } });
      storeList.forEach(function (s) { sel.append(h("option", { value: s.id, selected: s.id === g.store }, s.name)); });
      var nm = h("input", { class: "ingname", type: "text", maxlength: "80", placeholder: "z. B. 500 g Hackfleisch", "aria-label": "Zutat " + (idx + 1), value: g.name,
        oninput: function (e) { g.name = e.target.value; },
        onchange: function () {
          if (g.touched) return;
          var gs = guessStore(g.name);
          if (gs) { g.store = gs; sel.value = gs; }
        },
        onkeydown: function (e) { if (e.key === "Enter") { e.preventDefault(); addIngRow(); } } });
      var rm = h("button", { class: "x", type: "button", "aria-label": "Zutat entfernen", onclick: function () {
        draft.ings.splice(idx, 1);
        if (!draft.ings.length) draft.ings.push({ name: "", store: resolveStore(curStore), touched: false });
        renderEditor();
      } }, "×");
      panel.append(h("div", { class: "ingrow" }, nm, sel, rm));
    });
    panel.append(h("div", { class: "row" }, h("button", { class: "linkbtn", type: "button", onclick: addIngRow }, "+ Zutat")));
    var actions = h("div", { class: "row" },
      h("button", { class: "primary", type: "button", onclick: saveRecipe }, "Speichern"),
      h("button", { class: "linkbtn", type: "button", onclick: function () { setCookMode("list"); renderCook(); } }, "Abbrechen"));
    if (draft.id) {
      if (confirmRecDel) {
        actions.append(
          h("button", { class: "linkbtn danger", type: "button", onclick: deleteRecipe }, "Ja, Gericht löschen"),
          h("button", { class: "linkbtn", type: "button", onclick: function () { confirmRecDel = false; renderEditor(); } }, "Doch nicht"));
      } else {
        actions.append(h("button", { class: "linkbtn", type: "button", onclick: function () { confirmRecDel = true; renderEditor(); } }, "Gericht löschen"));
      }
    }
    panel.append(actions);
    box.append(panel);
  }
  function saveRecipe() {
    var name = draft.name.trim();
    if (!name) { toast("Gib dem Gericht einen Namen."); $("recname").focus(); return; }
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var ings = draft.ings.map(function (g) { return { name: g.name.trim(), store: g.store || "" }; }).filter(function (g) { return g.name; });
    var p;
    if (draft.id) p = db.doc("recipes/" + draft.id).update({ name: name, ingredients: ings, example: false });
    else p = db.collection("recipes").add({ name: name, ingredients: ings, at: Date.now() });
    p.then(function () { setCookMode("list"); renderCook(); toast("„" + name + "“ ist gespeichert."); }).catch(writeFail);
  }
  function deleteRecipe() {
    if (!db || !draft.id) return;
    var nm = draft.name;
    confirmRecDel = false;
    db.doc("recipes/" + draft.id).delete().then(function () { setCookMode("list"); renderCook(); toast("„" + nm + "“ wurde gelöscht."); }).catch(writeFail);
  }

  /* Essensplan */
  var WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  function dnToStr(n) { var d = new Date(n * 864e5); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function setDay(ds, dishes) {
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var p = dishes.length ? db.doc("plan/" + ds).set({ date: ds, dishes: dishes, at: Date.now() }) : db.doc("plan/" + ds).delete();
    p.catch(writeFail);
  }
  function dayEl(n, ds, dishes, today) {
    var cls = "day" + (n === today ? " today" : "") + (n < today ? " past" : "");
    var lab = h("div", { class: "dlab" }, h("b", null, WD[(n + 3) % 7]), h("span", null, dayLabel(n)));
    var body = h("div", { class: "dmeals" });
    if (dishes.length) {
      var chips = h("div", { class: "mealchips" });
      dishes.forEach(function (d, idx) {
        var rec = (recipes || []).filter(function (r) { return r.id === d.id; })[0];
        var nm = rec ? rec.name : d.name;
        chips.append(h("span", { class: "meal" }, nm,
          h("button", { class: "x", type: "button", "aria-label": nm + " aus dem Plan nehmen", onclick: function () {
            setDay(ds, dishes.filter(function (_, j) { return j !== idx; }));
          } }, "×")));
      });
      body.append(chips);
    } else if (pickDay !== ds) {
      body.append(h("p", { class: "noneyet" }, "Noch nichts geplant"));
    }
    if (pickDay === ds) {
      var list = (recipes || []).slice().sort(function (a, b) {
        return (picked[b.id] ? 1 : 0) - (picked[a.id] ? 1 : 0) || String(a.name).localeCompare(String(b.name), "de");
      });
      if (!list.length) body.append(h("p", { class: "noneyet" }, "Lege zuerst im Kochbuch ein Gericht an."));
      else {
        var pk = h("div", { class: "picker" });
        list.forEach(function (r) {
          pk.append(h("button", { class: "bchip" + (picked[r.id] ? " sel" : ""), type: "button", onclick: function () {
            pickDay = null;
            if (dishes.some(function (d) { return d.id === r.id; })) { renderMeal(); return; }
            setDay(ds, dishes.concat([{ id: r.id, name: r.name }]));
            renderMeal();
          } }, r.name + (picked[r.id] ? " · gewählt" : "")));
        });
        body.append(pk);
      }
    }
    body.append(h("button", { class: "linkbtn", type: "button", onclick: function () { pickDay = pickDay === ds ? null : ds; renderMeal(); } }, pickDay === ds ? "Schließen" : "+ Gericht"));
    return h("div", { class: cls }, lab, body);
  }
  function renderMeal() {
    var box = $("mealdays");
    box.replaceChildren();
    var mon = weekStart(dn(todayStr())) + weekOffset * 7;
    var today = dn(todayStr());
    $("weeklabel").textContent = (weekOffset === 0 ? "Diese Woche · " : "") + dayLabel(mon) + " – " + dayLabel(mon + 6);
    $("weektoday").hidden = weekOffset === 0;
    if (!planLoaded || recipes === null) { $("mealhead").textContent = "Essensplan wird geladen …"; $("mealshop").hidden = true; return; }
    var total = 0, ids = {};
    for (var i = 0; i < 7; i++) {
      var n = mon + i, ds = dnToStr(n);
      var doc = plan[ds];
      var dishes = doc && doc.dishes ? doc.dishes : [];
      total += dishes.length;
      dishes.forEach(function (d) { ids[d.id] = true; });
      box.append(dayEl(n, ds, dishes, today));
    }
    $("mealhead").textContent = total === 0 ? "Noch nichts geplant" : total === 1 ? "1 Gericht geplant" : total + " Gerichte geplant";
    mealIds = Object.keys(ids).filter(function (id) { return recipes.some(function (r) { return r.id === id; }); });
    $("mealshop").hidden = !mealIds.length;
    $("mealshop").textContent = mealIds.length === 1 ? "Zutaten für 1 Gericht einkaufen" : "Zutaten für " + mealIds.length + " Gerichte einkaufen";
  }

  /* Ausgaben */
  var DEFAULT_CATS = ["Lebensmittel", "Drogerie", "Haushalt", "Restaurant", "Freizeit", "Mobilität", "Gesundheit", "Kleidung", "Sonstiges"];
  function parseEuro(s) {
    s = String(s).trim().replace(/[\s€]/g, "");
    if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
    var v = parseFloat(s);
    if (!isFinite(v) || v <= 0) return null;
    return Math.round(v * 100);
  }
  function eur(c) { return (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" }); }
  function toInput(c) { return (c / 100).toFixed(2).replace(".", ","); }
  function fmtY(s) { var p = String(s).split("-"); return p[2] + "." + p[1] + "." + p[0]; }
  function pct(x) { return x.toFixed(1).replace(".", ",") + " %"; }
  function budgetLabel(b) { return (b.name ? b.name + " · " : "") + fmt(b.start) + "–" + fmtY(b.end); }
  function sortedBudgets() { return (budgets || []).slice().sort(function (a, b) { return String(b.start).localeCompare(String(a.start)); }); }
  function resolveBudget() {
    var list = sortedBudgets();
    var hit = list.filter(function (b) { return b.id === curBudget; })[0];
    if (hit) return hit;
    var t = todayStr();
    hit = list.filter(function (b) { return b.start <= t && t <= b.end; })[0] || list[0] || null;
    return hit;
  }
  function openBudgetForm(mode, b) {
    budgetForm = mode; confirmBudgetDel = false;
    var t = todayStr(), y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
    var last = new Date(y, m, 0).getDate();
    $("bname").value = b ? (b.name || "") : "";
    $("bstart").value = b ? b.start : y + "-" + pad(m) + "-01";
    $("bend").value = b ? b.end : y + "-" + pad(m) + "-" + pad(last);
    $("bamount").value = b ? toInput(b.amount) : "";
  }
  function svgEl(tag, attrs) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function delSpend(s) {
    if (!db) return;
    var copy = Object.assign({}, s); delete copy.id;
    db.doc("spend/" + s.id).delete().then(function () {
      toast("Ausgabe gelöscht.", "Rückgängig", function () { db.doc("spend/" + s.id).set(copy).catch(writeFail); });
    }).catch(writeFail);
  }

  function renderCats(box, mine, total) {
    box.replaceChildren();
    if (!mine.length) return;
    var map = {}, order = [];
    mine.forEach(function (s) {
      var name = String(s.category || "").trim() || "Sonstiges";
      var key = name.toLowerCase();
      if (!map[key]) { map[key] = { name: name, cents: 0, n: 0 }; order.push(key); }
      map[key].cents += s.amount || 0; map[key].n++;
    });
    var rows = order.map(function (k) { return map[k]; }).sort(function (a, b) { return b.cents - a.cents || a.name.localeCompare(b.name, "de"); });
    if (rows.length > 8) {
      var rest = rows.slice(7);
      rows = rows.slice(0, 7).concat([{ name: "Weitere (" + rest.length + ")", cents: rest.reduce(function (a, r) { return a + r.cents; }, 0), n: rest.reduce(function (a, r) { return a + r.n; }, 0) }]);
    }
    var svg = svgEl("svg", { class: "donut", viewBox: "0 0 42 42", role: "img", "aria-label": "Ausgaben nach Kategorie: " + rows.map(function (r) { return r.name + " " + pct(r.cents / total * 100); }).join(", ") });
    svg.append(svgEl("circle", { class: "ring", cx: "21", cy: "21", r: "15.9155", "stroke-width": "6" }));
    var cum = 0;
    rows.forEach(function (r, i) {
      var p = r.cents / total * 100;
      if (p <= 0) return;
      svg.append(svgEl("circle", { cx: "21", cy: "21", r: "15.9155", "stroke-width": "6",
        "stroke-dasharray": Math.max(p - 0.4, 0.2) + " " + (100 - Math.max(p - 0.4, 0.2)),
        "stroke-dashoffset": String(25 - cum), style: "stroke:var(--k" + (i + 1) + ")" }));
      cum += p;
    });
    var t1 = svgEl("text", { x: "21", y: "21.6", "font-size": "4.6" }); t1.textContent = eur(total);
    var t2 = svgEl("text", { class: "sub", x: "21", y: "26.4", "font-size": "2.8" }); t2.textContent = "ausgegeben";
    svg.append(t1, t2);

    var table = h("table", { class: "cattable" });
    table.append(h("thead", null, h("tr", null, h("th", null, "Kategorie"), h("th", { class: "r" }, "Betrag"), h("th", { class: "r" }, "Anteil"))));
    var tb = h("tbody");
    rows.forEach(function (r, i) {
      tb.append(h("tr", null,
        h("td", null, h("div", { class: "cn-in" }, h("span", { class: "sw-dot", style: "background:var(--k" + (i + 1) + ")" }), h("span", null, r.name))),
        h("td", { class: "r" }, eur(r.cents)),
        h("td", { class: "r" }, pct(r.cents / total * 100))));
    });
    table.append(tb);
    box.append(h("div", { class: "panel" }, h("h2", null, "Nach Kategorie"), h("div", { class: "catwrap" }, svg, table)));
  }

  function renderSpend() {
    var head = $("spendhead");
    var parts = ["budgetbar", "budgetform", "spendsum", "spendform", "spendlist", "spendcats"];
    function hideAll() { parts.forEach(function (id) { $(id).hidden = true; }); }
    var ban = $("spendbanner"); ban.replaceChildren();
    if (dbMissing) {
      head.textContent = "Ausgaben";
      hideAll();
      ban.append(h("div", { class: "banner" }, h("p", null, connText())));
      return;
    }
    if (budgets === null) { head.textContent = "Ausgaben werden geladen …"; hideAll(); return; }

    var list = sortedBudgets();
    var b = resolveBudget();
    if (b) { curBudget = b.id; }
    var sel = $("budgetsel");
    sel.replaceChildren();
    list.forEach(function (x) { sel.append(h("option", { value: x.id, selected: b && x.id === b.id }, budgetLabel(x))); });
    $("budgetbar").hidden = !list.length;
    $("budgetform").hidden = !budgetForm;
    $("budgettitle").textContent = budgetForm === "edit" ? "Budget bearbeiten" : (list.length ? "Neues Budget" : "Euer erstes Budget");
    $("budgetcancel").hidden = !list.length;
    $("budgetdel").hidden = budgetForm !== "edit";
    $("budgetdel").textContent = confirmBudgetDel ? "Ja, Budget samt Ausgaben löschen" : "Budget löschen";
    $("budgetdel").className = "linkbtn" + (confirmBudgetDel ? " danger" : "");

    var sum = $("spendsum"), lst = $("spendlist"), cats = $("spendcats");
    sum.replaceChildren(); lst.replaceChildren(); cats.replaceChildren();
    if (!b) {
      head.textContent = "Noch kein Budget";
      $("spendform").hidden = true; sum.hidden = true; lst.hidden = true; cats.hidden = true;
      return;
    }
    sum.hidden = false; lst.hidden = false; cats.hidden = false;
    $("spendform").hidden = !!budgetForm;

    var mine = spends.filter(function (s) { return s.budget === b.id; });
    var spent = mine.reduce(function (a, s) { return a + (s.amount || 0); }, 0);
    var left = b.amount - spent;
    var over = left < 0;
    var today = dn(todayStr()), ds = dn(b.start), de = dn(b.end);
    var totalDays = de - ds + 1;
    var daysLeft = today > de ? 0 : Math.min(totalDays, de - Math.max(today, ds) + 1);
    var fill = Math.min(100, spent / b.amount * 100);

    head.textContent = over ? "Budget um " + eur(-left) + " überschritten" : "Noch " + eur(left) + " übrig";

    var note;
    if (today < ds) note = "Der Zeitraum startet am " + fmtY(b.start) + ".";
    else if (today > de) note = "Der Zeitraum ist am " + fmtY(b.end) + " zu Ende gegangen.";
    else if (over) note = "Noch " + daysLeft + (daysLeft === 1 ? " Tag" : " Tage") + " bis zum Ende, das Budget ist aber schon aufgebraucht.";
    else note = "Noch " + daysLeft + (daysLeft === 1 ? " Tag" : " Tage") + " bis zum " + fmtY(b.end) + ". Das sind " + eur(Math.floor(left / daysLeft)) + " pro Tag.";

    var wrap = h("div", { class: "pwrap" }, h("div", { class: "pbar" + (over ? " over" : ""), role: "img", "aria-label": pct(spent / b.amount * 100) + " des Budgets ausgegeben" }, h("span", { style: "width:" + fill + "%" })));
    if (today >= ds && today <= de) wrap.append(h("div", { class: "ptick", style: "left:calc(" + ((today - ds + 1) / totalDays * 100) + "% - 1px)", title: "Heute" }));
    sum.append(h("div", { class: "panel" },
      h("h2", null, (b.name ? b.name + " · " : "") + fmt(b.start) + " – " + fmtY(b.end)),
      h("div", { class: "duo sumduo" },
        h("div", { class: "who K" + (over ? " over" : "") }, h("span", { class: "num" }, eur(Math.abs(left))), h("span", { class: "lbl" }, over ? "drüber" : "übrig")),
        h("div", { class: "who R" }, h("span", { class: "num" }, eur(b.amount)), h("span", { class: "lbl" }, "Budget"))),
      wrap,
      h("p", { class: "fair" }, eur(spent) + " ausgegeben (" + pct(spent / b.amount * 100) + "). " + note),
      h("p", { class: "foot" }, "Der Strich zeigt, wie weit der Zeitraum heute ist.")));

    /* Vorschläge für Kategorien */
    var dl = $("catlist"); dl.replaceChildren();
    var seen = {};
    DEFAULT_CATS.concat(spends.map(function (s) { return s.category; })).forEach(function (c) {
      c = String(c || "").trim(); if (!c || seen[c.toLowerCase()]) return;
      seen[c.toLowerCase()] = true; dl.append(h("option", { value: c }));
    });
    if (formBudget !== b.id) {
      var t = todayStr();
      $("sdate").value = t < b.start ? b.start : t > b.end ? b.end : t;
      $("sdate").min = b.start; $("sdate").max = b.end;
      formBudget = b.id;
    }

    /* Liste */
    if (!mine.length) {
      lst.append(h("div", { class: "empty" }, h("b", null, "Noch keine Ausgaben in diesem Budget"), h("span", null, "Trag oben die erste Ausgabe ein, zum Beispiel 12,50 bei Aldi für das Wocheneinkauf.")));
    } else {
      var rows = mine.slice().sort(function (a, c) { return String(c.date).localeCompare(String(a.date)) || (c.at || 0) - (a.at || 0); });
      var ul = h("ul", { class: "spends" });
      rows.forEach(function (s) {
        var meta = [String(s.category || "").trim() || "Sonstiges", s.place, s.date ? fmt(s.date) : ""].filter(Boolean).join(" · ");
        ul.append(h("li", null,
          h("span", { class: "sw" }, s.what || String(s.category || "").trim() || "Ausgabe"),
          h("span", { class: "sa" }, eur(s.amount || 0)),
          h("button", { class: "x", type: "button", "aria-label": "Ausgabe löschen", onclick: function () { delSpend(s); } }, "×"),
          h("span", { class: "sm" }, meta)));
      });
      lst.append(h("section", { class: "group" }, h("h2", null, "Ausgaben", h("span", { class: "n" }, String(mine.length))), ul));
    }
    renderCats(cats, mine, spent);
  }

  function syncControls() {
    Array.prototype.forEach.call($("view").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === view)); });
    Array.prototype.forEach.call($("period").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === period)); });
    Array.prototype.forEach.call($("me").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === me)); });
    Array.prototype.forEach.call($("filter").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === filter)); });
    $("planview").hidden = view !== "plan";
    $("statsview").hidden = view !== "stats";
    $("putzview").hidden = section !== "putz";
    $("shopview").hidden = section !== "shop";
    $("cookview").hidden = section !== "cook";
    $("mealview").hidden = section !== "meal";
    $("spendview").hidden = section !== "spend";
    [["putz", "tabputz"], ["shop", "tabshop"], ["cook", "tabcook"], ["meal", "tabmeal"], ["spend", "tabspend"]].forEach(function (p) {
      var b = $(p[1]);
      if (section === p[0]) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
  }

  /* Start */
  ROOMS.forEach(function (r) { $("newroom").append(h("option", { value: r }, r)); });
  INTERVALS.forEach(function (i) { $("newint").append(h("option", { value: String(i[0]), selected: i[0] === 7 }, i[1])); });

  $("tabputz").addEventListener("click", function () { section = "putz"; lsSet("pp-section", "putz"); syncControls(); });
  $("tabshop").addEventListener("click", function () { section = "shop"; lsSet("pp-section", "shop"); syncControls(); });
  $("tabcook").addEventListener("click", function () { section = "cook"; lsSet("pp-section", "cook"); syncControls(); });
  $("tabspend").addEventListener("click", function () { section = "spend"; lsSet("pp-section", "spend"); syncControls(); renderSpend(); });
  $("budgetsel").addEventListener("change", function (e) {
    curBudget = e.target.value; lsSet("pp-budget", curBudget); budgetForm = null; formBudget = null; renderSpend();
  });
  $("budgetnew").addEventListener("click", function () { openBudgetForm("new", null); renderSpend(); $("bname").focus(); });
  $("budgetedit").addEventListener("click", function () { var b = resolveBudget(); if (!b) return; openBudgetForm("edit", b); renderSpend(); $("bname").focus(); });
  $("budgetcancel").addEventListener("click", function () { budgetForm = null; confirmBudgetDel = false; renderSpend(); });
  $("budgetdel").addEventListener("click", function () {
    var b = resolveBudget(); if (!b || !db) return;
    if (!confirmBudgetDel) { confirmBudgetDel = true; renderSpend(); return; }
    confirmBudgetDel = false;
    var chain = Promise.resolve();
    spends.filter(function (s) { return s.budget === b.id; }).forEach(function (s) { chain = chain.then(function () { return db.doc("spend/" + s.id).delete(); }); });
    chain.then(function () { return db.doc("budgets/" + b.id).delete(); }).then(function () {
      curBudget = null; budgetForm = null; formBudget = null; toast("Budget gelöscht."); renderSpend();
    }).catch(writeFail);
  });
  $("budgetform").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var start = $("bstart").value, end = $("bend").value, cents = parseEuro($("bamount").value);
    if (!start || !end) { toast("Wähle ein Start- und ein Enddatum."); return; }
    if (end < start) { toast("Das Enddatum liegt vor dem Startdatum."); return; }
    if (!cents) { toast("Gib das Budget als Betrag ein, z. B. 400."); return; }
    var doc = { name: $("bname").value.trim(), start: start, end: end, amount: cents };
    var p;
    if (budgetForm === "edit") { var b = resolveBudget(); p = db.doc("budgets/" + b.id).update(doc).then(function () { return b.id; }); }
    else { doc.at = Date.now(); p = db.collection("budgets").add(doc).then(function (ref) { return ref.id; }); }
    p.then(function (id) {
      curBudget = id; lsSet("pp-budget", id); budgetForm = null; formBudget = null; renderSpend(); toast("Budget gespeichert.");
    }).catch(writeFail);
  });
  $("spendform").addEventListener("submit", function (e) {
    e.preventDefault();
    var b = resolveBudget();
    if (!b) return;
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var cents = parseEuro($("samount").value);
    if (!cents) { toast("Gib einen Betrag ein, z. B. 12,50."); $("samount").focus(); return; }
    var date = $("sdate").value || todayStr();
    var doc = { budget: b.id, amount: cents, category: $("scat").value.trim() || "Sonstiges", place: $("splace").value.trim(), what: $("swhat").value.trim(), date: date, by: me || "", at: Date.now() };
    db.collection("spend").add(doc).then(function () {
      $("samount").value = ""; $("swhat").value = ""; $("splace").value = "";
      toast(eur(cents) + " eingetragen.");
      $("samount").focus();
    }).catch(writeFail);
  });
  $("tabmeal").addEventListener("click", function () { section = "meal"; lsSet("pp-section", "meal"); pickDay = null; syncControls(); renderMeal(); });
  $("pickplan").addEventListener("click", function () { section = "meal"; lsSet("pp-section", "meal"); pickDay = null; syncControls(); renderMeal(); });
  $("weekprev").addEventListener("click", function () { weekOffset--; pickDay = null; renderMeal(); });
  $("weeknext").addEventListener("click", function () { weekOffset++; pickDay = null; renderMeal(); });
  $("weektoday").addEventListener("click", function () { weekOffset = 0; pickDay = null; renderMeal(); });
  $("mealshop").addEventListener("click", function () {
    if (!mealIds.length) return;
    picked = {};
    mealIds.forEach(function (id) { picked[id] = true; });
    section = "cook"; lsSet("pp-section", "cook");
    syncControls();
    openPantry();
  });
  $("cookseg").addEventListener("click", function (e) {
    var v = e.target.getAttribute && e.target.getAttribute("data-v");
    if (!v) return;
    cookTab = v; renderCook();
  });
  $("newrecipe").addEventListener("click", function () { openEditor(null); });
  $("pickclear").addEventListener("click", function () { picked = {}; renderCook(); });
  $("pickgo").addEventListener("click", function () {
    if (!Object.keys(picked).length) return;
    openPantry();
  });
  $("quickform").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("quickname").value;
    if (!v.trim()) return;
    addItems(v);
    $("quickname").value = "";
  });
  $("storeform").addEventListener("submit", function (e) { e.preventDefault(); addStore($("newstore").value); });
  $("storecancel").addEventListener("click", function () { addingStore = false; $("newstore").value = ""; renderShop(); });
  $("view").addEventListener("click", function (e) {
    var v = e.target.getAttribute && e.target.getAttribute("data-v");
    if (!v) return;
    view = v; syncControls();
  });
  $("period").addEventListener("click", function (e) {
    var v = e.target.getAttribute && e.target.getAttribute("data-v");
    if (!v) return;
    period = v; syncControls(); renderStats();
  });
  $("me").addEventListener("click", function (e) {
    var v = e.target.getAttribute && e.target.getAttribute("data-v");
    if (!v) return;
    me = v; lsSet("pp-me", v); syncControls();
  });
  $("filter").addEventListener("click", function (e) {
    var v = e.target.getAttribute && e.target.getAttribute("data-v");
    if (!v) return;
    filter = v; lsSet("pp-filter", v); syncControls(); render();
  });

  $("addform").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = $("newname").value.trim();
    if (!name) return;
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var who = $("newwho").value;
    var doc = {
      name: name,
      room: $("newroom").value,
      intervalDays: Number($("newint").value),
      assignee: who,
      turn: who === "abwechselnd" ? "F" : "",
      lastDone: $("newstart").value === "later" ? todayStr() : "",
      lastBy: "",
      countF: 0,
      countC: 0,
      createdAt: todayStr()
    };
    db.collection("tasks").add(doc).then(function () {
      $("newname").value = "";
      toast("„" + name + "“ ist im Plan.");
    }).catch(writeFail);
  });

  document.addEventListener("visibilitychange", function () { if (!document.hidden) render(); });

  syncControls();
  render();

  /* ---------- Daten: Supabase (über js/store-supabase.js) ---------- */
  var COLLS = ["tasks", "log", "stores", "shop", "recipes", "plan", "budgets", "spend"];
  var dataStarted = false;

  function listen(coll, apply) {
    db.collection(coll).onSnapshot(function (snap) {
      apply(snap.docs.map(function (d) { return Object.assign({}, d.data(), { id: d.id }); }));
    }, function (e) { readFail(e); apply([]); });
  }
  function startData(store) {
    db = store;
    listen("tasks", function (a) { tasks = a; render(); });
    listen("log", function (a) { logs = a; renderStats(); });
    listen("stores", function (a) { stores = a; renderShop(); });
    listen("shop", function (a) { items = a; renderShop(); });
    listen("recipes", function (a) { recipes = a; renderCook(); renderMeal(); });
    listen("plan", function (a) {
      var m = {};
      a.forEach(function (d) { m[d.id] = d; });
      plan = m; planLoaded = true;
      renderCookStats(); renderMeal();
      if (cookTab === "stats") renderCook();
    });
    listen("budgets", function (a) {
      budgets = a;
      if (!budgets.length && !budgetForm) openBudgetForm("new", null);
      renderSpend();
    });
    listen("spend", function (a) { spends = a; renderSpend(); });
    store.start();
  }

  /* ---------- Export, Import, Beispieldaten ---------- */
  function setStatus(msg, isErr) { var s = $("setstatus"); s.textContent = msg || ""; s.className = "meta" + (isErr ? " err" : ""); }
  function cleanDeep(v, depth) {
    if (depth > 8) return null;
    if (Array.isArray(v)) return v.slice(0, 500).map(function (x) { return cleanDeep(x, depth + 1); });
    if (v && typeof v === "object") {
      var o = {};
      Object.keys(v).forEach(function (k) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") return;
        o[k] = cleanDeep(v[k], depth + 1);
      });
      return o;
    }
    if (typeof v === "string") return v.slice(0, 2000);
    if (typeof v === "number" && !isFinite(v)) return 0;
    return v;
  }
  function exportData() {
    if (!db) { toast("Keine Verbindung zum Speicher."); return; }
    setStatus("Daten werden gesammelt …");
    Promise.all(COLLS.map(function (c) {
      return db.collection(c).get().then(function (snap) {
        var o = {}; snap.docs.forEach(function (d) { o[d.id] = d.data(); });
        return [c, o];
      });
    })).then(function (pairs) {
      var out = { app: "haushalt", version: 1, exportedAt: new Date().toISOString(), collections: {} };
      var n = 0;
      pairs.forEach(function (p) { out.collections[p[0]] = p[1]; n += Object.keys(p[1]).length; });
      var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "haushalt-backup-" + todayStr() + ".json";
      document.body.append(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      setStatus(n + " Einträge exportiert. Die Datei enthält eure Daten, bewahre sie sicher auf.");
    }).catch(function (e) { setStatus("Export fehlgeschlagen" + (e && e.code ? " (" + e.code + ")" : "") + ".", true); });
  }
  var pendingImport = null;
  function renderImportConfirm() {
    var box = $("importconfirm");
    box.replaceChildren();
    if (!pendingImport) { box.hidden = true; return; }
    box.hidden = false;
    box.append(h("p", null, pendingImport.count + " Einträge aus der Datei importieren? Vorhandene Einträge mit derselben Kennung werden überschrieben."),
      h("div", { class: "row" },
        h("button", { class: "primary", type: "button", onclick: runImport }, "Ja, importieren"),
        h("button", { class: "linkbtn", type: "button", onclick: function () { pendingImport = null; renderImportConfirm(); } }, "Abbrechen")));
  }
  function readImportFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setStatus("Die Datei ist zu groß (mehr als 5 MB).", true); return; }
    var r = new FileReader();
    r.onload = function () {
      try {
        var data = JSON.parse(String(r.result));
        if (!data || data.app !== "haushalt" || !data.collections || typeof data.collections !== "object") throw new Error("format");
        var docs = [], idOk = /^[A-Za-z0-9_-]{1,100}$/;
        COLLS.forEach(function (c) {
          var col = data.collections[c];
          if (!col || typeof col !== "object") return;
          Object.keys(col).forEach(function (id) {
            if (!idOk.test(id) || !col[id] || typeof col[id] !== "object" || Array.isArray(col[id])) return;
            docs.push({ c: c, id: id, data: cleanDeep(col[id], 0) });
          });
        });
        if (!docs.length) { setStatus("In der Datei wurden keine passenden Einträge gefunden.", true); return; }
        if (docs.length > 5000) { setStatus("Die Datei enthält zu viele Einträge (mehr als 5000).", true); return; }
        pendingImport = { docs: docs, count: docs.length };
        setStatus("");
        renderImportConfirm();
      } catch (e) { setStatus("Das ist keine gültige Sicherungsdatei dieser App.", true); }
    };
    r.onerror = function () { setStatus("Die Datei konnte nicht gelesen werden.", true); };
    r.readAsText(file);
  }
  function runBatches(ops) {
    var chain = Promise.resolve();
    for (var i = 0; i < ops.length; i += 400) {
      (function (part) {
        chain = chain.then(function () {
          var b = db.batch();
          part.forEach(function (o) { b.set(db.collection(o.c).doc(o.id), o.data); });
          return b.commit();
        });
      })(ops.slice(i, i + 400));
    }
    return chain;
  }
  function runImport() {
    if (!db || !pendingImport) return;
    var ops = pendingImport.docs, n = pendingImport.count;
    pendingImport = null; renderImportConfirm();
    setStatus("Import läuft …");
    runBatches(ops).then(function () { setStatus(n + " Einträge importiert."); toast(n + " Einträge importiert."); })
      .catch(function (e) { setStatus("Import fehlgeschlagen" + (e && e.code ? " (" + e.code + ")" : "") + ".", true); });
  }
  function addDays(n) { return dnToStr(dn(todayStr()) + n); }
  function loadExamples() {
    if (!db) { toast("Keine Verbindung zum Speicher."); return; }
    var T = function (id, name, room, days, who, turn, last, by) { return { c: "tasks", id: id, data: { name: name, room: room, intervalDays: days, assignee: who, turn: turn, lastDone: addDays(last), lastBy: by, countF: 0, countC: 0, createdAt: todayStr(), example: true } }; };
    var ops = [
      { c: "stores", id: "laden-aldi", data: { name: "Aldi", at: 1 } },
      { c: "stores", id: "laden-rossmann", data: { name: "Rossmann", at: 2 } },
      { c: "stores", id: "laden-rewe", data: { name: "Rewe", at: 3 } },
      T("bsp-saugen", "Wohnzimmer staubsaugen", "Wohnzimmer", 7, "abwechselnd", "F", -6, "C"),
      T("bsp-bad", "Bad putzen", "Bad", 7, "C", "", -8, "C"),
      T("bsp-boden", "Küchenboden wischen", "Küche", 7, "F", "", -4, "F"),
      T("bsp-muell", "Müll rausbringen", "Küche", 3, "abwechselnd", "C", -3, "F"),
      T("bsp-bett", "Bettwäsche wechseln", "Schlafzimmer", 14, "C", "", -10, "C"),
      { c: "recipes", id: "bsp-bolo", data: { name: "Spaghetti Bolognese", at: 1, example: true, ingredients: [
        { name: "500 g Spaghetti", store: "laden-aldi" }, { name: "500 g Hackfleisch gemischt", store: "laden-aldi" },
        { name: "Passierte Tomaten", store: "laden-aldi" }, { name: "2 Zwiebeln", store: "laden-aldi" }, { name: "Parmesan", store: "laden-rewe" }] } },
      { c: "recipes", id: "bsp-curry", data: { name: "Gemüsecurry mit Reis", at: 2, example: true, ingredients: [
        { name: "Basmatireis", store: "laden-aldi" }, { name: "Kokosmilch", store: "laden-aldi" }, { name: "Kichererbsen", store: "laden-aldi" },
        { name: "2 Paprika", store: "laden-aldi" }, { name: "Rote Currypaste", store: "laden-rewe" }] } },
      { c: "recipes", id: "bsp-pizza", data: { name: "Pizza-Abend", at: 3, example: true, ingredients: [
        { name: "Pizzateig", store: "laden-aldi" }, { name: "Mozzarella", store: "laden-aldi" }, { name: "Pizzasauce", store: "laden-aldi" },
        { name: "Backpapier", store: "laden-rossmann" }] } }
    ];
    runBatches(ops).then(function () { setStatus("Beispieldaten geladen. Löschen geht im Putzplan und im Kochbuch über „Beispiele entfernen“."); })
      .catch(function (e) { setStatus("Beispieldaten konnten nicht geladen werden" + (e && e.code ? " (" + e.code + ")" : "") + ".", true); });
  }

  /* ---------- Anmeldung ---------- */
  function showView(which) {
    $("bootmsg").hidden = which !== "boot";
    $("authview").hidden = which !== "auth";
    $("appview").hidden = which !== "app";
  }
  function authState(kind) {
    showView("auth");
    $("loginform").hidden = kind !== "login";
    $("recform").hidden = kind !== "recover";
    $("setupbox").hidden = kind !== "setup";
    $("authmsg").textContent = kind === "sdk"
      ? "Die Supabase-Bausteine konnten nicht geladen werden. Prüfe deine Internetverbindung oder Erweiterungen, die Skripte blockieren, und lade die Seite neu."
      : kind === "login" ? "Nur für F und C. Melde dich mit deinem Konto an."
      : kind === "recover" ? "Lege jetzt ein neues Passwort fest." : "";
  }
  function loginError(e) {
    var code = e && e.code ? String(e.code) : "";
    var st = e && e.status ? Number(e.status) : 0;
    if (/invalid_credentials|invalid_grant|user_not_found/.test(code) || (st === 400 && !code)) return "E-Mail oder Passwort stimmt nicht.";
    if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || st === 429) return "Zu viele Versuche. Warte einige Minuten und versuch es dann noch einmal.";
    if (code === "email_not_confirmed") return "Die E-Mail-Adresse ist noch nicht bestätigt (siehe Anleitung: „Auto Confirm“).";
    if (code === "user_banned") return "Dieses Konto ist gesperrt.";
    if (code === "weak_password") return "Das Passwort ist zu schwach. Nimm mindestens 10 Zeichen.";
    if (code === "same_password") return "Das neue Passwort muss anders sein als das alte.";
    if (e && /fetch|network/i.test(String(e.message || ""))) return "Keine Verbindung. Prüfe dein Internet.";
    return "Anmeldung nicht möglich" + (code ? " (" + code + ")" : "") + ".";
  }
  function boot() {
    var cfg = window.APP_CONFIG;
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseKey || /HIER/.test(String(cfg.supabaseUrl) + String(cfg.supabaseKey))) { authState("setup"); return; }
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(String(cfg.supabaseUrl))) { authState("setup"); return; }
    if (/service_role|sb_secret_/.test(String(cfg.supabaseKey))) {
      $("authmsg").textContent = "Achtung: In js/config.js steht ein geheimer Schlüssel. Nimm den „Publishable key“ und lösche den geheimen Schlüssel aus der Datei.";
      showView("auth"); return;
    }
    if (typeof supabase === "undefined" || !supabase.createClient || typeof createSupabaseStore !== "function") { authState("sdk"); return; }
    var sb;
    try {
      sb = supabase.createClient(cfg.supabaseUrl.replace(/\/$/, ""), cfg.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    } catch (e) { authState("sdk"); return; }
    var store = createSupabaseStore(sb, COLLS);
    var recovering = /type=recovery/.test(location.hash);

    $("loginform").addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = $("loginbtn"), err = $("loginerr");
      err.textContent = ""; btn.disabled = true;
      sb.auth.signInWithPassword({ email: $("lemail").value.trim(), password: $("lpass").value })
        .then(function (r) { if (r.error) throw r.error; $("lpass").value = ""; })
        .catch(function (ex) { err.textContent = loginError(ex); })
        .then(function () { btn.disabled = false; });
    });
    $("resetpw").addEventListener("click", function () {
      var mail = $("lemail").value.trim(), err = $("loginerr");
      if (!mail) { err.textContent = "Gib oben deine E-Mail-Adresse ein."; return; }
      sb.auth.resetPasswordForEmail(mail, { redirectTo: location.origin + location.pathname })
        .then(function (r) { if (r.error) throw r.error; err.textContent = "Wenn es dieses Konto gibt, ist eine E-Mail zum Zurücksetzen unterwegs."; })
        .catch(function (ex) { err.textContent = loginError(ex); });
    });
    $("recform").addEventListener("submit", function (e) {
      e.preventDefault();
      var err = $("recerr"), btn = $("recbtn"), a = $("rpass").value, b = $("rpass2").value;
      err.textContent = "";
      if (a.length < 10) { err.textContent = "Mindestens 10 Zeichen."; return; }
      if (a !== b) { err.textContent = "Die beiden Passwörter sind nicht gleich."; return; }
      btn.disabled = true;
      sb.auth.updateUser({ password: a })
        .then(function (r) {
          if (r.error) throw r.error;
          $("rpass").value = ""; $("rpass2").value = "";
          recovering = false;
          history.replaceState(null, "", location.pathname);
          enter(r.data && r.data.user);
        })
        .catch(function (ex) { err.textContent = loginError(ex); })
        .then(function () { btn.disabled = false; });
    });
    $("dologout").addEventListener("click", function () {
      store.stop();
      sb.auth.signOut().then(function () { location.reload(); }).catch(function () { location.reload(); });
    });
    function enter(user) {
      $("whoami").textContent = (user && user.email) || "Konto";
      showView("app");
      if (!dataStarted) { dataStarted = true; startData(store); }
    }
    sb.auth.onAuthStateChange(function (event, session) {
      if (event === "PASSWORD_RECOVERY") { recovering = true; authState("recover"); return; }
      if (event === "SIGNED_OUT") { if (dataStarted) { location.reload(); return; } authState("login"); return; }
      if (recovering) { authState("recover"); return; }
      if (session && session.user) enter(session.user);
    });
    sb.auth.getSession().then(function (r) {
      if (recovering) return;
      if (r.data && r.data.session) enter(r.data.session.user); else authState("login");
    }).catch(function () { authState("sdk"); });
  }

  $("doexport").addEventListener("click", exportData);
  $("doimport").addEventListener("click", function () { $("importfile").click(); });
  $("importfile").addEventListener("change", function (e) { readImportFile(e.target.files && e.target.files[0]); e.target.value = ""; });
  $("doexample").addEventListener("click", loadExamples);

  boot();
})();
