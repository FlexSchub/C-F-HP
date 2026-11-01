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
  var editing = {};
  var confirmDel = null;
  var togetherAsk = null;
  var cookTimeF = {};
  var confirmExamples = false;
  var period = "30";
  var view = "plan";
  var toastTimer = null;
  var sv = lsGet("pp-section");
  var section = sv === "shop" || sv === "cook" || sv === "meal" || sv === "cal" || sv === "spend" || sv === "putz" ? sv : "home";
  var events = [], eventsLoaded = false;
  var calMode = lsGet("pp-calmode") === "week" ? "week" : "month";
  var calAnchor = 0, calSel = 0;      // Tage seit 1970 (werden unten gesetzt)
  var evDraft = null, confirmEvDel = false;
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
  var mealCtx = { slots: [], all: [], allIds: [] };
  var pantryCtx = null;
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
  var DEMAND = 1e9;   // Sortierwert für Aufgaben ohne Rhythmus
  function intervalLabel(n) {
    if (n === 0) return "nach Bedarf";
    for (var i = 0; i < INTERVALS.length; i++) if (INTERVALS[i][0] === n) return INTERVALS[i][1];
    if (n % 30 === 0) return "alle " + (n / 30) + " Monate";
    if (n % 7 === 0) return "alle " + (n / 7) + " Wochen";
    return "alle " + n + " Tage";
  }
  /* Punkte: jede Aufgabe zählt 1 Punkt, wenn nichts anderes eingestellt ist */
  function pointsOf(x) { var n = Math.round(Number(x && x.points)); return n >= 1 ? Math.min(n, 10) : 1; }
  function readPoints(el) {
    var n = Number(String(el.value).replace(",", "."));
    return isFinite(n) && n >= 1 && n <= 10 && Math.floor(n) === n ? n : null;
  }
  function isDemand(t) { return t.intervalDays === 0 || t.intervalDays === "0"; }
  /* Eigene Abstände: Zahl + Einheit -> Tage (oder null, wenn ungültig) */
  function customDays(n, unit) {
    n = Math.floor(Number(n));
    if (!isFinite(n) || n < 1) return null;
    var d = n * (unit === "m" ? 30 : unit === "w" ? 7 : 1);
    return d > 3650 ? null : d;
  }
  function readInterval(sel, nEl, unitEl) {
    if (sel.value === "demand") return 0;
    if (sel.value === "custom") return customDays(nEl.value, unitEl.value);
    return Number(sel.value);
  }
  function intervalOptions(sel, current) {
    var known = false;
    INTERVALS.forEach(function (i) { if (i[0] === current) known = true; });
    INTERVALS.forEach(function (i) { sel.append(h("option", { value: String(i[0]) }, i[1])); });
    sel.append(h("option", { value: "custom" }, "Eigener Abstand …"));
    sel.append(h("option", { value: "demand" }, "Nach Bedarf (kein Rhythmus)"));
    sel.value = current === 0 ? "demand" : known ? String(current) : "custom";
  }
  function agoText(last) {
    if (!last) return "Noch nie erledigt";
    var d = dn(todayStr()) - dn(last);
    return d <= 0 ? "Heute erledigt" : d === 1 ? "Zuletzt gestern" : "Zuletzt vor " + d + " Tagen";
  }
  function dueText(d) {
    if (d < -1) return "seit " + (-d) + " Tagen überfällig";
    if (d === -1) return "seit gestern überfällig";
    if (d === 0) return "heute fällig";
    if (d === 1) return "morgen";
    return "in " + d + " Tagen";
  }
  function info(t) {
    var today = dn(todayStr());
    var who = t.assignee === "egal" ? "egal"
      : t.assignee === "abwechselnd" ? (t.turn === "C" ? "C" : "F") : (t.assignee === "C" ? "C" : "F");
    if (isDemand(t)) return { d: DEMAND, who: who, demand: true };
    var days = Number(t.intervalDays) || 7;
    var due = t.lastDone ? dn(t.lastDone) + days : today;
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
    if (code === "23514") toast("Das wurde von der Datenbank abgelehnt. Falls das im Kalender passiert: Das einmalige Datenbank-Update fehlt noch (Anleitung „Update Kalender“).", null, null, true);
    else if (code === "permission-denied") toast("Kein Zugriff zum Speichern. Melde dich ab und wieder an. Falls das bleibt, prüfe die Sicherheitsregeln (Anleitung).", null, null, true);
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
  function markDone(t, both) {
    togetherAsk = null;
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    if (!me && !both) {
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
    var next = both ? {
      lastDone: todayStr(),
      lastBy: "F & C",
      countF: prev.countF + 1,
      countC: prev.countC + 1,
      turn: t.assignee === "abwechselnd" ? (t.turn === "C" ? "C" : "F") : ""
    } : {
      lastDone: todayStr(),
      lastBy: me,
      countF: prev.countF + (me === "F" ? 1 : 0),
      countC: prev.countC + (me === "C" ? 1 : 0),
      turn: t.assignee === "abwechselnd" ? (me === "F" ? "C" : "F") : ""
    };
    var demand = isDemand(t);
    var ref = db.doc("tasks/" + t.id);
    var whoList = both ? ["F", "C"] : [me];
    var lrefs = whoList.map(function () { return db.collection("log").doc(); });
    var entries = whoList.map(function (w) {
      var en = { taskId: t.id, task: t.name, room: t.room || "Überall", by: w, date: todayStr(), at: Date.now(), points: pointsOf(t) };
      if (both) en.together = true;
      return en;
    });
    Promise.all([ref.update(next)].concat(lrefs.map(function (lr, i) { return lr.set(entries[i]); }))).then(function () {
      var days = Number(t.intervalDays) || 7;
      toast("„" + t.name + "“ erledigt" + (both ? " (zusammen, beide bekommen " + pointsOf(t) + (pointsOf(t) === 1 ? " Punkt" : " Punkte") + ")." : ".") + (demand ? "" : " Wieder dran " + (days === 1 ? "morgen" : "in " + days + " Tagen") + "."), "Rückgängig", function () {
        Promise.all([ref.update(prev)].concat(lrefs.map(function (lr) { return lr.delete(); }))).catch(writeFail);
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
    var status = inf.demand ? "ok" : inf.d < 0 ? "late" : inf.d === 0 ? "today" : "ok";
    var isOpen = !!open[t.id];
    var metaParts = [t.room || "Überall", intervalLabel(Number(t.intervalDays))];
    if (t.assignee === "abwechselnd") metaParts.push("abwechselnd");
    if (t.assignee === "egal") metaParts.push("egal wer");
    if (pointsOf(t) > 1) metaParts.push(pointsOf(t) + " Punkte");
    if (t.together === true) metaParts.push("auch zusammen");
    var li = h("li", { class: "task" });
    var check = h("button", { class: "check", type: "button", "aria-label": "Erledigt: " + t.name, onclick: function () {
      if (t.together === true) { togetherAsk = togetherAsk === t.id ? null : t.id; render(); } else markDone(t);
    } });
    check.innerHTML = CHECK;
    var title = h("button", { class: "title", type: "button", "aria-expanded": isOpen ? "true" : "false", onclick: function () {
      if (open[t.id]) delete open[t.id]; else open[t.id] = true;
      confirmDel = null; render();
    } }, t.name);
    li.append(
      check,
      h("div", { class: "body" }, title, h("div", { class: "meta" }, metaParts.join(" · ")), h("div", { class: "due " + status }, inf.demand ? agoText(t.lastDone) : dueText(inf.d))),
      h("span", { class: "chip " + inf.who, title: inf.who === "egal" ? "Zuständig: egal wer" : "Zuständig: " + inf.who, "aria-label": inf.who === "egal" ? "Zuständig: egal wer" : "Zuständig: " + inf.who }, inf.who === "egal" ? "F·C" : inf.who)
    );
    if (togetherAsk === t.id) {
      var pp = pointsOf(t);
      li.append(h("div", { class: "togetherask" },
        h("span", { class: "hint" }, "Wer hat es gemacht?"),
        h("div", { class: "row" },
          h("button", { class: "primary", type: "button", onclick: function () { markDone(t, false); } }, me ? "Nur ich (" + me + ")" : "Nur ich"),
          h("button", { class: "primary alt", type: "button", onclick: function () { markDone(t, true); } }, "Zusammen (beide " + pp + (pp === 1 ? " Punkt" : " Punkte") + ")"),
          h("button", { class: "linkbtn", type: "button", onclick: function () { togetherAsk = null; render(); } }, "Abbrechen"))));
    }
    if (isOpen) {
      var last = t.lastDone ? "Zuletzt erledigt von " + (t.lastBy || "?") + " am " + fmt(t.lastDone) + "." : "Noch nie erledigt.";
      var actions = h("div", { class: "row" });
      if (confirmDel === t.id) {
        actions.append(
          h("button", { class: "linkbtn danger", type: "button", onclick: function () { deleteTask(t); } }, "Ja, löschen"),
          h("button", { class: "linkbtn", type: "button", onclick: function () { confirmDel = null; render(); } }, "Abbrechen")
        );
      } else {
        actions.append(
          h("button", { class: "linkbtn", type: "button", onclick: function () { editing[t.id] = !editing[t.id]; render(); } }, editing[t.id] ? "Ändern schließen" : "Name und Rhythmus ändern"),
          h("button", { class: "linkbtn", type: "button", onclick: function () { confirmDel = t.id; render(); } }, "Aufgabe löschen"));
      }
      li.append(h("div", { class: "more" }, h("div", null, last), editing[t.id] ? editForm(t) : null, actions));
    }
    return li;
  }

  function editForm(t) {
    var sel = h("select", { "aria-label": "Wie oft?" });
    var n = h("input", { type: "number", min: "1", max: "999", inputmode: "numeric", "aria-label": "Anzahl" });
    var unit = h("select", { "aria-label": "Einheit" }, h("option", { value: "d" }, "Tage"), h("option", { value: "w" }, "Wochen"), h("option", { value: "m" }, "Monate"));
    var cur = isDemand(t) ? 0 : (Number(t.intervalDays) || 7);
    intervalOptions(sel, cur);
    if (sel.value === "custom") {
      if (cur % 30 === 0) { n.value = cur / 30; unit.value = "m"; }
      else if (cur % 7 === 0) { n.value = cur / 7; unit.value = "w"; }
      else { n.value = cur; unit.value = "d"; }
    } else { n.value = "2"; unit.value = "w"; }
    var cust = h("div", { class: "custom" }, "alle ", n, unit);
    var who = h("select", { "aria-label": "Zuständig" },
      h("option", { value: "F" }, "F"), h("option", { value: "C" }, "C"),
      h("option", { value: "abwechselnd" }, "Abwechselnd"), h("option", { value: "egal" }, "Egal wer"));
    who.value = t.assignee || "F";
    var pts = h("input", { type: "number", min: "1", max: "10", step: "1", inputmode: "numeric", "aria-label": "Punkte", value: String(pointsOf(t)) });
    var nm = h("input", { type: "text", maxlength: "80", "aria-label": "Name der Aufgabe", value: t.name || "", required: true });
    var tog = h("input", { type: "checkbox", checked: t.together === true });
    var err = h("p", { class: "autherr", role: "alert" });
    function sync() { cust.hidden = sel.value !== "custom"; n.disabled = sel.value !== "custom"; }
    sel.addEventListener("change", sync); sync();
    return h("form", { class: "editbox", onsubmit: function (e) {
      e.preventDefault();
      var days = readInterval(sel, n, unit);
      if (days === null) { err.textContent = "Bitte eine Zahl von 1 bis 999 eingeben (höchstens 10 Jahre)."; return; }
      var pv = readPoints(pts);
      if (pv === null) { err.textContent = "Punkte: bitte eine ganze Zahl von 1 bis 10."; return; }
      var newName = nm.value.trim();
      if (!newName) { err.textContent = "Die Aufgabe braucht einen Namen."; return; }
      var upd = { name: newName, intervalDays: days, assignee: who.value, points: pv, together: tog.checked };
      if (who.value === "abwechselnd") upd.turn = t.turn === "C" ? "C" : "F"; else upd.turn = "";
      db.doc("tasks/" + t.id).update(upd).then(function () { editing[t.id] = false; toast("Gespeichert."); }).catch(writeFail);
    } },
      h("label", null, "Name", nm),
      h("label", null, "Wie oft?", sel), cust,
      h("label", null, "Zuständig", who), h("label", null, "Punkte (wie anstrengend ist die Aufgabe?)", pts),
      h("label", { class: "chk" }, tog, " Kann auch zusammen erledigt werden (beide bekommen die Punkte)"), err,
      h("button", { class: "primary", type: "submit" }, "Speichern"));
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
      .filter(function (x) { return filter === "alle" || x.who === filter || x.who === "egal"; })
      .sort(function (a, b) { return a.d - b.d || String(a.t.name).localeCompare(String(b.t.name), "de"); });
    if (!shown.length) {
      list.append(h("p", { class: "note" }, "Für " + filter + " ist gerade nichts eingetragen."));
      return;
    }
    var groups = [
      ["Heute und überfällig", function (d) { return d <= 0; }],
      ["Diese Woche", function (d) { return d >= 1 && d <= 7; }],
      ["Später", function (d) { return d > 7 && d < DEMAND; }],
      ["Nach Bedarf", function (d) { return d >= DEMAND; }]
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
    var f = 0, c = 0, rooms = {}, fp = 0, cp = 0;
    items.forEach(function (l) {
      var r = l.room || "Überall";
      if (!rooms[r]) rooms[r] = { F: 0, C: 0 };
      if (l.by === "C") { c++; cp += pointsOf(l); rooms[r].C++; } else { f++; fp += pointsOf(l); rooms[r].F++; }
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

    var ptotal = fp + cp;
    var ppf = Math.round(fp / ptotal * 100), ppc = 100 - ppf;
    var pfair = fp === cp ? "Nach Punkten teilt ihr euch die Arbeit gleichmäßig auf."
      : (fp > cp ? "F" : "C") + " hat " + Math.max(ppf, ppc) + " % der Punkte gesammelt. Schwere Aufgaben zählen mehr.";
    box.append(h("div", { class: "panel" },
      h("h2", null, ptotal + (ptotal === 1 ? " Punkt gesammelt" : " Punkte gesammelt")),
      h("div", { class: "duo" },
        h("div", { class: "who F" }, h("span", { class: "num" }, String(fp)), h("span", { class: "lbl" }, "F · " + ppf + " %")),
        h("div", { class: "who C" }, h("span", { class: "num" }, String(cp)), h("span", { class: "lbl" }, "C · " + ppc + " %"))),
      h("div", { class: "bar", role: "img", "aria-label": "Punkte: F " + ppf + " Prozent, C " + ppc + " Prozent" },
        h("span", { class: "bf", style: "width:" + ppf + "%" }), h("span", { class: "bc", style: "width:" + ppc + "%" })),
      h("p", { class: "fair" }, pfair)));

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
      ul.append(h("li", null, h("span", { class: "chip " + who }, who), h("span", { class: "rt" }, (l.task || "Aufgabe") + (pointsOf(l) > 1 ? " · " + pointsOf(l) + " P." : "") + (l.together ? " · zusammen" : "")), h("span", { class: "rd" }, fmt(l.date))));
    });
    box.append(h("div", { class: "panel" }, h("h2", null, "Zuletzt erledigt"), ul));
    box.append(h("p", { class: "foot" }, "Gezählt wird ab dem ersten Abhaken in dieser Version."));
  }

  /* Einkauf: Mengen und Gänge */
  var AISLES = ["Obst & Gemüse", "Brot & Backwaren", "Kühlregal", "Fleisch & Fisch", "Tiefkühl", "Vorrat & Konserven", "Getränke", "Süßes & Snacks", "Drogerie & Haushalt", "Sonstiges"];
  var AISLE_WORDS = [
    ["Tiefkühl", ["tiefkühl", "tk", "pommes", "fischstäbchen", "gefroren", "eiscreme", "speiseeis", "eis", "rahmspinat"]],
    ["Drogerie & Haushalt", ["zahnpasta", "zahnbürste", "shampoo", "duschgel", "seife", "spülmittel", "spülmaschinentabs", "waschmittel", "weichspüler", "klopapier", "toilettenpapier", "küchenrolle", "küchentuch", "müllbeutel", "müllsack", "taschentücher", "deo", "backpapier", "alufolie", "frischhaltefolie", "schwamm", "reiniger", "windeln", "tampons", "binden", "creme", "batterie", "glühbirne", "rasier", "wattepads", "mundwasser", "zahnseide", "gefrierbeutel", "kerzen", "streichhölzer", "tabs"]],
    ["Getränke", ["wasser", "saft", "cola", "limo", "bier", "sekt", "schorle", "kaffee", "tee", "sprudel", "getränk", "energy", "rotwein", "weißwein", "wein", "sirup", "mate", "fanta", "sprite"]],
    ["Süßes & Snacks", ["schoko", "keks", "chips", "gummi", "bonbon", "riegel", "snack", "popcorn", "salzstangen", "cracker", "nutella", "lakritz", "waffel", "praline", "kuchen"]],
    ["Vorrat & Konserven", ["passiert", "dose", "konserve", "kokosmilch", "currypaste", "kichererbsen", "bohnen", "linsen", "mais", "nudel", "spaghetti", "pasta", "penne", "fusilli", "reis", "mehl", "zucker", "salz", "pfeffer", "öl", "essig", "soße", "sauce", "gewürz", "brühe", "haferflocken", "müsli", "cornflakes", "couscous", "bulgur", "honig", "marmelade", "erdnuss", "nüsse", "backpulver", "hefe", "stärke", "senf", "ketchup", "mayo", "passata", "tomatenmark", "pizzasauce", "pesto", "oliven", "thunfisch", "sardinen", "suppe", "kartoffelpüree", "paniermehl", "vanille", "kakao", "rosinen", "semmelbrösel"]],
    ["Fleisch & Fisch", ["hack", "hähnchen", "huhn", "hühner", "pute", "rind", "schwein", "wurst", "schinken", "speck", "lachs", "fisch", "garnelen", "steak", "filet", "bratwurst", "salami", "gyros", "schnitzel", "fleisch", "leberwurst", "mett", "aufschnitt"]],
    ["Kühlregal", ["milch", "butter", "käse", "joghurt", "quark", "sahne", "ei", "eier", "mozzarella", "parmesan", "gouda", "feta", "frischkäse", "schmand", "margarine", "skyr", "crème", "pudding", "tofu", "hummus", "kefir", "buttermilch", "pizzateig", "teig", "tzatziki", "mascarpone", "ricotta", "halloumi", "creme fraiche", "frischkäse"]],
    ["Brot & Backwaren", ["brot", "brötchen", "toast", "baguette", "croissant", "brezel", "tortilla", "wrap", "fladenbrot", "laugen", "semmel", "knäcke", "zwieback", "burgerbrötchen"]],
    ["Obst & Gemüse", ["apfel", "äpfel", "banane", "birne", "orange", "zitrone", "limette", "tomate", "gurke", "paprika", "zwiebel", "knoblauch", "kartoffel", "möhre", "karotte", "salat", "spinat", "brokkoli", "zucchini", "pilz", "champignon", "beere", "trauben", "avocado", "ingwer", "lauch", "kohl", "kürbis", "aubergine", "petersilie", "basilikum", "schnittlauch", "obst", "gemüse", "kräuter", "mango", "melone", "pfirsich", "kiwi", "radieschen", "sellerie", "ananas", "erdbeer", "himbeer", "blumenkohl", "rosenkohl", "fenchel", "rucola", "koriander", "minze", "dill", "frühlingszwiebel", "süßkartoffel", "mandarine", "nektarine", "pflaume", "kirsche"]]
  ];
  function wordMatch(t, w) {
    if (w.length <= 2) return t === w;
    if (w.length === 3) return t.indexOf(w) === 0;
    return t.indexOf(w) >= 0;
  }
  function guessAisle(name) {
    var tokens = String(name).toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);
    for (var g = 0; g < AISLE_WORDS.length; g++) {
      var words = AISLE_WORDS[g][1];
      for (var i = 0; i < words.length; i++) for (var j = 0; j < tokens.length; j++) if (wordMatch(tokens[j], words[i])) return AISLE_WORDS[g][0];
    }
    return "Sonstiges";
  }
  function aisleOf(it) { return AISLES.indexOf(it.aisle) >= 0 ? it.aisle : guessAisle(it.name); }
  var QTY_UNITS = "kg|mg|g|ml|cl|liter|l|stück|stk|st|pckg|pck|pkg|packungen|packung|pack|dosen|dose|bund|becher|flaschen|flasche|gläser|glas|tüten|tüte|rollen|rolle|kasten|x|×";
  var QTY_RE = new RegExp("^(\\d+(?:[.,]\\d+)?)\\s*(" + QTY_UNITS + ")?\\.?\\s+(\\S.*)$", "i");
  function parseItem(text) {
    var t = String(text).trim().replace(/\s+/g, " ");
    var m = QTY_RE.exec(t);
    if (!m) return { qty: "", name: t };
    var unit = (m[2] || "").toLowerCase();
    var qty = unit === "x" || unit === "×" ? m[1] + "×" : m[1] + (unit ? " " + unit : "");
    return { qty: qty, name: m[3] };
  }
  function qtySplit(q) {
    var m = /^(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(String(q || "").trim());
    return m ? { n: parseFloat(m[1].replace(",", ".")), u: m[2].trim().toLowerCase() } : null;
  }
  function qtyAdd(a, b) {
    var x = qtySplit(a), y = qtySplit(b);
    if (!x || !y || x.u !== y.u) return null;
    var n = Math.round((x.n + y.n) * 100) / 100;
    var str = String(n).replace(".", ",");
    return x.u === "×" || x.u === "x" ? str + "×" : str + (x.u ? " " + x.u : "");
  }
  function bumpHist(it) {
    var st = (stores || []).filter(function (x) { return x.id === it.store; })[0];
    if (!st || !db) return;
    var hist = Array.isArray(st.hist) ? st.hist.map(function (x) { return Object.assign({}, x); }) : [];
    var key = String(it.name).toLowerCase();
    var e = hist.filter(function (x) { return String(x.n).toLowerCase() === key; })[0];
    var now = Date.now();
    var others = it.grp ? items.filter(function (i) { return i.grp === it.grp && i.store !== it.store && storeName(i.store); }).map(function (i) { return i.store; }) : [];
    if (e) { e.c = (e.c || 0) + 1; e.t = now; e.a = aisleOf(it); if (others.length) e.o = others; else delete e.o; }
    else { e = { n: String(it.name).slice(0, 60), c: 1, t: now, a: aisleOf(it) }; if (others.length) e.o = others; hist.push(e); }
    hist.sort(function (a, b) { return (b.c || 0) - (a.c || 0) || (b.t || 0) - (a.t || 0); });
    db.doc("stores/" + st.id).update({ hist: hist.slice(0, 30) }).catch(function () {});
  }
  var editItemId = null;
  var alsoSel = {}, alsoFor = null;
  var aisleSort = lsGet("pp-aisle") !== "off";

  /* Einkauf: Aktionen */
  function setDone(it, done) {
    if (!db) return;
    var group = it.grp ? items.filter(function (i) { return i.grp === it.grp; }) : [];
    if (!group.some(function (i) { return i.id === it.id; })) group.push(it);
    group.forEach(function (g) {
      if (!!g.done === !!done && g.id !== it.id) return;
      if (done) bumpHist(g);
      var upd = done ? { done: true, doneAt: Date.now(), by: me || "" } : { done: false, at: Date.now(), by: me || "" };
      db.doc("shop/" + g.id).update(upd).catch(writeFail);
    });
  }
  function delItem(it) { if (db) db.doc("shop/" + it.id).delete().catch(writeFail); }
  function addItems(text) {
    if (!db || !curStore) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var seen = {};
    text.replace(/(\d),(\d)/g, "$1\u0001$2").split(",").map(function (s) { return s.replace(/\u0001/g, ",").trim(); }).filter(Boolean).forEach(function (n) {
      var key = n.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      if (putMulti(curStore, n, undefined, alsoIds()) === "dup") toast("„" + parseItem(n).name + "“ steht schon auf der Liste.");
    });
  }
  function alsoIds() {
    var ids = Object.keys(alsoSel).filter(function (k) { return alsoSel[k] && storeName(k) && k !== curStore; });
    alsoSel = {};
    return ids.length ? ids : undefined;
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

  function siblings(it) { return it.grp ? items.filter(function (i) { return i.grp === it.grp && i.id !== it.id && storeName(i.store); }) : []; }
  function alsoLabel(it) {
    var names = siblings(it).filter(function (i) { return !i.done; }).map(function (i) { return storeName(i.store); });
    return names.length ? h("span", { class: "also" }, " · auch " + names.join(", ")) : null;
  }
  function editItemRow(it, chk) {
    var q = h("input", { type: "text", maxlength: "20", placeholder: "Menge", value: it.qty || "", "aria-label": "Menge" });
    var n = h("input", { type: "text", maxlength: "80", value: it.name, "aria-label": "Artikel", required: true });
    var a = h("select", { "aria-label": "Gang im Laden" });
    AISLES.forEach(function (x) { a.append(h("option", { value: x, selected: x === aisleOf(it) }, x)); });
    var sib = siblings(it), want = {};
    sib.forEach(function (i) { want[i.store] = true; });
    var others = (stores || []).filter(function (x) { return x.id !== it.store; });
    var alsoBox = null;
    if (others.length) {
      alsoBox = h("div", { class: "bought" });
      others.forEach(function (x) {
        var b = h("button", { class: "bchip" + (want[x.id] ? " sel" : ""), type: "button", "aria-pressed": String(!!want[x.id]), onclick: function () {
          want[x.id] = !want[x.id]; b.classList.toggle("sel", !!want[x.id]); b.setAttribute("aria-pressed", String(!!want[x.id]));
        } }, x.name);
        alsoBox.append(b);
      });
    }
    var save = function () {
      var name = n.value.trim();
      if (!name) { toast("Der Artikel braucht einen Namen."); return; }
      var qty = q.value.trim(), aisle = a.value;
      var wantIds = others.filter(function (x) { return want[x.id]; }).map(function (x) { return x.id; });
      var grp = wantIds.length ? (it.grp || newGrp()) : "";
      var upd = { name: name, qty: qty, aisle: aisle, grp: grp };
      db.doc("shop/" + it.id).update(upd).then(function () {
        sib.forEach(function (i) {
          if (wantIds.indexOf(i.store) >= 0) db.doc("shop/" + i.id).update({ name: name, qty: qty, aisle: aisle, grp: grp }).catch(writeFail);
          else db.doc("shop/" + i.id).update({ grp: "" }).catch(writeFail);
        });
        wantIds.forEach(function (sid) {
          if (sib.some(function (i) { return i.store === sid; })) return;
          var ex = items.filter(function (i) { return i.store === sid && String(i.name).toLowerCase() === name.toLowerCase(); })[0];
          if (ex) db.doc("shop/" + ex.id).update({ grp: grp, done: false, at: Date.now() }).catch(writeFail);
          else db.collection("shop").add({ store: sid, name: name, qty: qty, aisle: aisle, done: false, grp: grp, by: me || "", at: Date.now() }).catch(writeFail);
        });
        var st = (stores || []).filter(function (x) { return x.id === it.store; })[0];
        if (st && Array.isArray(st.hist) && aisle !== aisleOf(it)) {
          var key = name.toLowerCase();
          var hist = st.hist.map(function (x) { return String(x.n).toLowerCase() === key ? Object.assign({}, x, { a: aisle }) : x; });
          db.doc("stores/" + st.id).update({ hist: hist }).catch(function () {});
        }
        editItemId = null; renderShop();
      }).catch(writeFail);
    };
    var li = h("li", { class: "editrow" }, chk,
      h("form", { class: "itemedit", onsubmit: function (e) { e.preventDefault(); save(); } },
        h("div", { class: "qn" }, q, n), a,
        alsoBox ? h("div", { class: "alsobox" }, h("span", { class: "hint" }, "Steht auch auf der Liste von:"), alsoBox) : null,
        h("div", { class: "row" },
          h("button", { class: "primary", type: "submit" }, "Speichern"),
          h("button", { class: "linkbtn", type: "button", onclick: function () { editItemId = null; renderShop(); } }, "Abbrechen"))));
    return li;
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

    if (alsoFor !== curStore) { alsoSel = {}; alsoFor = curStore; }
    var ar = $("alsorow"); ar.replaceChildren();
    var otherSt = list.filter(function (s) { return s.id !== curStore; });
    ar.hidden = !st || showStoreForm || !otherSt.length;
    if (!ar.hidden) {
      ar.append(h("span", { class: "hint" }, "Auch kaufbar bei:"));
      otherSt.forEach(function (s) {
        var b = h("button", { class: "bchip" + (alsoSel[s.id] ? " sel" : ""), type: "button", "aria-pressed": String(!!alsoSel[s.id]), onclick: function () {
          alsoSel[s.id] = !alsoSel[s.id]; b.classList.toggle("sel", !!alsoSel[s.id]); b.setAttribute("aria-pressed", String(!!alsoSel[s.id]));
        } }, s.name);
        ar.append(b);
      });
    }
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
    var openKeys = {}; open.forEach(function (i) { openKeys[String(i.name).toLowerCase()] = true; });
    var favs = (Array.isArray(st.hist) ? st.hist : []).filter(function (x) { return x && x.n && !openKeys[String(x.n).toLowerCase()]; }).slice(0, 10);
    if (favs.length) {
      var fc = h("div", { class: "bought" });
      favs.forEach(function (x) { fc.append(h("button", { class: "bchip", type: "button", onclick: function () { putMulti(st.id, x.n, x.a); } }, x.n)); });
      body.append(h("section", { class: "group" }, h("h2", null, "Oft gekauft"), fc));
    }
    var done = mine.filter(function (i) { return i.done; }).sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });

    if (!open.length) {
      body.append(h("div", { class: "empty" },
        h("b", null, mine.length ? "Alles für " + st.name + " eingekauft" : "Noch nichts für " + st.name),
        h("span", null, mine.length ? "Tippe unten auf einen Artikel, um ihn wieder auf die Liste zu setzen." : "Schreib oben den ersten Artikel hinein. Mehrere gehen mit Komma: Milch, Brot, Butter.")));
    } else {
      var sortRow = h("div", { class: "row" }, h("button", { class: "linkbtn", type: "button", onclick: function () { aisleSort = !aisleSort; lsSet("pp-aisle", aisleSort ? "on" : "off"); renderShop(); } }, aisleSort ? "Sortiert nach Gang im Laden · ändern" : "Sortiert nach Hinzufügen · ändern"));
      body.append(sortRow);
      var mkRow = function (it) {
        var chk = h("button", { class: "check", type: "button", "aria-label": "Gekauft: " + it.name, onclick: function () { setDone(it, true); } });
        chk.innerHTML = CHECK;
        if (editItemId === it.id) return editItemRow(it, chk);
        return h("li", null, chk,
          h("button", { class: "nm nmbtn", type: "button", "aria-label": "Bearbeiten: " + it.name, onclick: function () { editItemId = it.id; renderShop(); } },
            it.qty ? h("b", { class: "qty" }, it.qty + " ") : null, it.name, alsoLabel(it)),
          h("button", { class: "x", type: "button", "aria-label": it.name + " von der Liste entfernen", onclick: function () { delItem(it); } }, "×"));
      };
      if (aisleSort) {
        AISLES.forEach(function (a) {
          var part = open.filter(function (i) { return aisleOf(i) === a; });
          if (!part.length) return;
          var ul2 = h("ul", { class: "items" });
          part.forEach(function (it) { ul2.append(mkRow(it)); });
          body.append(h("section", { class: "group" }, h("h2", null, a, h("span", { class: "n" }, String(part.length))), ul2));
        });
      } else {
        var ul = h("ul", { class: "items" });
        open.forEach(function (it) { ul.append(mkRow(it)); });
        body.append(ul);
      }
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
  function newGrp() { return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function putMulti(storeId, rawName, aisleHint, also) {
    var name = parseItem(rawName).name, key = name.toLowerCase();
    if (!also) {
      var st = (stores || []).filter(function (x) { return x.id === storeId; })[0];
      var e = st && Array.isArray(st.hist) ? st.hist.filter(function (x) { return String(x.n).toLowerCase() === key; })[0] : null;
      also = e && Array.isArray(e.o) ? e.o : [];
    }
    var targets = [];
    also.forEach(function (id) { if (id !== storeId && storeName(id) && targets.indexOf(id) < 0) targets.push(id); });
    if (!targets.length) return putOnList(storeId, rawName, aisleHint);
    var grp = newGrp();
    var res = putOnList(storeId, rawName, aisleHint, grp);
    targets.forEach(function (id) { putOnList(id, rawName, aisleHint, grp); });
    return res;
  }
  function putOnList(storeId, rawName, aisleHint, grp) {
    var pi = parseItem(rawName), name = pi.name, qty = pi.qty;
    var key = name.toLowerCase();
    var ex = items.filter(function (i) { return i.store === storeId && String(i.name).toLowerCase() === key; })[0];
    if (ex && ex.done) {
      var upd0 = { done: false, at: Date.now(), by: me || "", qty: qty };
      if (grp) upd0.grp = grp;
      db.doc("shop/" + ex.id).update(upd0).catch(writeFail);
      return "back";
    }
    if (ex) {
      var sum = qty && ex.qty ? qtyAdd(ex.qty, qty) : null;
      var upd1 = sum ? { qty: sum } : {};
      if (grp) upd1.grp = grp;
      if (sum || grp) { db.doc("shop/" + ex.id).update(upd1).catch(writeFail); return sum ? "merged" : "dup"; }
      return "dup";
    }
    var doc = { store: storeId, name: name, qty: qty, aisle: AISLES.indexOf(aisleHint) >= 0 ? aisleHint : guessAisle(name), done: false, by: me || "", at: Date.now() };
    if (grp) doc.grp = grp;
    db.collection("shop").add(doc).catch(writeFail);
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
  function effortText(n) { n = Math.round(Number(n)); if (!(n >= 1 && n <= 5)) return ""; return "●".repeat(n) + "○".repeat(5 - n); }
  var EFFORT_NAMES = ["", "sehr leicht", "leicht", "mittel", "aufwendig", "sehr aufwendig"];
  var TIME_CATS = [
    { label: "unter 15 Min", short: "< 15 Min", rep: 10, max: 14 },
    { label: "15 bis 30 Min", short: "15–30 Min", rep: 25, max: 30 },
    { label: "30 bis 60 Min", short: "30–60 Min", rep: 45, max: 60 },
    { label: "60 bis 90 Min", short: "60–90 Min", rep: 75, max: 90 },
    { label: "über 90 Min", short: "90+ Min", rep: 120, max: 99999 }
  ];
  /* Gibt 0 für "keine Angabe" zurück, sonst 1 bis 5 */
  function timeCat(m) {
    m = Math.round(Number(m));
    if (!(m >= 1)) return 0;
    for (var i = 0; i < TIME_CATS.length; i++) if (m <= TIME_CATS[i].max) return i + 1;
    return TIME_CATS.length;
  }
  /* Zeit-Skala 1 bis 5 mit kleinen Uhren, wie beim Aufwand */
  function clockEl(m) {
    var c = timeCat(m);
    if (!c) return null;
    var scale = h("span", { class: "clocks", "aria-hidden": "true" });
    for (var i = 1; i <= TIME_CATS.length; i++) scale.append(h("span", { class: i <= c ? "on" : "off" }, "🕐"));
    return h("div", { class: "dclock", role: "img", "aria-label": "Zeit " + c + " von 5, " + TIME_CATS[c - 1].label, title: TIME_CATS[c - 1].label },
      h("span", { class: "zl" }, "Zeit"), scale);
  }
  function timeLabel(m) { var c = timeCat(m); return c ? TIME_CATS[c - 1].short : ""; }
  function minutesText(m) { m = Math.round(Number(m)); if (!(m >= 1)) return ""; return m >= 60 ? Math.floor(m / 60) + " Std" + (m % 60 ? " " + (m % 60) + " Min" : "") : m + " Min"; }
  var KIND_NAMES = { "": "Zutat", opt: "Optional (Topping, Extra)", stock: "Immer da (Gewürz, Vorrat)" };
  function kindOf(g) { return g && (g.k === "opt" || g.k === "stock") ? g.k : ""; }
  function mainIngs(r) { return (r.ingredients || []).filter(function (g) { return !kindOf(g); }); }
  function extraIngs(r) { return (r.ingredients || []).filter(function (g) { return kindOf(g); }); }
  function ingLine(r) {
    var m = mainIngs(r).map(function (g) { return g.name; }).join(" · "), x = extraIngs(r).map(function (g) { return g.name; }).join(", ");
    return (m || (x ? "" : "")) + (x ? (m ? " · " : "") + "optional/Vorrat: " + x : "");
  }
  function dishEl(r) {
    var on = !!picked[r.id];
    var ings = mainIngs(r), nExtra = extraIngs(r).length;
    var pick = h("button", { class: "pick", type: "button", "aria-pressed": String(on), "aria-label": (on ? "Abwählen: " : "Auswählen: ") + r.name, onclick: function () {
      if (picked[r.id]) delete picked[r.id]; else picked[r.id] = true;
      renderCook();
    } });
    pick.innerHTML = CHECK;
    var names = ingLine(r);
    return h("li", { class: "dish" + (on ? " on" : "") }, pick,
      h("div", { class: "dbody" },
        h("div", { class: "dishhead" }, h("span", { class: "dname" }, r.name), h("span", { class: "lead" }), h("span", { class: "dcount" }, ings.length + (ings.length === 1 ? " Zutat" : " Zutaten") + (nExtra ? " + " + nExtra + " Extra" + (nExtra === 1 ? "" : "s") : ""))),
        (effortText(r.effort)) ? h("div", { class: "dmeta" },
          effortText(r.effort) ? h("span", { title: "Aufwand: " + EFFORT_NAMES[Math.round(Number(r.effort))], "aria-label": "Aufwand " + Math.round(Number(r.effort)) + " von 5, " + EFFORT_NAMES[Math.round(Number(r.effort))] }, "Aufwand " + effortText(r.effort)) : null) : null,
        clockEl(r.minutes),
        h("p", { class: "dings" }, names || "Noch keine Zutaten eingetragen."),
        h("button", { class: "linkbtn dedit", type: "button", onclick: function () { openEditor(r); } }, "Bearbeiten")));
  }
  /* Essensplan: pro Tag Mittag- und Abendessen, jeweils Gerichte oder "Auswärts".
     Ältere Einträge (nur "dishes") gelten als Abendessen. */
  function slotsOf(doc) {
    doc = doc || {};
    return {
      lunch: Array.isArray(doc.lunch) ? doc.lunch : [],
      dinner: Array.isArray(doc.dinner) ? doc.dinner : (Array.isArray(doc.dishes) ? doc.dishes : []),
      outLunch: doc.outLunch === true, noteLunch: String(doc.noteLunch || ""),
      outDinner: doc.outDinner === true, noteDinner: String(doc.noteDinner || ""),
      listedLunch: doc.listedLunch === true, listedDinner: doc.listedDinner === true
    };
  }
  function allDishes(doc) { var st = slotsOf(doc); return st.lunch.concat(st.dinner); }
  function renderCookStats() {
    var box = $("cookstats");
    box.replaceChildren();
    if (recipes === null || !planLoaded) { box.append(h("p", { class: "note" }, "Statistik wird geladen …")); return; }
    var today = dn(todayStr());
    var span = cookPeriod === "all" ? null : Number(cookPeriod);
    var counts = {}, total = 0, everEaten = {}, outN = 0;
    Object.keys(plan).forEach(function (ds) {
      var n = dn(ds);
      if (isNaN(n) || n > today) return;
      var st0 = slotsOf(plan[ds]);
      if (span === null || n >= today - (span - 1)) outN += (st0.outLunch ? 1 : 0) + (st0.outDinner ? 1 : 0);
      allDishes(plan[ds]).forEach(function (d) {
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
      if (outN) box.append(h("p", { class: "fair" }, "Auswärts gegessen: " + outN + (outN === 1 ? " Mahlzeit." : " Mahlzeiten.")));
      box.append(h("div", { class: "empty" }, h("b", null, "Noch nichts gegessen in diesem Zeitraum"), h("span", null, "Plane Gerichte im Essensplan ein. Gezählt werden alle Tage bis einschließlich heute.")));
    } else {
      var top = counts[names[0]];
      box.append(h("div", { class: "panel" },
        h("h2", null, "Überblick"),
        h("div", { class: "duo" },
          h("div", { class: "who K" }, h("span", { class: "num" }, String(total)), h("span", { class: "lbl" }, total === 1 ? "Mahlzeit" : "Mahlzeiten")),
          h("div", { class: "who K C" }, h("span", { class: "num" }, String(names.length)), h("span", { class: "lbl" }, names.length === 1 ? "Gericht" : "verschiedene Gerichte"))),
        h("p", { class: "fair" }, "Am häufigsten: " + top.name + " (" + top.n + "×)." + (outN ? " Auswärts gegessen: " + outN + (outN === 1 ? " Mahlzeit." : " Mahlzeiten.") : ""))));
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
      var anyTime = recipes.some(function (r) { return timeCat(r.minutes) > 0; });
      var tf = Object.keys(cookTimeF).filter(function (k) { return cookTimeF[k]; }).map(Number);
      if (anyTime) {
        var fr = h("div", { class: "bought xchips timefilter" }, h("span", { class: "hint" }, "Zeit:"));
        TIME_CATS.forEach(function (tc, i) {
          var on = !!cookTimeF[i + 1];
          fr.append(h("button", { class: "bchip" + (on ? " sel" : ""), type: "button", "aria-pressed": String(on), onclick: function () { cookTimeF[i + 1] = !on; renderCook(); } }, tc.short));
        });
        box.append(fr);
      }
      var list = recipes.filter(function (r) { return !tf.length || tf.indexOf(timeCat(r.minutes)) >= 0; });
      if (!list.length) box.append(h("div", { class: "empty" }, h("b", null, "Kein Gericht in dieser Zeit"), h("span", null, "Wähle eine andere Zeit oder tippe die Auswahl wieder ab.")));
      var ul = h("ul", { class: "dishes" });
      list.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "de"); }).forEach(function (r) { ul.append(dishEl(r)); });
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
        var key = sid + "|" + String(g.name).toLowerCase(), kd = kindOf(g);
        if (!map[key]) { map[key] = { name: g.name, store: sid, dishes: [], home: !!kd, kind: kd }; order.push(key); }
        else if (map[key].kind && !kd) { map[key].kind = ""; map[key].home = false; }
        else if (map[key].kind === "stock" && kd === "opt") map[key].kind = "opt";
        if (map[key].dishes.indexOf(r.name) < 0) map[key].dishes.push(r.name);
      });
    });
    pantry = { rows: order.map(function (k) { return map[k]; }) };
    setCookMode("pantry");
    renderPantry();
  }
  function markListed() {
    if (!pantryCtx) return;
    var byDay = {};
    pantryCtx.slots.forEach(function (sp) { (byDay[sp.ds] = byDay[sp.ds] || []).push(sp.slot); });
    Object.keys(byDay).forEach(function (ds) {
      var cur = slotsOf(plan[ds]);
      byDay[ds].forEach(function (sl) { cur["listed" + (sl === "lunch" ? "Lunch" : "Dinner")] = true; });
      saveDay(ds, cur);
    });
  }
  function leavePantry(finished) {
    if (finished) markListed();
    var back = !!pantryCtx;
    pantryCtx = null;
    setCookMode("list");
    if (back) { section = "meal"; lsSet("pp-section", "meal"); syncControls(); renderMeal(); }
    renderCook();
  }
  function renderPantry() {
    var box = $("cookpanel");
    box.replaceChildren();
    var allRows = pantry.rows, rows = allRows.filter(function (r) { return !r.kind; });
    var extras = allRows.filter(function (r) { return r.kind; });
    var need = allRows.filter(function (r) { return !r.home; }).length;
    var panel = h("div", { class: "panel" },
      h("h2", null, "Was ist schon zuhause?"),
      h("p", { class: "fair" }, "Hake an, was ihr noch auf Vorrat habt. Alles andere kommt auf die Einkaufslisten."));
    if (!rows.length) {
      panel.append(h("p", { class: "note" }, extras.length ? "Die gewählten Gerichte haben keine festen Zutaten." : "Die gewählten Gerichte haben noch keine Zutaten."));
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
    [["opt", "Optional dazu"], ["stock", "Gewürze und Vorrat (meist da)"]].forEach(function (kk) {
      var part = extras.filter(function (r) { return r.kind === kk[0]; });
      if (!part.length) return;
      var chips = h("div", { class: "bought xchips" });
      part.forEach(function (r) {
        chips.append(h("button", { class: "bchip" + (r.home ? "" : " sel"), type: "button", "aria-pressed": String(!r.home), title: "für " + r.dishes.join(", "), onclick: function () { r.home = !r.home; renderPantry(); } },
          r.name + (ids.length > 1 && r.store ? " · " + storeName(r.store) : "")));
      });
      panel.append(h("div", { class: "pgroup" }, h("h3", null, kk[1]), h("p", { class: "fair" }, "Tippe an, was ihr dafür kaufen wollt. Sonst bleibt es weg von der Liste."), chips));
    });
    panel.append(h("div", { class: "row" },
      h("button", { class: "primary", type: "button", onclick: confirmPantry }, need ? "Auf die Listen setzen (" + need + ")" : "Nichts kaufen, alles da"),
      h("button", { class: "linkbtn", type: "button", onclick: function () { leavePantry(false); } }, "Zurück")));
    box.append(panel);
  }
  function confirmPantry() {
    var need = pantry.rows.filter(function (r) { return !r.home; });
    if (!need.length) { picked = {}; leavePantry(true); toast("Alles ist zuhause, es muss nichts gekauft werden."); return; }
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    if (!(stores || []).length) { toast("Lege zuerst im Einkauf einen Laden an."); return; }
    var counts = {};
    need.forEach(function (r) {
      var sid = resolveStore(r.store);
      if (putMulti(sid, r.name) !== "dup") counts[sid] = (counts[sid] || 0) + 1;
    });
    var ids = Object.keys(counts);
    picked = {};
    leavePantry(true);
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
      draft = { id: r.id, name: r.name || "", at: r.at || 0, effort: Math.round(Number(r.effort)) || 0, minutes: Math.round(Number(r.minutes)) || 0, ings: (r.ingredients || []).map(function (g) { return { name: g.name || "", store: resolveStore(g.store), touched: true, k: kindOf(g) }; }) };
    } else {
      draft = { id: null, name: "", at: 0, effort: 0, minutes: 0, ings: [] };
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
    var effSel = h("select", { "aria-label": "Aufwand", onchange: function (e) { draft.effort = Number(e.target.value) || 0; } },
      h("option", { value: "0" }, "keine Angabe"));
    for (var ei = 1; ei <= 5; ei++) effSel.append(h("option", { value: String(ei), selected: draft.effort === ei }, ei + " von 5 · " + EFFORT_NAMES[ei]));
    var minIn = h("select", { "aria-label": "Zubereitungszeit", onchange: function (e) {
      var c = Number(e.target.value);
      if (c === 0) draft.minutes = 0;
      else if (timeCat(draft.minutes) !== c) draft.minutes = TIME_CATS[c - 1].rep;
    } }, h("option", { value: "0" }, "keine Angabe"));
    TIME_CATS.forEach(function (tc, i) { minIn.append(h("option", { value: String(i + 1), selected: timeCat(draft.minutes) === i + 1 }, tc.label)); });
    var panel = h("div", { class: "panel" }, h("h2", null, draft.id ? "Gericht bearbeiten" : "Neues Gericht"), nameIn,
      h("div", { class: "two" },
        h("label", { class: "fl" }, "Aufwand", effSel),
        h("label", { class: "fl" }, "Zubereitungszeit", minIn)),
      h("h2", null, "Zutaten und Laden"));
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
      var ksel = h("select", { class: "kindsel", "aria-label": "Art von Zutat " + (idx + 1), onchange: function (e) { g.k = e.target.value; } });
      Object.keys(KIND_NAMES).forEach(function (kk) { ksel.append(h("option", { value: kk, selected: kk === (g.k || "") }, KIND_NAMES[kk])); });
      panel.append(h("div", { class: "ingwrap" }, h("div", { class: "ingrow" }, nm, sel, rm), ksel));
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
    var ings = draft.ings.map(function (g) { var o = { name: g.name.trim(), store: g.store || "" }; if (g.k === "opt" || g.k === "stock") o.k = g.k; return o; }).filter(function (g) { return g.name; });
    var p;
    var mins = Math.round(Number(draft.minutes)) || 0;
    if (mins < 0 || mins > 1440) { toast("Die Dauer sollte zwischen 1 und 1440 Minuten liegen."); return; }
    var eff = Math.round(Number(draft.effort)) || 0;
    if (draft.id) p = db.doc("recipes/" + draft.id).update({ name: name, ingredients: ings, example: false, effort: eff, minutes: mins });
    else p = db.collection("recipes").add({ name: name, ingredients: ings, at: Date.now(), effort: eff, minutes: mins });
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
  function saveDay(ds, st) {
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var empty = !st.lunch.length && !st.dinner.length && !st.outLunch && !st.outDinner;
    var p = empty ? db.doc("plan/" + ds).delete()
      : db.doc("plan/" + ds).set({ date: ds, lunch: st.lunch, dinner: st.dinner, outLunch: st.outLunch, noteLunch: st.noteLunch, outDinner: st.outDinner, noteDinner: st.noteDinner, listedLunch: st.listedLunch === true, listedDinner: st.listedDinner === true, at: Date.now() });
    p.catch(writeFail);
  }
  var SLOT_NAMES = { lunch: "Mittagessen", dinner: "Abendessen" };
  function slotEl(ds, slot) {
    var Cap = slot === "lunch" ? "Lunch" : "Dinner";
    var st = slotsOf(plan[ds]);
    var dishes = st[slot], out = st["out" + Cap];
    var key = ds + "|" + slot;
    var box = h("div", { class: "slot" }, h("div", { class: "slabel" }, SLOT_NAMES[slot], dishes.length && st["listed" + Cap] ? h("span", { class: "listed", title: "Zutaten sind auf den Einkaufslisten" }, " ✓ Zutaten geprüft") : null));
    var chips = h("div", { class: "mealchips" });
    if (out) {
      var note = st["note" + Cap];
      chips.append(h("span", { class: "meal out" }, "Auswärts" + (note ? ": " + note : ""),
        h("button", { class: "x", type: "button", "aria-label": SLOT_NAMES[slot] + " auswärts entfernen", onclick: function () {
          var cur = slotsOf(plan[ds]); cur["out" + Cap] = false; cur["note" + Cap] = ""; saveDay(ds, cur);
        } }, "×")));
    }
    dishes.forEach(function (d, idx) {
      var rec = (recipes || []).filter(function (r) { return r.id === d.id; })[0];
      var nm = rec ? rec.name : d.name;
      chips.append(h("span", { class: "meal" }, nm,
        h("button", { class: "x", type: "button", "aria-label": nm + " aus dem Plan nehmen", onclick: function () {
          var cur = slotsOf(plan[ds]); cur[slot] = cur[slot].filter(function (_, j) { return j !== idx; }); saveDay(ds, cur);
        } }, "×")));
    });
    if (chips.children.length) box.append(chips);
    else if (pickDay !== key + "|dish" && pickDay !== key + "|out") box.append(h("p", { class: "noneyet" }, "Noch nichts geplant"));

    if (pickDay === key + "|dish") {
      var list = (recipes || []).slice().sort(function (a, b) {
        return (picked[b.id] ? 1 : 0) - (picked[a.id] ? 1 : 0) || String(a.name).localeCompare(String(b.name), "de");
      });
      if (!list.length) box.append(h("p", { class: "noneyet" }, "Lege zuerst im Kochbuch ein Gericht an."));
      else {
        var pk = h("div", { class: "picker" });
        list.forEach(function (r) {
          pk.append(h("button", { class: "bchip" + (picked[r.id] ? " sel" : ""), type: "button", onclick: function () {
            pickDay = null;
            var cur = slotsOf(plan[ds]);
            if (cur[slot].some(function (d) { return d.id === r.id; })) { renderMeal(); return; }
            cur[slot] = cur[slot].concat([{ id: r.id, name: r.name }]);
            cur["out" + Cap] = false; cur["note" + Cap] = ""; cur["listed" + Cap] = false;
            saveDay(ds, cur);
            renderMeal();
          } }, r.name + (picked[r.id] ? " · gewählt" : "")));
        });
        box.append(pk);
      }
    }
    if (pickDay === key + "|out") {
      var inp = h("input", { type: "text", maxlength: "60", placeholder: "Wo? z. B. bei Oma (kann leer bleiben)", "aria-label": "Wo seid ihr eingeladen?" });
      var go = function () {
        var cur = slotsOf(plan[ds]);
        cur[slot] = []; cur["out" + Cap] = true; cur["note" + Cap] = inp.value.trim(); cur["listed" + Cap] = false;
        pickDay = null; saveDay(ds, cur); renderMeal();
      };
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } });
      box.append(h("div", { class: "outform" }, inp,
        h("button", { class: "primary", type: "button", onclick: go }, "Speichern")));
    }
    if (pickDay === key + "|dice") box.append(diceEl(ds, slot, key));
    var acts = h("div", { class: "slotact" });
    var open1 = pickDay === key + "|dish", open2 = pickDay === key + "|out", open3 = pickDay === key + "|dice";
    acts.append(h("button", { class: "linkbtn", type: "button", onclick: function () { pickDay = open1 ? null : key + "|dish"; renderMeal(); } }, open1 ? "Schließen" : "+ Gericht"));
    acts.append(h("button", { class: "linkbtn", type: "button", "aria-label": SLOT_NAMES[slot] + " auswürfeln", onclick: function () { pickDay = open3 ? null : key + "|dice"; renderMeal(); } }, open3 ? "Würfel schließen" : "🎲 Würfeln"));
    if (!out) acts.append(h("button", { class: "linkbtn", type: "button", onclick: function () { pickDay = open2 ? null : key + "|out"; renderMeal(); } }, open2 ? "Schließen" : "Auswärts"));
    box.append(acts);
    return box;
  }
  /* Essensplan: Würfel */
  var diceState = {};
  function diceInit(key, slot) {
    if (!diceState[key]) {
      var saved = {};
      try { saved = JSON.parse(lsGet("pp-dice-" + slot) || "{}") || {}; } catch (e) {}
      diceState[key] = { t: Array.isArray(saved.t) ? saved.t.map(Number).filter(function (x) { return x >= 1 && x <= TIME_CATS.length; }) : [], e: Number(saved.e) || 0, cur: null, seen: [] };
    }
    return diceState[key];
  }
  function dicePool(d, plannedWeek) {
    var all = (recipes || []).filter(function (r) {
      if (d.t.length && d.t.indexOf(timeCat(r.minutes)) < 0) return false;
      if (d.e && !(Number(r.effort) >= 1 && Number(r.effort) <= d.e)) return false;
      return true;
    });
    var fresh = all.filter(function (r) { return !plannedWeek[r.id]; });
    return { all: all, fresh: fresh.length ? fresh : all };
  }
  function diceRoll(ds, slot, key) {
    var d = diceInit(key, slot);
    var week = {};
    var mon = weekStart(dn(ds));
    for (var i = 0; i < 7; i++) allDishes(plan[dnToStr(mon + i)]).forEach(function (x) { week[x.id] = true; });
    var pool = dicePool(d, week).fresh;
    if (!pool.length) { d.cur = null; return; }
    var cand = pool.filter(function (r) { return d.seen.indexOf(r.id) < 0; });
    if (!cand.length) { d.seen = d.cur ? [d.cur] : []; cand = pool.filter(function (r) { return d.seen.indexOf(r.id) < 0; }); if (!cand.length) cand = pool; }
    var pick = cand[Math.floor(Math.random() * cand.length)];
    d.cur = pick.id; d.seen.push(pick.id);
  }
  function diceEl(ds, slot, key) {
    var Cap = slot === "lunch" ? "Lunch" : "Dinner";
    var d = diceInit(key, slot);
    var save = function () { lsSet("pp-dice-" + slot, JSON.stringify({ t: d.t, e: d.e })); d.cur = null; d.seen = []; renderMeal(); };
    var tSel = h("div", { class: "bought xchips timefilter", role: "group", "aria-label": "Wie schnell soll es gehen?" });
    TIME_CATS.forEach(function (tc, i) {
      var on = d.t.indexOf(i + 1) >= 0;
      tSel.append(h("button", { class: "bchip" + (on ? " sel" : ""), type: "button", "aria-pressed": String(on), onclick: function () {
        if (on) d.t = d.t.filter(function (x) { return x !== i + 1; }); else d.t = d.t.concat([i + 1]);
        save();
      } }, tc.short));
    });
    var eSel = h("select", { "aria-label": "Wie viel Aufwand höchstens?", onchange: function (e) { d.e = Number(e.target.value); save(); } },
      h("option", { value: "0", selected: d.e === 0 }, "egal"));
    for (var i = 1; i <= 4; i++) eSel.append(h("option", { value: String(i), selected: d.e === i }, "höchstens " + i + " · " + EFFORT_NAMES[i]));
    var week = {};
    var mon = weekStart(dn(ds));
    for (var j = 0; j < 7; j++) allDishes(plan[dnToStr(mon + j)]).forEach(function (x) { week[x.id] = true; });
    var info = dicePool(d, week), cur = (recipes || []).filter(function (r) { return r.id === d.cur; })[0];
    var unknown = (d.t.length || d.e) ? (recipes || []).filter(function (r) { return !(Number(r.minutes) >= 1) && !(Number(r.effort) >= 1); }).length : 0;
    var box = h("div", { class: "dice" },
      h("div", { class: "fl" }, h("span", null, "Wie schnell? (keine Auswahl = egal)"), tSel),
      h("label", { class: "fl" }, "Wie viel Aufwand?", eSel));
    if (!info.all.length) {
      box.append(h("p", { class: "noneyet" }, (d.t.length || d.e) ? "Kein Gericht passt zu diesen Wünschen. Ergänze im Kochbuch Aufwand und Dauer oder lockere die Auswahl." : "Lege zuerst im Kochbuch ein Gericht an."));
    } else {
      if (cur) {
        var taken = slotsOf(plan[ds])[slot].some(function (x) { return x.id === cur.id; });
        box.append(h("div", { class: "dicecard" },
          h("div", { class: "dname" }, cur.name),
          (effortText(cur.effort) || timeLabel(cur.minutes)) ? h("div", { class: "dmeta" },
            timeLabel(cur.minutes) ? h("span", null, "⏱ " + timeLabel(cur.minutes)) : null,
            effortText(cur.effort) ? h("span", null, "Aufwand " + effortText(cur.effort)) : null) : null,
          h("p", { class: "dings" }, ingLine(cur) || "Keine Zutaten eingetragen.")));
      }
      box.append(h("div", { class: "row" },
        cur && !taken ? h("button", { class: "primary", type: "button", onclick: function () {
          var c2 = slotsOf(plan[ds]);
          c2[slot] = c2[slot].concat([{ id: cur.id, name: cur.name }]); c2["out" + Cap] = false; c2["note" + Cap] = ""; c2["listed" + Cap] = false;
          pickDay = null; saveDay(ds, c2); renderMeal();
        } }, "Nehmen") : null,
        h("button", { class: cur ? "linkbtn" : "primary", type: "button", onclick: function () { diceRoll(ds, slot, key); renderMeal(); } }, cur ? "🎲 Nochmal würfeln" : "🎲 Würfeln")));
      box.append(h("p", { class: "foot" }, info.all.length + (info.all.length === 1 ? " Gericht passt" : " Gerichte passen") + (info.fresh.length < info.all.length ? "" : "") + "." + (unknown ? " " + unknown + " ohne Angaben zu Aufwand und Dauer werden bei einem Filter nicht vorgeschlagen." : "")));
    }
    return box;
  }
  function dayEl(n, ds, today) {
    var cls = "day" + (n === today ? " today" : "") + (n < today ? " past" : "");
    var lab = h("div", { class: "dlab" }, h("b", null, WD[(n + 3) % 7]), h("span", null, dayLabel(n)));
    return h("div", { class: cls }, lab, h("div", { class: "dmeals" }, slotEl(ds, "lunch"), slotEl(ds, "dinner")));
  }
  function renderMeal() {
    var box = $("mealdays");
    box.replaceChildren();
    var mon = weekStart(dn(todayStr())) + weekOffset * 7;
    var today = dn(todayStr());
    $("weeklabel").textContent = (weekOffset === 0 ? "Diese Woche · " : "") + dayLabel(mon) + " – " + dayLabel(mon + 6);
    $("weektoday").hidden = weekOffset === 0;
    if (!planLoaded || recipes === null) { $("mealhead").textContent = "Essensplan wird geladen …"; $("mealshop").hidden = true; return; }
    var total = 0, outN = 0, ids = {}, pendSlots = [], allSlots = [], pendIds = {};
    for (var i = 0; i < 7; i++) {
      var n = mon + i, ds = dnToStr(n);
      var st = slotsOf(plan[ds]);
      var dishes = st.lunch.concat(st.dinner);
      total += dishes.length;
      outN += (st.outLunch ? 1 : 0) + (st.outDinner ? 1 : 0);
      dishes.forEach(function (d) { ids[d.id] = true; });
      if (n >= today) [["lunch", "Lunch"], ["dinner", "Dinner"]].forEach(function (sp) {
        if (!st[sp[0]].length) return;
        allSlots.push({ ds: ds, slot: sp[0] });
        if (!st["listed" + sp[1]]) { pendSlots.push({ ds: ds, slot: sp[0] }); st[sp[0]].forEach(function (d) { pendIds[d.id] = true; }); }
      });
      box.append(dayEl(n, ds, today));
    }
    var txt = total === 0 ? "Noch nichts geplant" : total === 1 ? "1 Gericht geplant" : total + " Gerichte geplant";
    if (outN) txt += " · " + outN + "× auswärts";
    if (total === 0 && outN) txt = outN + "× auswärts, sonst noch nichts geplant";
    $("mealhead").textContent = txt;
    var known = function (id) { return recipes.some(function (r) { return r.id === id; }); };
    mealIds = Object.keys(pendIds).filter(known);
    mealCtx = { slots: pendSlots, all: allSlots, allIds: Object.keys(ids).filter(known) };
    var nPend = pendSlots.reduce(function (a, sp) { return a + slotsOf(plan[sp.ds])[sp.slot].length; }, 0);
    $("mealshop").hidden = !mealIds.length;
    $("mealshop").textContent = "Woche festlegen und Zutaten prüfen (" + nPend + (nPend === 1 ? " Gericht" : " Gerichte") + ")";
    var done = !mealIds.length && allSlots.length > 0;
    $("mealshopnote").hidden = !done;
    $("mealshopagain").hidden = !done;
  }

  /* ---------- Kalender ---------- */
  var MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  var WDLONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  var WHO_NAMES = { F: "F", C: "C", B: "Gemeinsam" };
  function evWho(e) { return e.who === "F" ? "F" : e.who === "C" ? "C" : "B"; }
  function evEndStr(e) { return e.endDate && String(e.endDate) > String(e.date) ? String(e.endDate) : String(e.date); }
  function isAllDay(e) { return e.allDay === true || !e.start; }
  function eventsOn(ds) {
    return events.filter(function (e) { return e.date && String(e.date) <= ds && ds <= evEndStr(e); }).sort(function (a, b) {
      var aa = isAllDay(a), bb = isAllDay(b);
      if (aa !== bb) return aa ? -1 : 1;
      return String(a.start || "").localeCompare(String(b.start || "")) || String(a.title || "").localeCompare(String(b.title || ""), "de");
    });
  }
  function isoWeek(n) {
    var th = n - ((n + 3) % 7) + 3;
    var y = new Date(th * 864e5).getUTCFullYear();
    return Math.floor((th - Math.round(Date.UTC(y, 0, 1) / 864e5)) / 7) + 1;
  }
  function evTimeText(e) {
    var multi = evEndStr(e) !== String(e.date);
    var t = isAllDay(e) ? "ganztägig" : e.start + (e.end ? "–" + e.end : "");
    return multi ? t + " · " + fmt(String(e.date)) + "–" + fmt(evEndStr(e)) : t;
  }
  function evRow(e) {
    var w = evWho(e);
    return h("button", { class: "evrow " + w, type: "button", onclick: function () { openEv(e, null); } },
      h("span", { class: "evtop" }, h("span", { class: "evtime" }, evTimeText(e)), h("span", { class: "evwho " + w }, WHO_NAMES[w])),
      h("span", { class: "evtitle" }, e.title || "Termin"),
      e.place ? h("span", { class: "evplace" }, e.place) : null);
  }
  function calHeadline() {
    var t = todayStr(), now = eventsOn(t).length;
    var next = events.filter(function (e) { return String(e.date) > t; }).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || String(a.start || "").localeCompare(String(b.start || "")); })[0];
    var txt = now === 0 ? "Heute keine Termine" : now === 1 ? "Heute 1 Termin" : "Heute " + now + " Termine";
    if (next) { var nn = dn(String(next.date)); txt += " · als Nächstes: " + (next.title || "Termin") + ", " + WD[(nn + 3) % 7] + " " + fmt(String(next.date)); }
    return txt;
  }
  function renderCal() {
    if (!calAnchor) { calAnchor = calSel = dn(todayStr()); }
    var head = $("calhead");
    var grid = $("calgrid"), det = $("caldet");
    grid.replaceChildren(); det.replaceChildren();
    if (dbMissing) { head.textContent = "Kalender"; grid.append(h("div", { class: "banner" }, h("p", null, connText()))); return; }
    if (!eventsLoaded) { head.textContent = "Kalender wird geladen …"; return; }
    head.textContent = calHeadline();
    Array.prototype.forEach.call($("calmode").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === calMode)); });
    var today = dn(todayStr());
    var d = new Date(calAnchor * 864e5), y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (calMode === "month") {
      $("callabel").textContent = MONTHS[m] + " " + y;
      var first = Math.round(Date.UTC(y, m, 1) / 864e5), last = Math.round(Date.UTC(y, m + 1, 0) / 864e5);
      var from = weekStart(first), to = weekStart(last) + 6;
      var g = h("div", { class: "calgrid", role: "grid", "aria-label": MONTHS[m] + " " + y });
      WD.forEach(function (w) { g.append(h("div", { class: "calwd", role: "columnheader" }, w)); });
      for (var n = from; n <= to; n++) {
        (function (n) {
          var ds = dnToStr(n), evs = eventsOn(ds), dd = new Date(n * 864e5);
          var cls = "cell" + (dd.getUTCMonth() !== m ? " other" : "") + (n === today ? " today" : "") + (n === calSel ? " sel" : "");
          var box = h("div", { class: "evs" });
          evs.slice(0, 3).forEach(function (e) { box.append(h("span", { class: "evb " + evWho(e) }, e.title || "Termin")); });
          if (evs.length > 3) box.append(h("span", { class: "evmore" }, "+" + (evs.length - 3)));
          g.append(h("button", { class: cls, type: "button", role: "gridcell", "aria-label": WDLONG[(n + 3) % 7] + " " + dayLabel(n) + ", " + (evs.length === 0 ? "keine Termine" : evs.length === 1 ? "1 Termin" : evs.length + " Termine"),
            "aria-pressed": String(n === calSel), onclick: function () { calSel = n; renderCal(); } },
            h("span", { class: "dnum" }, String(dd.getUTCDate())), box));
        })(n);
      }
      grid.append(g);
      var sds = dnToStr(calSel), sevs = eventsOn(sds);
      var panel = h("div", { class: "panel" }, h("h2", null, WDLONG[(calSel + 3) % 7] + ", " + dayLabel(calSel) + (calSel === today ? " · heute" : "")));
      if (!sevs.length) panel.append(h("p", { class: "noneyet" }, "Keine Termine an diesem Tag."));
      else { var lst = h("div", { class: "evlist" }); sevs.forEach(function (e) { lst.append(evRow(e)); }); panel.append(lst); }
      panel.append(h("div", { class: "row" }, h("button", { class: "primary", type: "button", onclick: function () { openEv(null, sds); } }, "+ Termin eintragen")));
      det.append(panel);
    } else {
      var mon = weekStart(calAnchor);
      $("callabel").textContent = "KW " + isoWeek(mon) + " · " + dayLabel(mon) + " – " + dayLabel(mon + 6);
      for (var i = 0; i < 7; i++) {
        (function (n) {
          var ds = dnToStr(n), evs = eventsOn(ds);
          var card = h("div", { class: "wday" + (n === today ? " today" : "") + (n < today ? " past" : "") },
            h("div", { class: "whead" }, h("b", null, WDLONG[(n + 3) % 7]), h("span", null, dayLabel(n)),
              h("button", { class: "linkbtn", type: "button", onclick: function () { openEv(null, ds); } }, "+ Termin")));
          if (!evs.length) card.append(h("p", { class: "noneyet" }, "Keine Termine"));
          else { var lst = h("div", { class: "evlist" }); evs.forEach(function (e) { lst.append(evRow(e)); }); card.append(lst); }
          grid.append(card);
        })(mon + i);
      }
    }
  }
  /* ---------- Kalender: .ics importieren und exportieren ---------- */
  function icsUnescape(v) { return String(v || "").replace(/\\[nN]/g, " ").replace(/\\([,;\\])/g, "$1").replace(/\s+/g, " ").trim(); }
  function icsHash(str) {
    var a = 5381, b = 52711;
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); a = (Math.imul(a, 33) ^ c) >>> 0; b = (Math.imul(b, 131) + c) >>> 0; }
    return "i" + a.toString(36) + b.toString(36);
  }
  /* Zeitangabe -> { n: Tag-Nummer, min: Minuten seit Mitternacht oder -1 bei ganztägig } in Ortszeit */
  function icsTime(val, params) {
    val = String(val || "").trim();
    var m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/.exec(val);
    if (!m) return null;
    var allDay = /VALUE=DATE(?!-)/i.test(params || "") || m[4] === undefined;
    if (allDay) return { n: Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5), min: -1 };
    if (m[7]) {
      var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
      return { n: Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5), min: d.getHours() * 60 + d.getMinutes() };
    }
    return { n: Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5), min: +m[4] * 60 + +m[5] };
  }
  function icsDuration(v) {
    var m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/.exec(String(v || "").trim());
    if (!m) return null;
    return (+(m[1] || 0)) * 10080 + (+(m[2] || 0)) * 1440 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
  }
  var ICS_DAYS = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
  function icsOccurrences(ev, winFrom, winTo) {
    var r = ev.rrule, s0 = ev.s.n, out = [];
    if (!r) return [s0];
    var f = r.FREQ, step = Math.max(1, parseInt(r.INTERVAL, 10) || 1), count = r.COUNT ? parseInt(r.COUNT, 10) : 0;
    var until = null;
    if (r.UNTIL) { var u = icsTime(r.UNTIL, ""); if (u) until = u.n; }
    var limit = Math.min(winTo, until === null ? winTo : until);
    var byday = r.BYDAY ? r.BYDAY.split(",") : [];
    var seen = 0, guard = 0;
    function take(n) { if (n < s0) return true; seen++; if (n >= winFrom && n <= limit) out.push(n); return !(count && seen >= count); }
    var dt0 = new Date(s0 * 864e5), y0 = dt0.getUTCFullYear(), m0 = dt0.getUTCMonth(), d0 = dt0.getUTCDate();
    if (f === "DAILY") {
      for (var n = s0; n <= limit && guard < 4000; n += step, guard++) if (!take(n)) break;
    } else if (f === "WEEKLY") {
      var days = byday.length ? byday.map(function (x) { return ICS_DAYS[x.slice(-2)]; }).filter(function (x) { return x !== undefined; }).sort() : [(s0 + 3) % 7];
      var w0 = weekStart(s0), stop = false;
      for (var w = 0; !stop && guard < 3000; w++, guard++) {
        var base = w0 + w * 7 * step;
        if (base > limit) break;
        for (var di = 0; di < days.length; di++) { if (!take(base + days[di])) { stop = true; break; } }
      }
    } else if (f === "MONTHLY") {
      var bmd = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null, stop2 = false;
      for (var k = 0; !stop2 && guard < 1500; k += step, guard++) {
        var mm = m0 + k, yy = y0 + Math.floor(mm / 12); mm = ((mm % 12) + 12) % 12;
        var first = Math.round(Date.UTC(yy, mm, 1) / 864e5), dim = daysIn(yy, mm + 1);
        if (first > limit) break;
        var cands = [];
        if (bmd) bmd.forEach(function (d) { if (d > 0 && d <= dim) cands.push(first + d - 1); else if (d < 0 && -d <= dim) cands.push(first + dim + d); });
        else if (byday.length) {
          byday.forEach(function (x) {
            var mt = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(x); if (!mt) return;
            var wd = ICS_DAYS[mt[2]], ord = mt[1] ? parseInt(mt[1], 10) : 0, list = [];
            for (var d2 = 0; d2 < dim; d2++) if ((first + d2 + 3) % 7 === wd) list.push(first + d2);
            if (!ord) cands = cands.concat(list); else if (ord > 0 && list[ord - 1] !== undefined) cands.push(list[ord - 1]); else if (ord < 0 && list[list.length + ord] !== undefined) cands.push(list[list.length + ord]);
          });
        } else if (d0 <= dim) cands.push(first + d0 - 1);
        cands.sort(function (a, b) { return a - b; });
        for (var ci = 0; ci < cands.length; ci++) { if (!take(cands[ci])) { stop2 = true; break; } }
      }
    } else if (f === "YEARLY") {
      for (var yk = 0; guard < 300; yk += step, guard++) {
        var y2 = y0 + yk;
        if (Math.round(Date.UTC(y2, 0, 1) / 864e5) > limit) break;
        if (d0 > daysIn(y2, m0 + 1)) continue;
        if (!take(Math.round(Date.UTC(y2, m0, d0) / 864e5))) break;
      }
    } else return [s0];
    return out;
  }
  function parseIcs(text, includePast) {
    var lines = String(text).replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
    var vevents = [], cur = null, alarm = 0;
    lines.forEach(function (line) {
      if (/^BEGIN:VALARM/i.test(line)) { alarm++; return; }
      if (/^END:VALARM/i.test(line)) { alarm = Math.max(0, alarm - 1); return; }
      if (/^BEGIN:VEVENT/i.test(line)) { cur = { ex: [] }; return; }
      if (/^END:VEVENT/i.test(line)) { if (cur) vevents.push(cur); cur = null; return; }
      if (!cur || alarm) return;
      var i = line.indexOf(":"); if (i < 1) return;
      var head = line.slice(0, i).split(";"), name = head[0].toUpperCase(), params = head.slice(1).join(";"), val = line.slice(i + 1);
      if (name === "DTSTART") cur.s = icsTime(val, params);
      else if (name === "DTEND") cur.e = icsTime(val, params);
      else if (name === "DURATION") cur.dur = icsDuration(val);
      else if (name === "SUMMARY") cur.title = icsUnescape(val);
      else if (name === "LOCATION") cur.place = icsUnescape(val);
      else if (name === "DESCRIPTION") cur.note = icsUnescape(val);
      else if (name === "UID") cur.uid = val.trim();
      else if (name === "STATUS") cur.status = val.trim().toUpperCase();
      else if (name === "RECURRENCE-ID") cur.recId = icsTime(val, params);
      else if (name === "EXDATE") val.split(",").forEach(function (v) { var t = icsTime(v, params); if (t) cur.ex.push(t.n); });
      else if (name === "RRULE") { var o = {}; val.split(";").forEach(function (kv) { var j = kv.indexOf("="); if (j > 0) o[kv.slice(0, j).toUpperCase()] = kv.slice(j + 1).toUpperCase(); }); cur.rrule = o; }
    });
    var today = dn(todayStr()), winFrom = includePast ? today - 3650 : today - 30, winTo = today + 730;
    var overrides = {};
    vevents.forEach(function (v) { if (v.recId && v.uid) overrides[v.uid + "|" + v.recId.n] = true; });
    var res = [], recurring = 0, cancelled = 0, bad = 0;
    vevents.forEach(function (v, idx) {
      if (!v.s) { bad++; return; }
      if (v.status === "CANCELLED") { cancelled++; return; }
      var uid = v.uid || ("ohne-uid-" + idx + "-" + (v.title || ""));
      var allDay = v.s.min < 0;
      var spanMin;   // Dauer in Minuten (zeitgebunden) bzw. Tage (ganztägig)
      if (allDay) spanMin = v.e && v.e.n > v.s.n ? v.e.n - v.s.n : v.dur ? Math.max(1, Math.round(v.dur / 1440)) : 1;
      else if (v.e && v.e.min >= 0) spanMin = (v.e.n * 1440 + v.e.min) - (v.s.n * 1440 + v.s.min);
      else spanMin = v.dur || 0;
      if (spanMin < 0) spanMin = 0;
      var occ = v.rrule ? icsOccurrences(v, winFrom, winTo) : [v.s.n];
      if (v.rrule) recurring++;
      occ.forEach(function (n) {
        if (v.rrule && (v.ex.indexOf(n) >= 0 || (!v.recId && overrides[uid + "|" + n]))) return;
        var endN, st = "", en = "";
        if (allDay) endN = n + spanMin - 1;
        else {
          var total = v.s.min + spanMin; endN = n + Math.floor(total / 1440);
          st = pad(Math.floor(v.s.min / 60)) + ":" + pad(v.s.min % 60);
          if (spanMin > 0) { var em = total % 1440; en = pad(Math.floor(em / 60)) + ":" + pad(em % 60); }
        }
        if (!v.rrule && !includePast && endN < today - 30) return;
        res.push({ id: icsHash(uid + "|" + n), data: {
          title: (v.title || "Termin").slice(0, 80), date: dnToStr(n), endDate: endN > n ? dnToStr(endN) : "", allDay: allDay,
          start: st, end: en, place: (v.place || "").slice(0, 60), note: (v.note || "").slice(0, 200), imported: true
        } });
      });
    });
    var dedupe = {}; res = res.filter(function (x) { if (dedupe[x.id]) return false; dedupe[x.id] = true; return true; });
    res.sort(function (a, b) { return a.data.date.localeCompare(b.data.date) || a.data.start.localeCompare(b.data.start); });
    return { events: res, recurring: recurring, cancelled: cancelled, bad: bad };
  }
  function icsStatus(msg, isErr) { var el = $("icsstatus"); el.textContent = msg || ""; el.className = "meta" + (isErr ? " err" : ""); }
  var pendingIcs = null;
  function renderIcsConfirm() {
    var box = $("icsconfirm");
    box.replaceChildren();
    if (!pendingIcs) { box.hidden = true; return; }
    box.hidden = false;
    var n = pendingIcs.events.length;
    var sample = h("ul", { class: "icssample" });
    pendingIcs.events.slice(0, 5).forEach(function (x) { sample.append(h("li", null, fmt(x.data.date) + " · " + x.data.title)); });
    box.append(h("div", { class: "panel" },
      h("p", null, n + (n === 1 ? " Termin" : " Termine") + " gefunden" + (pendingIcs.recurring ? " (" + pendingIcs.recurring + " wiederkehrende, auf einzelne Tage bis in 2 Jahre ausgerollt)" : "") + ". Beispiele:"),
      sample,
      h("p", { class: "fair" }, "Sie gehören zu: " + WHO_NAMES[$("icswho").value] + ". Erneutes Importieren derselben Datei erzeugt keine Doppelten, sondern aktualisiert die Termine."),
      h("div", { class: "row" },
        h("button", { class: "primary", type: "button", onclick: runIcsImport }, n + " Termine importieren"),
        h("button", { class: "linkbtn", type: "button", onclick: function () { pendingIcs = null; renderIcsConfirm(); } }, "Abbrechen"))));
  }
  function readIcsFile(file) {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { icsStatus("Die Datei ist zu groß (mehr als 3 MB).", true); return; }
    var r = new FileReader();
    r.onload = function () {
      try {
        var text = String(r.result);
        if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("format");
        var res = parseIcs(text, $("icspast").checked);
        if (!res.events.length) { icsStatus("Es wurden keine passenden Termine gefunden" + (res.cancelled ? " (" + res.cancelled + " abgesagte übersprungen)" : "") + ". Ältere Termine werden nur mit dem Häkchen „Auch vergangene Termine“ importiert.", true); return; }
        if (res.events.length > 2000) { icsStatus("Das sind zu viele Termine (" + res.events.length + "). Entferne das Häkchen bei „Auch vergangene Termine“ oder teile die Datei auf.", true); return; }
        pendingIcs = res; icsStatus(""); renderIcsConfirm();
      } catch (e) { icsStatus("Das ist keine gültige Kalenderdatei (.ics).", true); }
    };
    r.onerror = function () { icsStatus("Die Datei konnte nicht gelesen werden.", true); };
    r.readAsText(file);
  }
  function runIcsImport() {
    if (!db || !pendingIcs) return;
    var who = $("icswho").value, now = Date.now(), list = pendingIcs.events, n = list.length;
    var ops = list.map(function (x) { return { c: "events", id: x.id, data: Object.assign({ who: who, by: me || "", at: now }, x.data) }; });
    pendingIcs = null; renderIcsConfirm();
    icsStatus("Import läuft …");
    runBatches(ops).then(function () { icsStatus(n + " Termine importiert."); toast(n + " Termine importiert."); })
      .catch(function (e) { icsStatus("Import fehlgeschlagen" + (e && e.code ? " (" + e.code + ")" : "") + (e && e.code === "23514" ? ". Das einmalige Datenbank-Update für den Kalender fehlt noch." : "."), true); });
  }
  function icsEsc(v) { return String(v || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
  function icsFold(line) {
    var out = [], bytes = 0, cur = "";
    Array.from(line).forEach(function (ch) {
      var b = new TextEncoder().encode(ch).length;
      if (bytes + b > 73) { out.push(cur); cur = " " + ch; bytes = 1 + b; } else { cur += ch; bytes += b; }
    });
    out.push(cur);
    return out.join("\r\n");
  }
  function exportIcs() {
    var f = $("icsexwho").value;
    var list = events.filter(function (e) { return f === "all" || evWho(e) === f; });
    if (!list.length) { icsStatus("Es gibt keine Termine zum Exportieren.", true); return; }
    var stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    var L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Haushalt F und C//DE", "CALSCALE:GREGORIAN"];
    list.forEach(function (e) {
      var ds = String(e.date).replace(/-/g, ""), end = evEndStr(e).replace(/-/g, "");
      L.push("BEGIN:VEVENT", "UID:" + e.id + "@haushalt", "DTSTAMP:" + stamp);
      if (isAllDay(e)) {
        var endEx = dnToStr(dn(evEndStr(e)) + 1).replace(/-/g, "");
        L.push("DTSTART;VALUE=DATE:" + ds, "DTEND;VALUE=DATE:" + endEx);
      } else {
        L.push("DTSTART:" + ds + "T" + String(e.start).replace(":", "") + "00");
        L.push("DTEND:" + end + "T" + String(e.end || e.start).replace(":", "") + "00");
      }
      L.push("SUMMARY:" + icsEsc((WHO_NAMES[evWho(e)] === "Gemeinsam" ? "" : "[" + evWho(e) + "] ") + (e.title || "Termin")));
      if (e.place) L.push("LOCATION:" + icsEsc(e.place));
      if (e.note) L.push("DESCRIPTION:" + icsEsc(e.note));
      L.push("END:VEVENT");
    });
    L.push("END:VCALENDAR");
    var blob = new Blob([L.map(icsFold).join("\r\n") + "\r\n"], { type: "text/calendar" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "haushalt-termine-" + todayStr() + ".ics";
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    icsStatus(list.length + " Termine exportiert.");
  }
  var confirmIcsClear = false;
  function clearImported() {
    var imp = events.filter(function (e) { return e.imported === true; });
    if (!imp.length) { icsStatus("Es gibt keine importierten Termine."); return; }
    if (!confirmIcsClear) { confirmIcsClear = true; $("icsclear").textContent = "Ja, " + imp.length + " importierte Termine löschen"; $("icsclear").className = "linkbtn danger"; return; }
    confirmIcsClear = false; $("icsclear").textContent = "Alle importierten Termine löschen"; $("icsclear").className = "linkbtn";
    icsStatus("Löschen läuft …");
    var chain = Promise.resolve();
    for (var i = 0; i < imp.length; i += 20) (function (part) {
      chain = chain.then(function () { return Promise.all(part.map(function (e) { return db.doc("events/" + e.id).delete(); })); });
    })(imp.slice(i, i + 20));
    chain.then(function () { icsStatus(imp.length + " importierte Termine gelöscht."); }).catch(function (e) { icsStatus("Löschen fehlgeschlagen.", true); writeFail(e); });
  }

  function calStep(dir) {
    var d = new Date(calAnchor * 864e5);
    if (calMode === "month") {
      var y = d.getUTCFullYear(), m = d.getUTCMonth() + dir;
      calAnchor = Math.round(Date.UTC(y, m, 1) / 864e5);
      calSel = calAnchor;
    } else { calAnchor += dir * 7; calSel = calAnchor; }
    renderCal();
  }
  function openEv(e, ds) {
    evDraft = { id: e ? e.id : null }; confirmEvDel = false;
    var def = ds || dnToStr(calSel || dn(todayStr()));
    $("evtitle").value = e ? (e.title || "") : "";
    $("evwho").value = e ? evWho(e) : (me === "F" || me === "C" ? me : "B");
    $("evdate").value = e ? String(e.date) : def;
    $("evend").value = e && e.endDate ? String(e.endDate) : "";
    $("evall").checked = e ? isAllDay(e) : true;
    $("evstart").value = e && e.start ? e.start : "";
    $("evfinish").value = e && e.end ? e.end : "";
    $("evplace").value = e ? (e.place || "") : "";
    $("evnote").value = e ? (e.note || "") : "";
    $("evformtitle").textContent = e ? "Termin bearbeiten" : "Neuer Termin";
    $("evdel").hidden = !e; $("evdel").textContent = "Termin löschen"; $("evdel").className = "linkbtn";
    syncEvAll();
    $("calmain").hidden = true; $("evform").hidden = false;
    try { window.scrollTo(0, 0); } catch (x) {}
    $("evtitle").focus();
  }
  function closeEv() { evDraft = null; confirmEvDel = false; $("evform").hidden = true; $("calmain").hidden = false; renderCal(); }
  function syncEvAll() {
    var all = $("evall").checked;
    $("evtimes").hidden = all;
    $("evstart").disabled = all; $("evfinish").disabled = all;
  }

  /* ---------- Startseite „Heute“ ---------- */
  function goSection(name, after) {
    section = name; lsSet("pp-section", name);
    syncControls();
    if (name === "putz") render();
    else if (name === "shop") renderShop();
    else if (name === "meal") renderMeal();
    else if (name === "cal") renderCal();
    else if (name === "spend") renderSpend();
    else if (name === "cook") renderCook();
    if (after) after();
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  function homeCard(title, target, body, linkText) {
    var card = h("section", { class: "panel hcard" },
      h("div", { class: "hhead" }, h("h2", null, title),
        h("button", { class: "linkbtn", type: "button", onclick: function () { goSection(target); } }, linkText || "Öffnen")));
    body.forEach(function (b) { if (b) card.append(b); });
    return card;
  }
  function renderHome() {
    var box = $("homemain");
    box.replaceChildren();
    var hr = new Date().getHours();
    $("homehead").textContent = (hr < 11 ? "Guten Morgen" : hr < 18 ? "Hallo" : "Guten Abend") + (me ? ", " + me : "") + "!";
    if (dbMissing) { box.append(h("div", { class: "banner" }, h("p", null, connText()))); return; }
    var today = dn(todayStr()), ts = todayStr();

    /* Termine */
    if (eventsLoaded) {
      var evs = eventsOn(ts);
      var body = [];
      if (evs.length) { var l = h("div", { class: "evlist" }); evs.forEach(function (e) { l.append(evRow(e)); }); body.push(l); }
      else body.push(h("p", { class: "noneyet" }, "Heute keine Termine."));
      var soon = [];
      for (var i = 1; i <= 7 && soon.length < 3; i++) eventsOn(dnToStr(today + i)).forEach(function (e) { if (soon.length < 3 && !(String(e.date) < dnToStr(today + i))) soon.push({ n: today + i, e: e }); });
      if (soon.length) {
        var ul = h("ul", { class: "soon" });
        soon.forEach(function (x) { ul.append(h("li", null, h("span", { class: "dot " + evWho(x.e) }), h("span", { class: "sd" }, WD[(x.n + 3) % 7] + " " + dayLabel(x.n)), h("span", null, x.e.title || "Termin"))); });
        body.push(h("p", { class: "slabel" }, "In den nächsten Tagen"), ul);
      }
      box.append(homeCard("Termine", "cal", body, "Kalender"));
    }

    /* Putzplan */
    if (tasks !== null) {
      var due = tasks.map(function (t) { var i = info(t); return { t: t, d: i.d, who: i.who, demand: i.demand }; })
        .filter(function (x) { return !x.demand && x.d <= 0; })
        .sort(function (a, b) { return a.d - b.d || String(a.t.name).localeCompare(String(b.t.name), "de"); });
      var tb = [];
      if (!due.length) tb.push(h("p", { class: "noneyet" }, "Heute ist nichts fällig. 🎉"));
      else {
        var tl = h("ul", { class: "soon tasks" });
        due.slice(0, 5).forEach(function (x) {
          tl.append(h("li", null, h("span", { class: "chip " + x.who }, x.who === "egal" ? "F·C" : x.who),
            h("span", { class: "tn" }, x.t.name), h("span", { class: "td " + (x.d < 0 ? "late" : "today") }, x.d < 0 ? "überfällig" : "heute")));
        });
        tb.push(tl);
        if (due.length > 5) tb.push(h("p", { class: "foot" }, "und " + (due.length - 5) + " weitere"));
      }
      box.append(homeCard("Putzplan", "putz", tb));
    }

    /* Essen */
    if (planLoaded && recipes !== null) {
      var st = slotsOf(plan[ts]);
      var line = function (name, dishes, out, note) {
        var txt = out ? "Auswärts" + (note ? ": " + note : "") : dishes.length ? dishes.map(function (d) { var r = recipes.filter(function (x) { return x.id === d.id; })[0]; return r ? r.name : d.name; }).join(", ") : "noch nichts geplant";
        return h("div", { class: "mline" }, h("span", { class: "slabel" }, name), h("span", { class: dishes.length || out ? "mt" : "mt none" }, txt));
      };
      box.append(homeCard("Essen heute", "meal", [line("Mittagessen", st.lunch, st.outLunch, st.noteLunch), line("Abendessen", st.dinner, st.outDinner, st.noteDinner)], "Essensplan"));
    }

    /* Einkauf */
    if (stores !== null) {
      var sb = [];
      var withItems = sortedStores().map(function (s) { return { s: s, n: shopCount(s.id) }; }).filter(function (x) { return x.n > 0; });
      if (!withItems.length) sb.push(h("p", { class: "noneyet" }, "Nichts auf den Einkaufslisten."));
      else {
        var row = h("div", { class: "bought" });
        withItems.forEach(function (x) { row.append(h("button", { class: "store", type: "button", onclick: function () { curStore = x.s.id; lsSet("pp-store", x.s.id); goSection("shop"); } }, x.s.name, h("span", { class: "cnt" }, String(x.n)))); });
        sb.push(row);
      }
      box.append(homeCard("Einkauf", "shop", sb));
    }

    /* Budget */
    if (budgets !== null && budgets.length) {
      var b = resolveBudget();
      if (b) {
        var spent = spends.filter(function (x) { return x.budget === b.id; }).reduce(function (a, x) { return a + (x.amount || 0); }, 0);
        var left = b.amount - spent, over = left < 0;
        var ds0 = dn(b.start), de0 = dn(b.end), tot = de0 - ds0 + 1;
        var dl = today > de0 ? 0 : de0 - Math.max(today, ds0) + 1;
        var fill = Math.min(100, spent / b.amount * 100);
        box.append(homeCard("Budget", "spend", [
          h("div", { class: "budgetline" }, h("span", { class: "num" + (over ? " over" : "") }, (over ? "−" : "") + eur(Math.abs(left))), h("span", { class: "lbl" }, over ? " drüber" : " übrig")),
          h("div", { class: "pwrap" }, h("div", { class: "pbar" + (over ? " over" : ""), role: "img", "aria-label": pct(spent / b.amount * 100) + " ausgegeben" }, h("span", { style: "width:" + fill + "%" }))),
          h("p", { class: "foot" }, (b.name ? b.name + " · " : "") + (today > de0 ? "Zeitraum beendet" : "noch " + dl + (dl === 1 ? " Tag" : " Tage")) + (!over && dl > 0 ? " · " + eur(Math.floor(left / dl)) + " pro Tag" : ""))
        ]));
      }
    }
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
  /* Wiederholungen */
  function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function addMonthsStr(str, n, day) {
    var p = str.split("-").map(Number);
    var tot = p[0] * 12 + (p[1] - 1) + n;
    var y = Math.floor(tot / 12), m = tot % 12 + 1;
    var d = Math.min(day || p[2], daysIn(y, m));
    return y + "-" + pad(m) + "-" + pad(d);
  }
  function nextBudgetPeriod(b) {
    var sp = String(b.start).split("-").map(Number), ep = String(b.end).split("-").map(Number);
    if (sp.length !== 3 || ep.length !== 3 || String(b.end) < String(b.start)) return null;
    if (sp[2] === 1 && ep[2] === daysIn(ep[0], ep[1])) {            // ganze Monate: Monat für Monat weiter
      var months = (ep[0] - sp[0]) * 12 + (ep[1] - sp[1]) + 1;
      var ns = addMonthsStr(b.start, months, 1);
      var np = ns.split("-").map(Number);
      var ne = addMonthsStr(ns, months - 1, 1).split("-").map(Number);
      return { start: ns, end: ne[0] + "-" + pad(ne[1]) + "-" + pad(daysIn(ne[0], ne[1])) };
    }
    var len = dn(b.end) - dn(b.start) + 1;                           // sonst: gleich viele Tage direkt danach
    return { start: dnToStr(dn(b.end) + 1), end: dnToStr(dn(b.end) + len) };
  }
  function nextSpendDate(sp) {
    var step = sp.repeat, last = String(sp.date), origin = String(sp.origin || sp.date);
    var cnt = step === "custom" ? Math.max(1, Math.min(999, Math.round(Number(sp.every)) || 1)) : 1, un = step === "custom" ? sp.unit : "";
    if (step === "week" || un === "w" || un === "d") return dnToStr(dn(last) + (un === "d" ? cnt : un === "w" ? 7 * cnt : 7));
    var every = step === "year" ? 12 : un === "j" ? 12 * cnt : un === "m" ? cnt : 1, od = Number(origin.split("-")[2]);
    var n = 1;
    for (var guard = 0; guard < 2000; guard++, n++) {
      var cand = addMonthsStr(origin, n * every, od);
      if (cand > last) return cand;
    }
    return null;
  }
  var repPending = {}, spendsLoaded = false, repBusy = false;
  function ensureRepeats() {
    if (!db || dbMissing || budgets === null || !spendsLoaded || repBusy) return;
    var today = todayStr(), writes = [];
    var allB = budgets.slice();
    var latest = {};
    budgets.forEach(function (b) { var k = b.series || b.id; if (!latest[k] || String(b.start) > String(latest[k].start)) latest[k] = b; });
    Object.keys(latest).forEach(function (k) {
      var cur = latest[k], n = 0;
      while (cur.repeat === true && n < 36) {
        var np = nextBudgetPeriod(cur);
        if (!np || np.start > today) break;
        var id = "s" + k + "-" + np.start;
        var nb = { name: cur.name || "", start: np.start, end: np.end, amount: cur.amount, repeat: true, series: k, at: Date.now() };
        nb.id = id;
        if (!allB.some(function (x) { return x.id === id; }) && !repPending[id]) { repPending[id] = true; var d = Object.assign({}, nb); delete d.id; writes.push(["budgets/" + id, d, id]); }
        allB.push(nb);
        cur = nb; n++;
      }
    });
    var latestS = {};
    spends.forEach(function (x) { if (!x.series) return; if (!latestS[x.series] || String(x.date) > String(latestS[x.series].date)) latestS[x.series] = x; });
    Object.keys(latestS).forEach(function (k) {
      var cur = latestS[k], n = 0;
      while (cur.repeat && n < 60) {
        var nd = nextSpendDate(cur);
        if (!nd || nd > today) break;
        var bud = allB.filter(function (x) { return x.start <= nd && nd <= x.end; })[0];
        if (!bud) break;
        var id = "x" + k + "-" + nd;
        var ns = { budget: bud.id, amount: cur.amount, category: cur.category, place: cur.place || "", what: cur.what || "", date: nd, by: cur.by || "", at: Date.now(), repeat: cur.repeat, series: k, origin: cur.origin || cur.date, auto: true };
        if (cur.repeat === "custom") { ns.every = cur.every; ns.unit = cur.unit; }
        if (!spends.some(function (x) { return x.id === id; }) && !repPending[id]) { repPending[id] = true; writes.push(["spend/" + id, ns, id]); }
        cur = Object.assign({ id: id }, ns); n++;
      }
    });
    if (!writes.length) return;
    repBusy = true;
    var chain = Promise.resolve();
    writes.forEach(function (w) { chain = chain.then(function () { return db.doc(w[0]).set(w[1]); }).then(function () { delete repPending[w[2]]; }, function (e) { delete repPending[w[2]]; throw e; }); });
    chain.then(function () { repBusy = false; toast(writes.length === 1 ? "Eine wiederkehrende Buchung wurde automatisch angelegt." : writes.length + " wiederkehrende Buchungen wurden automatisch angelegt."); })
      .catch(function (e) { repBusy = false; writeFail(e); });
  }
  function stopBudgetSeries(b) {
    var k = b.series || b.id;
    return Promise.all((budgets || []).filter(function (x) { return (x.series || x.id) === k && x.repeat === true; })
      .map(function (x) { return db.doc("budgets/" + x.id).update({ repeat: false }); }));
  }
  function stopSpendSeries(sp) {
    if (!sp.series) return Promise.resolve();
    return Promise.all(spends.filter(function (x) { return x.series === sp.series && x.repeat; })
      .map(function (x) { return db.doc("spend/" + x.id).update({ repeat: "" }); }));
  }
  var REPEAT_LABEL = { week: "wöchentlich", month: "monatlich", year: "jährlich" };
  var UNIT_NAMES = { d: ["Tag", "Tage"], w: ["Woche", "Wochen"], m: ["Monat", "Monate"], j: ["Jahr", "Jahre"] };
  function repeatText(o) {
    if (!o) return "";
    if (REPEAT_LABEL[o.repeat]) return REPEAT_LABEL[o.repeat];
    if (o.repeat === "custom" && UNIT_NAMES[o.unit]) {
      var n = Math.round(Number(o.every)) || 1;
      return n === 1 ? "jede" + (o.unit === "w" ? " Woche" : o.unit === "j" ? "s Jahr" : o.unit === "m" ? "n Monat" : "n Tag") : "alle " + n + " " + UNIT_NAMES[o.unit][1];
    }
    return "";
  }

  function openBudgetForm(mode, b) {
    budgetForm = mode; confirmBudgetDel = false;
    $("brepeat").checked = !!(b && b.repeat === true);
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
    var stop = s.repeat ? stopSpendSeries(s) : Promise.resolve();
    stop.then(function () { return db.doc("spend/" + s.id).delete(); }).then(function () {
      toast(s.repeat ? "Ausgabe gelöscht. Die Wiederholung ist beendet." : "Ausgabe gelöscht.", "Rückgängig", function () { db.doc("spend/" + s.id).set(copy).catch(writeFail); });
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
      h("p", { class: "foot" }, "Der Strich zeigt, wie weit der Zeitraum heute ist." + (b.repeat === true ? " Dieses Budget wiederholt sich automatisch." : ""))));

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
        var meta = [String(s.category || "").trim() || "Sonstiges", s.place, s.date ? fmt(s.date) : "", repeatText(s) ? "↻ " + repeatText(s) : ""].filter(Boolean).join(" · ");
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
    $("calview").hidden = section !== "cal";
    $("homeview").hidden = section !== "home";
    [["home", "tabhome"], ["putz", "tabputz"], ["shop", "tabshop"], ["cook", "tabcook"], ["meal", "tabmeal"], ["cal", "tabcal"], ["spend", "tabspend"]].forEach(function (p) {
      var b = $(p[1]);
      if (section === p[0]) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    if (section === "home") { try { renderHome(); } catch (e) {} }
  }

  /* Start */
  ROOMS.forEach(function (r) { $("newroom").append(h("option", { value: r }, r)); });
  intervalOptions($("newint"), 7);
  function syncNewInt() {
    var v = $("newint").value;
    $("newcustom").hidden = v !== "custom";
    $("newn").disabled = v !== "custom";   // ausgeblendete Felder dürfen das Absenden nicht blockieren
    $("newstartlbl").hidden = v === "demand";
  }
  $("newint").addEventListener("change", syncNewInt);
  syncNewInt();

  $("tabhome").addEventListener("click", function () { goSection("home"); });
  $("tabputz").addEventListener("click", function () { section = "putz"; lsSet("pp-section", "putz"); syncControls(); });
  $("tabshop").addEventListener("click", function () { section = "shop"; lsSet("pp-section", "shop"); syncControls(); });
  $("tabcook").addEventListener("click", function () { section = "cook"; lsSet("pp-section", "cook"); syncControls(); });
  $("tabcal").addEventListener("click", function () { section = "cal"; lsSet("pp-section", "cal"); syncControls(); renderCal(); });
  $("calprev").addEventListener("click", function () { calStep(-1); });
  $("calnext").addEventListener("click", function () { calStep(1); });
  $("caltoday").addEventListener("click", function () { calAnchor = calSel = dn(todayStr()); renderCal(); });
  $("calmode").addEventListener("click", function (e) {
    var v = e.target.getAttribute && e.target.getAttribute("data-v");
    if (v !== "month" && v !== "week") return;
    calMode = v; lsSet("pp-calmode", v);
    if (v === "week") calAnchor = calSel; else calAnchor = calSel;
    renderCal();
  });
  $("icspick").addEventListener("click", function () { $("icsfile").click(); });
  $("icsfile").addEventListener("change", function (e) { readIcsFile(e.target.files && e.target.files[0]); e.target.value = ""; });
  $("icsexport").addEventListener("click", exportIcs);
  $("icsclear").addEventListener("click", clearImported);
  $("evall").addEventListener("change", syncEvAll);
  $("evcancel").addEventListener("click", closeEv);
  $("evdel").addEventListener("click", function () {
    if (!evDraft || !evDraft.id || !db) return;
    if (!confirmEvDel) { confirmEvDel = true; $("evdel").textContent = "Ja, Termin löschen"; $("evdel").className = "linkbtn danger"; return; }
    var id = evDraft.id;
    db.doc("events/" + id).delete().then(function () { closeEv(); toast("Termin gelöscht."); }).catch(writeFail);
  });
  $("evform").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var title = $("evtitle").value.trim();
    if (!title) { toast("Gib dem Termin einen Namen."); $("evtitle").focus(); return; }
    var date = $("evdate").value, endDate = $("evend").value, all = $("evall").checked;
    if (!date) { toast("Wähle ein Datum."); return; }
    if (endDate && endDate < date) { toast("Das Enddatum liegt vor dem Startdatum."); return; }
    var st = all ? "" : $("evstart").value, en = all ? "" : $("evfinish").value;
    if (!all && !st) { toast("Gib eine Startzeit ein oder wähle „ganztägig“."); return; }
    if (!all && en && (!endDate || endDate === date) && en < st) { toast("Die Endzeit liegt vor der Startzeit."); return; }
    var doc = { title: title, who: $("evwho").value, date: date, endDate: endDate && endDate !== date ? endDate : "", allDay: all, start: st, end: en, place: $("evplace").value.trim(), note: $("evnote").value.trim() };
    var p;
    if (evDraft && evDraft.id) p = db.doc("events/" + evDraft.id).update(doc);
    else { doc.by = me || ""; doc.at = Date.now(); p = db.collection("events").add(doc); }
    p.then(function () { calSel = dn(date); calAnchor = calSel; closeEv(); toast("„" + title + "“ ist im Kalender."); }).catch(writeFail);
  });
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
    if (b.repeat === true) chain = chain.then(function () { return stopBudgetSeries(b); });
    spends.filter(function (s) { return s.budget === b.id; }).forEach(function (s) { chain = chain.then(function () { return s.repeat ? stopSpendSeries(s) : null; }).then(function () { return db.doc("spend/" + s.id).delete(); }); });
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
    var doc = { name: $("bname").value.trim(), start: start, end: end, amount: cents, repeat: $("brepeat").checked };
    var p;
    if (budgetForm === "edit") { var b = resolveBudget(); p = db.doc("budgets/" + b.id).update(doc).then(function () { return b.id; }); }
    else { var bref = db.collection("budgets").doc(); doc.at = Date.now(); doc.series = bref.id; p = bref.set(doc).then(function () { return bref.id; }); }
    p.then(function (id) {
      curBudget = id; lsSet("pp-budget", id); budgetForm = null; formBudget = null; renderSpend(); toast("Budget gespeichert.");
    }).catch(writeFail);
  });
  function syncRepeat() {
    var on = $("srepeat").value === "custom";
    $("scustom").hidden = !on; $("severy").disabled = !on;
  }
  $("srepeat").addEventListener("change", syncRepeat);
  syncRepeat();
  $("spendform").addEventListener("submit", function (e) {
    e.preventDefault();
    var b = resolveBudget();
    if (!b) return;
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var cents = parseEuro($("samount").value);
    if (!cents) { toast("Gib einen Betrag ein, z. B. 12,50."); $("samount").focus(); return; }
    var date = $("sdate").value || todayStr();
    var doc = { budget: b.id, amount: cents, category: $("scat").value.trim() || "Sonstiges", place: $("splace").value.trim(), what: $("swhat").value.trim(), date: date, by: me || "", at: Date.now() };
    var rep = $("srepeat").value;
    var sref = db.collection("spend").doc();
    if (REPEAT_LABEL[rep]) { doc.repeat = rep; doc.series = sref.id; doc.origin = date; }
    else if (rep === "custom") {
      var ev = Math.round(Number($("severy").value));
      if (!(ev >= 1 && ev <= 999)) { toast("Bitte bei „Eigener Abstand“ eine Zahl von 1 bis 999 eingeben."); $("severy").focus(); return; }
      var un = $("sunit").value;
      if (!UNIT_NAMES[un]) un = "w";
      doc.repeat = "custom"; doc.every = ev; doc.unit = un; doc.series = sref.id; doc.origin = date;
    }
    sref.set(doc).then(function () {
      $("samount").value = ""; $("swhat").value = ""; $("splace").value = ""; $("srepeat").value = ""; syncRepeat();
      toast(eur(cents) + " eingetragen." + (doc.repeat ? " Wiederholt sich " + repeatText(doc) + "." : ""));
      $("samount").focus();
    }).catch(writeFail);
  });
  $("tabmeal").addEventListener("click", function () { section = "meal"; lsSet("pp-section", "meal"); pickDay = null; syncControls(); renderMeal(); });
  $("pickplan").addEventListener("click", function () { section = "meal"; lsSet("pp-section", "meal"); pickDay = null; syncControls(); renderMeal(); });
  $("weekprev").addEventListener("click", function () { weekOffset--; pickDay = null; renderMeal(); });
  $("weeknext").addEventListener("click", function () { weekOffset++; pickDay = null; renderMeal(); });
  $("weektoday").addEventListener("click", function () { weekOffset = 0; pickDay = null; renderMeal(); });
  function startMealPantry(ids, slots) {
    if (!ids.length) return;
    picked = {};
    ids.forEach(function (id) { picked[id] = true; });
    pantryCtx = { slots: slots };
    section = "cook"; lsSet("pp-section", "cook");
    syncControls();
    openPantry();
  }
  $("mealshop").addEventListener("click", function () { startMealPantry(mealIds, mealCtx.slots); });
  $("mealshopagain").addEventListener("click", function () { startMealPantry(mealCtx.allIds, mealCtx.all); });
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
    var days = readInterval($("newint"), $("newn"), $("newunit"));
    if (days === null) { toast("Bitte bei „Eigener Abstand“ eine Zahl von 1 bis 999 eingeben."); return; }
    var pv = readPoints($("newpoints"));
    if (pv === null) { toast("Punkte: bitte eine ganze Zahl von 1 bis 10 eingeben."); return; }
    var doc = {
      name: name,
      room: $("newroom").value,
      intervalDays: days,
      points: pv,
      together: $("newtogether").checked,
      assignee: who,
      turn: who === "abwechselnd" ? "F" : "",
      lastDone: days > 0 && $("newstart").value === "later" ? todayStr() : "",
      lastBy: "",
      countF: 0,
      countC: 0,
      createdAt: todayStr()
    };
    db.collection("tasks").add(doc).then(function () {
      $("newname").value = ""; $("newpoints").value = "1"; $("newtogether").checked = false;
      toast("„" + name + "“ ist im Plan" + (days === 0 ? " (nach Bedarf)." : "."));
    }).catch(writeFail);
  });

  document.addEventListener("visibilitychange", function () { if (!document.hidden) render(); });

  /* Farben für F und C (nur auf diesem Gerät gespeichert) */
  var PALETTE = [
    { k: "blau", n: "Blau", l: ["#2f4bc0", "#e3e8fb"], d: ["#8da2ff", "#1e2850"] },
    { k: "pink", n: "Pink", l: ["#a82a77", "#f9e2f0"], d: ["#f08fcb", "#3c1d33"] },
    { k: "rot", n: "Rot", l: ["#c0392b", "#fbe4e1"], d: ["#ff8a7a", "#4a1f1b"] },
    { k: "orange", n: "Orange", l: ["#b85c00", "#fdebd6"], d: ["#ffb066", "#47290c"] },
    { k: "gelb", n: "Gelb", l: ["#8a6d00", "#fbf0c4"], d: ["#f2d04d", "#40360c"] },
    { k: "gruen", n: "Grün", l: ["#2e7d32", "#e0f2e1"], d: ["#7fd68a", "#17381b"] },
    { k: "tuerkis", n: "Türkis", l: ["#00796b", "#d9f1ee"], d: ["#5fd8c8", "#0f3a35"] },
    { k: "hellblau", n: "Hellblau", l: ["#0277bd", "#dcedf9"], d: ["#66c2ff", "#10344d"] },
    { k: "violett", n: "Violett", l: ["#6a3fb5", "#ece4f8"], d: ["#b99cf2", "#2e1f4d"] },
    { k: "braun", n: "Braun", l: ["#7b5545", "#f1e6e1"], d: ["#cfa593", "#3a2a22"] },
    { k: "grau", n: "Grau", l: ["#546e7a", "#e4eaed"], d: ["#a9bcc6", "#27323a"] }
  ];
  function palOf(k) { return PALETTE.filter(function (x) { return x.k === k; })[0] || null; }
  function isDark() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function applyColors() {
    var root = document.documentElement.style, dark = isDark();
    [["F", "f"], ["C", "c"]].forEach(function (w) {
      var pal = palOf(lsGet("pp-col" + w[0]));
      if (!pal) { root.removeProperty("--" + w[1]); root.removeProperty("--" + w[1] + "-soft"); return; }
      var v = dark ? pal.d : pal.l;
      root.setProperty("--" + w[1], v[0]); root.setProperty("--" + w[1] + "-soft", v[1]);
    });
  }
  function renderColors() {
    var box = $("colorbox");
    if (!box) return;
    box.replaceChildren();
    var dark = isDark();
    var defs = { F: "blau", C: "pink" };
    var chosen = { F: lsGet("pp-colF") || defs.F, C: lsGet("pp-colC") || defs.C };
    ["F", "C"].forEach(function (w) {
      var other = w === "F" ? "C" : "F";
      var row = h("div", { class: "swatches", role: "group", "aria-label": "Farbe für " + w });
      row.append(h("span", { class: "swl chip " + w }, w));
      PALETTE.forEach(function (pal) {
        var taken = chosen[other] === pal.k;
        var on = chosen[w] === pal.k;
        row.append(h("button", { class: "cswatch", type: "button", disabled: taken, "aria-pressed": String(on),
          "aria-label": pal.n + (taken ? " (schon von " + other + " gewählt)" : ""), title: pal.n + (taken ? " (von " + other + " gewählt)" : ""),
          style: "background:" + (dark ? pal.d[0] : pal.l[0]),
          onclick: function () { lsSet("pp-col" + w, pal.k); applyColors(); renderColors(); } }));
      });
      box.append(row);
    });
    box.append(h("div", { class: "row" },
      h("button", { class: "linkbtn", type: "button", onclick: function () { lsSet("pp-colF", ""); lsSet("pp-colC", ""); applyColors(); renderColors(); } }, "Farben zurücksetzen"),
      h("span", { class: "hint" }, "Gilt nur auf diesem Gerät.")));
  }
  applyColors(); renderColors();
  try { if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { applyColors(); renderColors(); }); } catch (e) {}

  syncControls();
  render();

  /* ---------- Daten: Supabase (über js/store-supabase.js) ---------- */
  var COLLS = ["tasks", "log", "stores", "shop", "recipes", "plan", "budgets", "spend", "events"];
  var dataStarted = false;

  function listen(coll, apply) {
    db.collection(coll).onSnapshot(function (snap) {
      apply(snap.docs.map(function (d) { return Object.assign({}, d.data(), { id: d.id }); }));
      if (section === "home") renderHome();
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
      ensureRepeats();
    });
    listen("events", function (a) { events = a; eventsLoaded = true; if (!evDraft) renderCal(); });
    listen("spend", function (a) { spends = a; spendsLoaded = true; renderSpend(); ensureRepeats(); });
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
    $("pwform").hidden = kind !== "recover";
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
    $("pwform").addEventListener("submit", function (e) {
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

  window.addEventListener("error", function (e) { try { toast("Ein Fehler ist aufgetreten: " + String(e && e.message || "unbekannt").slice(0, 140), null, null, true); } catch (x) {} });
  window.addEventListener("unhandledrejection", function (e) { try { toast("Ein Fehler ist aufgetreten: " + String(e && e.reason && e.reason.message || "unbekannt").slice(0, 140), null, null, true); } catch (x) {} });
  $("doexport").addEventListener("click", exportData);
  $("doimport").addEventListener("click", function () { $("importfile").click(); });
  $("importfile").addEventListener("change", function (e) { readImportFile(e.target.files && e.target.files[0]); e.target.value = ""; });
  $("doexample").addEventListener("click", loadExamples);

  boot();
})();
