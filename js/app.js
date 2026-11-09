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
  var newFollow = {};
  var pickF = { q: "", tm: 0, em: 0, l: [] }, cookQ = "", cookL = [], cookX = [], cookTm = 0, cookEm = 0, openDish = {}, pickFOpen = false, labelDefs = [{ id: "_side", emoji: "🥣", name: "Beilage" }], confirmLabelDel = null, newLabel = { emoji: "", name: "" };
  var confirmExamples = false;
  var period = "30";
  var view = "plan";
  var toastTimer = null;
  var sv = lsGet("pp-section");
  var section = sv === "shop" || sv === "cook" || sv === "meal" || sv === "cal" || sv === "spend" || sv === "bus" || sv === "putz" ? sv : "home";
  var events = [], eventsLoaded = false;
  var calOpen = {};
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
    if (t.pending === true) {
      var nat = isDemand(t) ? 0 : (t.lastDone ? dn(t.lastDone) + (Number(t.intervalDays) || 7) - today : 0);
      return { d: Math.min(0, nat), who: who, pending: true };
    }
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
  function markDone(t, both, who) {
    togetherAsk = null;
    var by = who || me;
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    if (!by && !both) {
      toast("Wähle oben zuerst, ob du F oder C bist.");
      var seg = $("me");
      seg.classList.remove("nudge"); void seg.offsetWidth; seg.classList.add("nudge");
      seg.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    var prev = {
      pending: t.pending === true,
      pendingBy: t.pendingBy || "",
      lastDone: t.lastDone || "",
      lastBy: t.lastBy || "",
      turn: t.turn || "",
      countF: t.countF || 0,
      countC: t.countC || 0
    };
    var next = both ? {
      pending: false, pendingBy: "",
      lastDone: todayStr(),
      lastBy: "F & C",
      countF: prev.countF + 1,
      countC: prev.countC + 1,
      turn: t.assignee === "abwechselnd" ? (t.turn === "C" ? "C" : "F") : ""
    } : {
      pending: false, pendingBy: "",
      lastDone: todayStr(),
      lastBy: by,
      countF: prev.countF + (by === "F" ? 1 : 0),
      countC: prev.countC + (by === "C" ? 1 : 0),
      turn: t.assignee === "abwechselnd" ? (by === "F" ? "C" : "F") : ""
    };
    var demand = isDemand(t);
    var ref = db.doc("tasks/" + t.id);
    var whoList = both ? ["F", "C"] : [by];
    var lrefs = whoList.map(function () { return db.collection("log").doc(); });
    var entries = whoList.map(function (w) {
      var en = { taskId: t.id, task: t.name, room: t.room || "Überall", by: w, date: todayStr(), at: Date.now(), points: pointsOf(t) };
      if (both) en.together = true;
      return en;
    });
    var fol = (Array.isArray(t.follow) ? t.follow : []).map(function (id) { return (tasks || []).filter(function (y) { return y.id === id; })[0]; }).filter(function (x) { return x && x.id !== t.id; });
    var folPrev = fol.map(function (x) { return { id: x.id, pending: x.pending === true, pendingBy: x.pendingBy || "" }; });
    var folWrites = fol.map(function (x) { return db.doc("tasks/" + x.id).update({ pending: true, pendingBy: t.name }); });
    Promise.all([ref.update(next)].concat(lrefs.map(function (lr, i) { return lr.set(entries[i]); }), folWrites)).then(function () {
      var days = Number(t.intervalDays) || 7;
      toast("„" + t.name + "“ erledigt" + (both ? " (zusammen, beide bekommen " + pointsOf(t) + (pointsOf(t) === 1 ? " Punkt" : " Punkte") + ")." : ".") + (fol.length ? " Jetzt fällig: " + fol.map(function (x) { return x.name; }).join(", ") + "." : "") + (demand ? "" : " Wieder dran " + (days === 1 ? "morgen" : "in " + days + " Tagen") + "."), "Rückgängig", function () {
        Promise.all([ref.update(prev)].concat(lrefs.map(function (lr) { return lr.delete(); }), folPrev.map(function (x) { return db.doc("tasks/" + x.id).update({ pending: x.pending, pendingBy: x.pendingBy }); }))).catch(writeFail);
      });
    }).catch(writeFail);
  }
  var confirmLogDel = null;
  /* Einen erledigten Eintrag nachträglich zurücknehmen (bei "zusammen" beide Einträge) */
  function removeLog(l) {
    confirmLogDel = null;
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return; }
    var gone = [l];
    if (l.together) {
      var sib = logs.filter(function (x) { return x.id !== l.id && x.together && x.taskId === l.taskId && x.date === l.date && x.by !== l.by && Math.abs((x.at || 0) - (l.at || 0)) < 120000; })[0];
      if (sib) gone.push(sib);
    }
    var goneIds = {}; gone.forEach(function (x) { goneIds[x.id] = true; });
    var saved = gone.map(function (x) { var d = Object.assign({}, x); delete d.id; return { id: x.id, data: d }; });
    var writes = gone.map(function (x) { return db.doc("log/" + x.id).delete(); });
    var t = l.taskId ? (tasks || []).filter(function (y) { return y.id === l.taskId; })[0] : null;
    var prev = null;
    if (t) {
      var rest = logs.filter(function (x) { return x.taskId === t.id && !goneIds[x.id]; })
        .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.at || 0) - (a.at || 0); });
      var last = rest[0] || null;
      var cF = t.countF || 0, cC = t.countC || 0;
      gone.forEach(function (x) { if (x.by === "C") cC = Math.max(0, cC - 1); else cF = Math.max(0, cF - 1); });
      var upd = { lastDone: last ? last.date : "", lastBy: last ? (last.together ? "F & C" : last.by) : "", countF: cF, countC: cC };
      if (t.assignee === "abwechselnd") upd.turn = last ? (last.together ? (t.turn || "F") : (last.by === "F" ? "C" : "F")) : (l.together ? (t.turn || "F") : (l.by === "C" ? "C" : "F"));
      prev = { lastDone: t.lastDone || "", lastBy: t.lastBy || "", countF: t.countF || 0, countC: t.countC || 0, turn: t.turn || "" };
      writes.push(db.doc("tasks/" + t.id).update(upd));
    }
    Promise.all(writes).then(function () {
      toast("Eintrag „" + (l.task || "Aufgabe") + "“ entfernt.", "Rückgängig", function () {
        var back = saved.map(function (s) { return db.doc("log/" + s.id).set(s.data); });
        if (t && prev) back.push(db.doc("tasks/" + t.id).update(prev));
        Promise.all(back).catch(writeFail);
      });
    }).catch(writeFail);
  }
  var ddOpen = {};
  /* Ausklappbare Auswahl (Dropdown) mit Häkchen für verknüpfte Aufgaben */
  function followChips(sel, exceptId) {
    var key = exceptId || "new";
    var others = (tasks || []).filter(function (x) { return x.id !== exceptId; }).slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "de"); });
    var count = function () { return Object.keys(sel).filter(function (k) { return sel[k] && others.some(function (o) { return o.id === k; }); }).length; };
    var label = h("span", { class: "ddcount" });
    var upd = function () { var n = count(); label.textContent = n === 0 ? "keine ausgewählt" : n === 1 ? "1 Aufgabe" : n + " Aufgaben"; };
    var dd = h("details", { class: "dd" }, h("summary", null, "Aufgaben auswählen · ", label));
    dd.open = !!ddOpen[key];
    dd.addEventListener("toggle", function () { ddOpen[key] = dd.open; });
    var box = h("div", { class: "ddlist" });
    others.forEach(function (x) {
      var cb = h("input", { type: "checkbox", checked: !!sel[x.id], onchange: function (e) { sel[x.id] = e.target.checked; upd(); } });
      box.append(h("label", { class: "chk" }, cb, " " + x.name));
    });
    dd.append(box);
    upd();
    return dd;
  }
  function renderNewFollow() {
    var box = $("newfollow");
    if (!box) return;
    box.replaceChildren();
    var many = (tasks || []).length > 0;
    box.append(many ? followChips(newFollow, null) : h("p", { class: "hint" }, "Noch keine andere Aufgabe da. Lege zuerst eine zweite an, dann kannst du sie hier verknüpfen."));
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
    var status = inf.pending ? "today" : inf.demand ? "ok" : inf.d < 0 ? "late" : inf.d === 0 ? "today" : "ok";
    var isOpen = !!open[t.id];
    var metaParts = [t.room || "Überall", intervalLabel(Number(t.intervalDays))];
    if (t.assignee === "abwechselnd") metaParts.push("abwechselnd");
    if (t.assignee === "egal") metaParts.push("egal wer");
    if (pointsOf(t) > 1) metaParts.push(pointsOf(t) + " Punkte");
    var fol = (Array.isArray(t.follow) ? t.follow : []).map(function (id) { var x = (tasks || []).filter(function (y) { return y.id === id; })[0]; return x ? x.name : ""; }).filter(Boolean);
    if (fol.length) metaParts.push("danach: " + fol.join(", "));
    var li = h("li", { class: "task" });
    var check = h("button", { class: "check", type: "button", "aria-label": "Erledigt: " + t.name, onclick: function () {
      markDone(t);
    } });
    check.innerHTML = CHECK;
    var title = h("button", { class: "title", type: "button", "aria-expanded": isOpen ? "true" : "false", onclick: function () {
      if (open[t.id]) delete open[t.id]; else open[t.id] = true;
      confirmDel = null; render();
    } }, t.name);
    li.append(
      check,
      h("div", { class: "body" }, title, h("div", { class: "due " + status }, inf.pending ? "fällig" + (t.pendingBy ? " nach „" + t.pendingBy + "“" : "") : inf.demand ? agoText(t.lastDone) : dueText(inf.d))),
      h("div", { class: "side" },
        h("span", { class: "chip " + inf.who, title: inf.who === "egal" ? "Zuständig: egal wer" : "Zuständig: " + inf.who, "aria-label": inf.who === "egal" ? "Zuständig: egal wer" : "Zuständig: " + inf.who }, inf.who === "egal" ? "F·C" : inf.who),
        h("button", { class: "tog", type: "button", title: "Zusammen erledigt (beide bekommen die Punkte)", "aria-label": "Zusammen erledigt: " + t.name, onclick: function () { markDone(t, true); } }, "👥"))
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
        actions.append(
          h("button", { class: "linkbtn", type: "button", onclick: function () { editing[t.id] = !editing[t.id]; render(); } }, editing[t.id] ? "Ändern schließen" : "Name und Rhythmus ändern"),
          h("button", { class: "linkbtn", type: "button", onclick: function () { confirmDel = t.id; render(); } }, "Aufgabe löschen"));
      }
      li.append(h("div", { class: "more" }, h("div", { class: "meta" }, metaParts.join(" · ")), h("div", null, last), editing[t.id] ? editForm(t) : null, actions));
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
    var fsel = {};
    (Array.isArray(t.follow) ? t.follow : []).forEach(function (id) { fsel[id] = true; });
    var fbox = (tasks || []).some(function (x) { return x.id !== t.id; }) ? followChips(fsel, t.id) : h("p", { class: "hint" }, "Noch keine andere Aufgabe da. Sobald es eine zweite gibt, kannst du sie hier verknüpfen.");
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
      var upd = { name: newName, intervalDays: days, assignee: who.value, points: pv, follow: Object.keys(fsel).filter(function (k) { return fsel[k]; }) };
      if (who.value === "abwechselnd") upd.turn = t.turn === "C" ? "C" : "F"; else upd.turn = "";
      db.doc("tasks/" + t.id).update(upd).then(function () { editing[t.id] = false; toast("Gespeichert."); }).catch(writeFail);
    } },
      h("label", null, "Name", nm),
      h("label", null, "Wie oft?", sel), cust,
      h("label", null, "Zuständig", who), h("label", null, "Punkte (wie anstrengend ist die Aufgabe?)", pts),
      h("div", { class: "alsobox" }, h("span", { class: "hint" }, "Verknüpfen: Welche Aufgabe wird fällig, wenn diese abgehakt wird?"), fbox), err,
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
    renderNewFollow();
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
      ["Nach Bedarf", function (d) { return d >= DEMAND; }],
      ["Diese Woche", function (d) { return d >= 1 && d <= 7; }],
      ["Später", function (d) { return d > 7 && d < DEMAND; }]
    ];
    groups.forEach(function (g) {
      var items = shown.filter(function (x) { return g[1](x.d); });
      if (!items.length) return;
      var ul = h("ul", { class: "tasks" });
      items.forEach(function (x) { ul.append(row(x.t)); });
      var gk = "pp-fold-" + g[0], det = h("details", { class: "group fold" }, h("summary", null, h("h2", null, g[0], h("span", { class: "n" }, String(items.length))), h("span", { class: "chev", "aria-hidden": "true" })), ul);
      det.open = lsGet(gk) !== "0";
      det.addEventListener("toggle", function () { lsSet(gk, det.open ? "1" : "0"); });
      list.append(det);
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

    var recent = items.slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0) || String(b.date).localeCompare(String(a.date)); }).slice(0, 15);
    var ul = h("ul", { class: "recent" });
    recent.forEach(function (l) {
      var who = l.by === "C" ? "C" : "F";
      var del = confirmLogDel === l.id
        ? h("div", { class: "row" },
            h("button", { class: "linkbtn danger", type: "button", onclick: function () { removeLog(l); } }, "Entfernen"),
            h("button", { class: "linkbtn", type: "button", onclick: function () { confirmLogDel = null; renderStats(); } }, "Behalten"))
        : h("button", { class: "x", type: "button", "aria-label": "Erledigt-Eintrag entfernen: " + (l.task || "Aufgabe"), title: "Aus erledigt entfernen", onclick: function () { confirmLogDel = l.id; renderStats(); } }, "×");
      ul.append(h("li", null, h("span", { class: "chip " + who }, who), h("span", { class: "rt" }, (l.task || "Aufgabe") + (pointsOf(l) > 1 ? " · " + pointsOf(l) + " P." : "") + (l.together ? " · zusammen" : "")), h("span", { class: "rd" }, fmt(l.date)), del));
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
  var editItemId = null, doneEdit = false, chipEdit = null;
  function histChange(storeId, oldName, newName, aisle) {
    var st = (stores || []).filter(function (x) { return x.id === storeId; })[0];
    if (!st || !db) return;
    var key = String(oldName).toLowerCase(), nk = newName ? newName.toLowerCase() : "";
    var hist = (Array.isArray(st.hist) ? st.hist : []).map(function (x) { return Object.assign({}, x); });
    var out = [];
    hist.forEach(function (x) {
      var k = String(x.n).toLowerCase();
      if (k === key) { if (!newName) return; x.n = newName.slice(0, 60); if (aisle) x.a = aisle; }
      else if (nk && k === nk && nk !== key) return;
      out.push(x);
    });
    db.doc("stores/" + storeId).update({ hist: out }).catch(writeFail);
  }
  function stockChange(oldName, newName) {
    if (!db) return;
    var key = oldName.toLowerCase();
    (recipes || []).forEach(function (r) {
      var changed = false;
      var ings = (r.ingredients || []).map(function (g) {
        var c = Object.assign({}, g);
        if (kindOf(g) !== "stock" || parseItem(g.name).name.toLowerCase() !== key) return c;
        changed = true;
        if (!newName) { delete c.k; return c; }
        var pi = parseItem(g.name);
        c.name = (pi.qty ? pi.qty + " " : "") + newName;
        return c;
      });
      if (changed) db.doc("recipes/" + r.id).update({ ingredients: ings }).catch(writeFail);
    });
  }
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
  /* Suchleiste: Vorschläge bekannter Artikel; "Auch kaufbar bei" nur bei neuem Artikel */
  function updateQuick() {
    var qf = $("quickform"), ar = $("alsorow"), sg = $("quicksugg");
    ar.replaceChildren(); sg.replaceChildren();
    if (qf.hidden || !curStore) { ar.hidden = true; return; }
    var raw = $("quickname").value, cut = raw.lastIndexOf(","), prefix = cut >= 0 ? raw.slice(0, cut + 1) + " " : "";
    var q = parseItem(raw.slice(cut + 1)).name.toLowerCase();
    if (q) {
      var openKeys = {};
      items.forEach(function (i) { if (i.store === curStore && !i.done) openKeys[String(i.name).toLowerCase()] = true; });
      var res = ingCatalog().filter(function (c) { var l = c.name.toLowerCase(); return l.indexOf(q) >= 0 && !openKeys[l]; });
      res.sort(function (x, y) {
        var xs = x.name.toLowerCase().indexOf(q) === 0 ? 0 : 1, ys = y.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        return xs - ys || y.w - x.w || x.name.localeCompare(y.name, "de");
      });
      res.slice(0, 8).forEach(function (c) {
        sg.append(h("button", { class: "bchip", type: "button", onmousedown: function (e) { e.preventDefault(); }, onclick: function () {
          addItems(prefix + c.name); $("quickname").value = ""; updateQuick();
        } }, c.name));
      });
    }
    if (alsoFor !== curStore) { alsoSel = {}; alsoFor = curStore; }
    var otherSt = sortedStores().filter(function (x) { return x.id !== curStore; });
    ar.hidden = !q || !otherSt.length;
    if (!ar.hidden) {
      ar.append(h("span", { class: "hint" }, "Neu: auch kaufbar bei:"));
      otherSt.forEach(function (x) {
        var b = h("button", { class: "bchip" + (alsoSel[x.id] ? " sel" : ""), type: "button", "aria-pressed": String(!!alsoSel[x.id]), onclick: function () {
          alsoSel[x.id] = !alsoSel[x.id]; b.classList.toggle("sel", !!alsoSel[x.id]); b.setAttribute("aria-pressed", String(!!alsoSel[x.id]));
        } }, x.name);
        ar.append(b);
      });
    }
  }
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
    $("quickname").placeholder = st ? "Artikel suchen oder neu hinzufügen …" : "Artikel hinzufügen …";

    if (alsoFor !== curStore) { alsoSel = {}; alsoFor = curStore; }
    updateQuick();

    if (dbMissing) {
      body.append(h("div", { class: "banner" }, h("p", null, connText())));
      return;
    }
    if (!st) return;

    var mine = items.filter(function (i) { return i.store === st.id; });
    var open = mine.filter(function (i) { return !i.done; }).sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var openKeys = {}; open.forEach(function (i) { openKeys[String(i.name).toLowerCase()] = true; });
    var favs = (Array.isArray(st.hist) ? st.hist : []).filter(function (x) { return x && x.n && !openKeys[String(x.n).toLowerCase()]; }).slice(0, 30);
    /* Chips nach Gang im Markt gruppieren (Apfel unter Obst & Gemüse) */
    var chipsByAisle = function (entries, cls) {
      var wrap = h("div", { class: cls || "aislechips" });
      AISLES.forEach(function (ai) {
        var part = entries.filter(function (e) { return e.aisle === ai; });
        if (!part.length) return;
        wrap.append(h("p", { class: "slabel2" }, ai));
        var row = h("div", { class: "bought" });
        part.forEach(function (e) {
          if (!doneEdit || !e.edit) { row.append(h("button", { class: "bchip", type: "button", onclick: e.go }, e.name)); return; }
          if (chipEdit && chipEdit.key === e.key) { row.append(e.form()); return; }
          row.append(h("span", { class: "bchip editchip" },
            h("button", { class: "nmbtn", type: "button", "aria-label": "Bearbeiten: " + e.name, onclick: function () { chipEdit = { key: e.key }; renderShop(); } }, e.name),
            h("button", { class: "x", type: "button", "aria-label": e.name + " entfernen", onclick: function () { chipEdit = null; e.del(); } }, "×")));
        });
        wrap.append(row);
      });
      return wrap;
    };
    var chipForm = function (name, withAisle, aisle0, onSave) {
      var n = h("input", { type: "text", maxlength: "60", value: name, "aria-label": "Name", required: true });
      var a = null;
      if (withAisle) { a = h("select", { "aria-label": "Gang im Laden" }); AISLES.forEach(function (x) { a.append(h("option", { value: x, selected: x === aisle0 }, x)); }); }
      var save = function () { var v = n.value.trim(); if (!v) { toast("Es braucht einen Namen."); return; } chipEdit = null; onSave(v, a ? a.value : ""); renderShop(); };
      n.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); save(); } });
      var f = h("div", { class: "chipform" }, n);
      var bt = h("div", { class: "btns" }, h("button", { class: "linkbtn", type: "button", onclick: save }, "Speichern"), h("button", { class: "linkbtn", type: "button", onclick: function () { chipEdit = null; renderShop(); } }, "Abbrechen"));
      if (a) f.append(a); else f.append(h("span"));
      f.append(bt);
      return f;
    };
    /* Vorrat: alles, was im Kochbuch als "Immer da" markiert ist; hier die Dinge dieses Ladens */
    var stockBy = {};
    (recipes || []).forEach(function (r) { (r.ingredients || []).forEach(function (g) {
      if (kindOf(g) !== "stock") return;
      var sid = resolveStore(g.store), nm0 = parseItem(g.name).name, k0 = nm0.toLowerCase();
      if (!nm0 || !sid) return;
      var m = stockBy[sid] = stockBy[sid] || { seen: {}, list: [] };
      if (!m.seen[k0]) { m.seen[k0] = true; m.list.push(nm0); }
    }); });
    var stockList = ((stockBy[st.id] || {}).list || []).slice().sort(function (p, q) { return p.localeCompare(q, "de"); });
    var stockFree = stockList.filter(function (n) { return !openKeys[n.toLowerCase()]; });
    var otherStock = Object.keys(stockBy).filter(function (sid) { return sid !== st.id && storeName(sid); }).map(function (sid) { return storeName(sid) + " (" + stockBy[sid].list.length + ")"; });
    var hasStock = stockList.length > 0 || otherStock.length > 0;
    var favEl = null, stockEl = null;
    if (favs.length) {
      favEl = chipsByAisle(favs.map(function (x) { return { name: x.n, aisle: AISLES.indexOf(x.a) >= 0 ? x.a : guessAisle(x.n), go: function () { putMulti(st.id, x.n, x.a); },
        key: "fav:" + x.n, edit: true,
        del: function () { histChange(st.id, x.n, ""); },
        form: function () { return chipForm(x.n, true, AISLES.indexOf(x.a) >= 0 ? x.a : guessAisle(x.n), function (v, ai) { histChange(st.id, x.n, v, ai); }); } }; }), "aislechips favrow");
    }
    if (hasStock) {
      stockEl = h("details", { class: "stockbox" }, h("summary", null, "Vorrat", h("span", { class: "n" }, String(stockFree.length))));
      stockEl.open = doneEdit || lsGet("pp-stockopen") === "1";
      stockEl.addEventListener("toggle", function () { if (!doneEdit) lsSet("pp-stockopen", stockEl.open ? "1" : "0"); });
      if (stockFree.length) {
        stockEl.append(chipsByAisle(stockFree.map(function (n) { return { name: n, aisle: guessAisle(n), go: function () { putMulti(st.id, n); },
          key: "stock:" + n, edit: true,
          del: function () { stockChange(n, ""); toast("„" + n + "“ ist nicht mehr als „Immer da“ markiert."); },
          form: function () { return chipForm(n, false, "", function (v) { stockChange(n, v); }); } }; })));
      } else if (stockList.length) stockEl.append(h("p", { class: "hint" }, "Alles aus dem Vorrat steht schon auf der Liste."));
      else stockEl.append(h("p", { class: "hint" }, "Für " + st.name + " ist im Kochbuch nichts als „Immer da“ eingetragen."));
      if (otherStock.length) stockEl.append(h("p", { class: "hint" }, "Mehr Vorrat bei: " + otherStock.join(", ") + "."));
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

    if (done.length || favEl || stockEl) {
      body.append(h("div", { class: "shopeditrow" }, h("button", { class: "linkbtn", type: "button", onclick: function () { doneEdit = !doneEdit; editItemId = null; chipEdit = null; renderShop(); } }, doneEdit ? "Fertig" : "Einzelne bearbeiten")));
    }
    if (done.length || favEl) {
      var chips = null;
      if (!done.length) chips = null;
      else if (doneEdit) {
        chips = h("ul", { class: "items" });
        done.forEach(function (it) {
          var chk = h("button", { class: "check", type: "button", "aria-label": "Wieder auf die Liste: " + it.name, title: "Wieder auf die Liste", onclick: function () { setDone(it, false); } });
          chk.innerHTML = CHECK;
          if (editItemId === it.id) { chips.append(editItemRow(it, chk)); return; }
          chips.append(h("li", null, chk,
            h("button", { class: "nm nmbtn", type: "button", "aria-label": "Bearbeiten: " + it.name, onclick: function () { editItemId = it.id; renderShop(); } },
              it.qty ? h("b", { class: "qty" }, it.qty + " ") : null, it.name, alsoLabel(it)),
            h("button", { class: "x", type: "button", "aria-label": it.name + " löschen", onclick: function () { delItem(it); } }, "×")));
        });
      } else {
        chips = h("div", { class: "bought" });
        done.forEach(function (it) { chips.append(h("button", { class: "bchip", type: "button", onclick: function () { setDone(it, false); } }, it.name)); });
      }
      var cleanRow = h("div", { class: "row" });
      if (!done.length) cleanRow = null;
      else if (confirmClean) {
        cleanRow.append(
          h("button", { class: "linkbtn danger", type: "button", onclick: function () { cleanBought(st); } }, "Ja, alle löschen"),
          h("button", { class: "linkbtn", type: "button", onclick: function () { confirmClean = false; renderShop(); } }, "Abbrechen"));
      } else {
        cleanRow.append(
          h("button", { class: "linkbtn", type: "button", onclick: function () { confirmClean = true; renderShop(); } }, "Alle aufräumen"));
      }
      body.append(h("section", { class: "group" },
        done.length ? h("h2", null, "Schon gekauft", h("span", { class: "n" }, String(done.length))) : h("h2", null, "Oft gekauft"),
        favEl && done.length ? h("p", { class: "slabel2" }, "Oft gekauft") : null, favEl,
        favEl && done.length ? h("p", { class: "slabel2" }, "Heute gekauft") : null,
        chips, cleanRow));
    }
    if (stockEl) body.append(stockEl);

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
  /* Zutaten-Katalog: gespeicherte Namen, Gerichte, Einkaufslisten und Einkaufsverlauf */
  var catalogSaved = [];
  function ingCatalog() {
    var map = {}, order = [];
    function add(name, store, w) {
      var n = parseItem(name).name; if (!n) return;
      var k = n.toLowerCase();
      if (!map[k]) { map[k] = { name: n, store: "", w: 0 }; order.push(k); }
      if (!map[k].store && store && storeName(store)) map[k].store = store;
      map[k].w += w;
    }
    catalogSaved.forEach(function (c) { add(c.n, c.s, 1); });
    (recipes || []).forEach(function (r) { (r.ingredients || []).forEach(function (g) { add(g.name, g.store, 2); }); });
    (stores || []).forEach(function (s) { (Array.isArray(s.hist) ? s.hist : []).forEach(function (x) { if (x && x.n) add(x.n, s.id, 1 + Math.min(5, x.c || 0)); }); });
    (items || []).forEach(function (i) { add(i.name, i.store, 1); });
    return order.map(function (k) { return map[k]; });
  }
  function ingSuggest(text) {
    var pi = parseItem(text), q = pi.name.toLowerCase();
    if (q.length < 1) return [];
    var res = ingCatalog().filter(function (c) { var l = c.name.toLowerCase(); return l !== q && l.indexOf(q) >= 0; });
    res.sort(function (x, y) {
      var xs = x.name.toLowerCase().indexOf(q) === 0 ? 0 : 1, ys = y.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      return xs - ys || y.w - x.w || x.name.localeCompare(y.name, "de");
    });
    return res.slice(0, 6);
  }
  function rememberIngs(ings) {
    if (!db) return;
    var have = {}; catalogSaved.forEach(function (c) { have[String(c.n).toLowerCase()] = true; });
    var add = [];
    ings.forEach(function (g) {
      var n = parseItem(g.name).name, k = n.toLowerCase();
      if (!n || have[k]) return;
      have[k] = true; add.push({ n: n.slice(0, 60), s: g.store || "" });
    });
    if (!add.length) return;
    var list = catalogSaved.concat(add).slice(-400);
    catalogSaved = list;
    db.doc("plan/_catalog").set({ list: list, at: Date.now() }).catch(function () {});
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
  /* Bedienbare Skala: 5 Symbole, Tippen auf n wählt n, nochmal Tippen löscht */
  function scaleInput(icon, val, aria, onpick) {
    var wrap = h("span", { class: "scale", role: "group", "aria-label": aria });
    for (var i = 1; i <= 5; i++) (function (n) {
      wrap.append(h("button", { class: "sc" + (n <= val ? " on" : ""), type: "button", "aria-pressed": String(n === val), "aria-label": aria + ": " + n + " von 5", onclick: function () { onpick(n === val ? 0 : n); } }, icon));
    })(i);
    return wrap;
  }
  function boltEl(n) {
    n = Math.round(Number(n));
    if (!(n >= 1 && n <= 5)) return null;
    var scale = h("span", { class: "clocks", "aria-hidden": "true" });
    for (var i = 1; i <= 5; i++) scale.append(h("span", { class: i <= n ? "on" : "off" }, "⚡"));
    return h("div", { class: "dclock", role: "img", "aria-label": "Aufwand " + n + " von 5, " + EFFORT_NAMES[n], title: EFFORT_NAMES[n] }, h("span", { class: "zl" }, "Aufwand"), scale);
  }
  function miniScales(r) {
    if (!r) return null;
    var e = Math.round(Number(r.effort)), c = timeCat(r.minutes);
    if (!(e >= 1 && e <= 5) && !c) return null;
    var w = h("span", { class: "mini", role: "img", "aria-label": (e >= 1 ? "Aufwand " + e + " von 5" : "") + (e >= 1 && c ? ", " : "") + (c ? "Zeit " + c + " von 5" : "") });
    if (e >= 1 && e <= 5) w.append(h("span", { "aria-hidden": "true" }, new Array(e + 1).join("⚡")));
    if (c) w.append(h("span", { "aria-hidden": "true" }, new Array(c + 1).join("🕐")));
    return w;
  }
  function labelsOf(r) { return (Array.isArray(r.labels) ? r.labels : []).map(function (id) { return labelDefs.filter(function (l) { return l.id === id; })[0]; }).filter(Boolean); }
  function labelsEl(r) {
    var ls = labelsOf(r);
    if (!ls.length) return null;
    var box = h("span", { class: "dlabels" });
    ls.forEach(function (l) { box.append(h("span", { class: "dlabel", role: "img", "aria-label": l.name, title: l.name }, l.emoji)); });
    return box;
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
    var on = !!picked[r.id], isOpen = !!openDish[r.id];
    var ings = mainIngs(r), nExtra = extraIngs(r).length;
    var pick = h("button", { class: "pick", type: "button", "aria-pressed": String(on), "aria-label": (on ? "Abwählen: " : "Auswählen: ") + r.name, onclick: function () {
      if (picked[r.id]) delete picked[r.id]; else picked[r.id] = true;
      renderCook();
    } });
    pick.innerHTML = CHECK;
    var title = h("button", { class: "dname dtitle", type: "button", "aria-expanded": String(isOpen), onclick: function () { if (openDish[r.id]) delete openDish[r.id]; else openDish[r.id] = true; renderCook(); } }, r.name);
    var body = h("div", { class: "dbody" },
      h("div", { class: "dishhead" }, title, labelsEl(r)),
      boltEl(r.effort), clockEl(r.minutes));
    if (isOpen) {
      body.append(
        h("div", { class: "dcount" }, ings.length + (ings.length === 1 ? " Zutat" : " Zutaten") + (nExtra ? " + " + nExtra + " Extra" + (nExtra === 1 ? "" : "s") : "")),
        h("p", { class: "dings" }, ingLine(r) || "Noch keine Zutaten eingetragen."),
        h("button", { class: "linkbtn dedit", type: "button", onclick: function () { openEditor(r); } }, "Bearbeiten"));
    }
    return h("li", { class: "dish" + (on ? " on" : "") }, pick, body);
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
      listedLunch: doc.listedLunch === true, listedDinner: doc.listedDinner === true,
      kindLunch: kindOk(doc.kindLunch), kindDinner: kindOk(doc.kindDinner)
    };
  }
  var SLOTS = ["lunch", "dinner"];
  var MARK_NAMES = { out: "Auswärts", snack: "Snack", prep: "Mealprep" };
  function kindOk(k) { return k === "snack" || k === "prep" ? k : "out"; }
  function capOf(slot) { return slot.charAt(0).toUpperCase() + slot.slice(1); }
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
      if (span === null || n >= today - (span - 1)) outN += (st0.outLunch && st0.kindLunch === "out" ? 1 : 0) + (st0.outDinner && st0.kindDinner === "out" ? 1 : 0);
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
    renderLabels();
    var box = $("cookmain");
    box.replaceChildren();
    if (recipes === null) { $("cookhead").textContent = "Kochbuch wird geladen …"; $("pickbar").hidden = true; return; }
    var statsOn = cookTab === "stats", labelsOn = false;
    $("cookstats").hidden = !statsOn;
    $("labelsbox").hidden = statsOn || recipes === null;
    $("cookheadrow").hidden = statsOn || labelsOn;
    $("cooksearchrow").hidden = statsOn || labelsOn || !recipes.length;
    box.hidden = statsOn || labelsOn;
    Array.prototype.forEach.call($("cookseg").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === cookTab)); });
    if (statsOn) { $("pickbar").hidden = true; renderCookStats(); return; }
    if (labelsOn) { $("pickbar").hidden = true; renderLabels(); return; }
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
      var anyEff = recipes.some(function (r) { return Number(r.effort) >= 1; });
      if (anyTime || anyEff || labelDefs.length) {
        var fr = h("div", { class: "filters" });
        if (anyTime) fr.append(h("div", { class: "scrow" }, h("span", { class: "zl" }, "Zeit"), scaleInput("🕐", cookTm, "Zeit höchstens", function (n) { cookTm = n; renderCook(); }), h("span", { class: "hint" }, cookTm ? "bis " + TIME_CATS[cookTm - 1].short : "egal")));
        if (anyEff) fr.append(h("div", { class: "scrow" }, h("span", { class: "zl" }, "Aufwand"), scaleInput("⚡", cookEm, "Aufwand höchstens", function (n) { cookEm = n; renderCook(); }), h("span", { class: "hint" }, cookEm ? "höchstens " + EFFORT_NAMES[cookEm] : "egal")));
        if (labelDefs.length) {
          var lc = h("span", { class: "lchips", role: "group", "aria-label": "Label, mindestens eines" });
          labelDefs.forEach(function (l) {
            lc.append(lblChip(l, lblState({ l: cookL, x: cookX }, l.id), function () { var f = { l: cookL, x: cookX }; lblStep(f, l.id); cookL = f.l; cookX = f.x; renderCook(); }));
          });
          fr.append(h("div", { class: "scrow" }, h("span", { class: "zl" }, "Label"), lc, h("span", { class: "hint" }, lblHint({ l: cookL, x: cookX }))));
        }
        box.append(fr);
      }
      var cl = cookL.filter(function (id) { return labelDefs.some(function (l) { return l.id === id; }); });
      var q = cookQ.trim().toLowerCase();
      var list = recipes.filter(function (r) {
        var c = timeCat(r.minutes), e = Math.round(Number(r.effort)) || 0;
        if (!((!cookTm || (c >= 1 && c <= cookTm)) && (!cookEm || (e >= 1 && e <= cookEm)))) return false;
        if (!lblOk(r, cl, cookX)) return false;
        if (!q) return true;
        var hay = [r.name].concat((r.ingredients || []).map(function (g) { return g.name; }), labelsOf(r).map(function (l) { return l.name; })).join(" ").toLowerCase();
        return q.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
      });
      if (!list.length) box.append(h("div", { class: "empty" }, h("b", null, "Kein Gericht passt"), h("span", null, q ? "Zu „" + cookQ.trim() + "“ gibt es keinen Treffer. Ändere die Suche oder lockere die Filter." : "Lockere die Auswahl bei Zeit, Aufwand oder Label, oder tippe die Symbole wieder ab.")));
      var ul = h("ul", { class: "dishes" });
      list.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "de"); }).forEach(function (r) { ul.append(dishEl(r)); });
      box.append(ul);
    }
    var n = Object.keys(picked).length;
    $("pickbar").hidden = n === 0;
    $("pickcount").textContent = n === 1 ? "1 Gericht gewählt" : n + " Gerichte gewählt";
  }
  /* Labels: Emoji-Kennzeichen für Gerichte, gespeichert als besonderer Eintrag im Essensplan */
  var LABEL_IDEAS = [["🍔", "Fast Food"], ["🥗", "Healthy"], ["🌱", "Vegetarisch"], ["🥩", "Fleisch"], ["🐟", "Fisch"], ["🍝", "Pasta"], ["🍰", "Süß"], ["🌶️", "Scharf"], ["💰", "Günstig"], ["🎉", "Für Gäste"]];
  function labelDefsOwn() { return labelDefs.filter(function (l) { return l.id !== "_side"; }); }
  var SIDE_DEF = { id: "_side", emoji: "🥣", name: "Beilage" };
  function isSide(r) { return Array.isArray(r.labels) && r.labels.indexOf("_side") >= 0; }
  function saveLabels(list) {
    list = list.filter(function (l) { return l.id !== "_side"; });
    if (!db) { toast("Keine Verbindung zum Speicher. Bitte lade die Seite neu und melde dich an."); return Promise.resolve(); }
    labelDefs = list.concat([SIDE_DEF]); renderCook();
    return db.doc("plan/_labels").set({ list: list, at: Date.now() }).catch(writeFail);
  }
  function renderLabels() {
    var labelDefs = labelDefsOwn();
    var box = $("cooklabels");
    box.replaceChildren();
    var panel = h("div", { class: "panel" });
    if (!labelDefs.length) panel.append(h("p", { class: "noneyet" }, "Noch keine Labels. Tippe unten auf einen Vorschlag oder lege ein eigenes an."));
    labelDefs.forEach(function (l) {
      var nameIn = h("input", { type: "text", maxlength: "30", value: l.name, "aria-label": "Name des Labels " + l.emoji,
        onchange: function (e) { var v = e.target.value.trim(); if (!v) { e.target.value = l.name; return; } saveLabels(labelDefs.map(function (x) { return x.id === l.id ? { id: x.id, emoji: x.emoji, name: v } : x; })); } });
      var used = (recipes || []).filter(function (r) { return Array.isArray(r.labels) && r.labels.indexOf(l.id) >= 0; });
      var del = confirmLabelDel === l.id
        ? h("div", { class: "row" },
            h("button", { class: "linkbtn danger", type: "button", onclick: function () {
              confirmLabelDel = null;
              used.forEach(function (r) { db.doc("recipes/" + r.id).update({ labels: r.labels.filter(function (x) { return x !== l.id; }) }).catch(writeFail); });
              saveLabels(labelDefs.filter(function (x) { return x.id !== l.id; }));
            } }, "Ja, löschen" + (used.length ? " (bei " + used.length + (used.length === 1 ? " Gericht" : " Gerichten") + " entfernen)" : "")),
            h("button", { class: "linkbtn", type: "button", onclick: function () { confirmLabelDel = null; renderLabels(); } }, "Abbrechen"))
        : h("button", { class: "x", type: "button", "aria-label": "Label " + l.name + " löschen", onclick: function () { confirmLabelDel = l.id; renderLabels(); } }, "×");
      panel.append(h("div", { class: "labelrow" }, h("span", { class: "lemoji", "aria-hidden": "true" }, l.emoji), nameIn, del));
    });
    box.append(panel);
    if (labelDefs.length >= 20) { box.append(h("div", { class: "panel" }, h("p", { class: "hint" }, "Mehr als 20 Labels sind nicht möglich."))); return; }
    var emo = h("input", { type: "text", class: "emoin", maxlength: "8", value: newLabel.emoji, placeholder: "😀", "aria-label": "Emoji für das neue Label", oninput: function (e) { newLabel.emoji = e.target.value; } });
    var nm = h("input", { type: "text", maxlength: "30", value: newLabel.name, placeholder: "Name, z. B. Fast Food", "aria-label": "Name des neuen Labels", oninput: function (e) { newLabel.name = e.target.value; } });
    var add = function () {
      var em = newLabel.emoji.trim(), n = newLabel.name.trim();
      if (!em || !n) { toast("Ein Label braucht ein Emoji und einen Namen."); return; }
      if (labelDefs.some(function (l) { return l.emoji === em; })) { toast("Dieses Emoji ist schon vergeben."); return; }
      newLabel = { emoji: "", name: "" };
      saveLabels(labelDefs.concat([{ id: "l" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), emoji: em.slice(0, 8), name: n.slice(0, 30) }]));
    };
    nm.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); add(); } });
    var ideas = h("div", { class: "bought xchips" });
    LABEL_IDEAS.filter(function (x) { return !labelDefs.some(function (l) { return l.emoji === x[0]; }); }).forEach(function (x) {
      ideas.append(h("button", { class: "bchip", type: "button", onclick: function () { newLabel = { emoji: x[0], name: x[1] }; renderLabels(); } }, x[0] + " " + x[1]));
    });
    box.insertBefore(h("div", { class: "panel" }, h("h2", null, "Neues Label"),
      h("div", { class: "labelrow" }, emo, nm),
      h("div", { class: "row" }, h("button", { class: "primary", type: "button", onclick: add }, "Label anlegen")),
      ideas.children.length ? h("span", { class: "hint" }, "Vorschläge zum Antippen:") : null, ideas.children.length ? ideas : null), box.firstChild);
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
      byDay[ds].forEach(function (sl) { cur["listed" + capOf(sl)] = true; });
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
      draft = { id: r.id, labels: Array.isArray(r.labels) ? r.labels.slice() : [], name: r.name || "", at: r.at || 0, effort: Math.round(Number(r.effort)) || 0, minutes: Math.round(Number(r.minutes)) || 0, ings: (r.ingredients || []).map(function (g) { return { name: g.name || "", store: resolveStore(g.store), touched: true, k: kindOf(g) }; }) };
    } else {
      draft = { id: null, labels: [], name: "", at: 0, effort: 0, minutes: 0, ings: [] };
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
    var tc0 = timeCat(draft.minutes);
    var effIn = h("div", { class: "fl" }, h("span", null, "Aufwand"),
      h("div", { class: "scrow" }, scaleInput("⚡", draft.effort, "Aufwand", function (n) { draft.effort = n; renderEditor(); }), h("span", { class: "hint" }, draft.effort ? EFFORT_NAMES[draft.effort] : "keine Angabe")));
    var timeIn = h("div", { class: "fl" }, h("span", null, "Zubereitungszeit"),
      h("div", { class: "scrow" }, scaleInput("🕐", tc0, "Zeit", function (n) { draft.minutes = n ? TIME_CATS[n - 1].rep : 0; renderEditor(); }), h("span", { class: "hint" }, tc0 ? TIME_CATS[tc0 - 1].label : "keine Angabe")));
    var panel = h("div", { class: "panel" }, h("h2", null, draft.id ? "Gericht bearbeiten" : "Neues Gericht"), nameIn, effIn, timeIn);
    if (labelDefs.length) {
      var lc = h("div", { class: "bought xchips" });
      labelDefs.forEach(function (l) {
        var on = draft.labels.indexOf(l.id) >= 0;
        lc.append(h("button", { class: "bchip" + (on ? " sel" : ""), type: "button", "aria-pressed": String(on), onclick: function () {
          draft.labels = on ? draft.labels.filter(function (x) { return x !== l.id; }) : draft.labels.concat([l.id]); renderEditor();
        } }, l.emoji + " " + l.name));
      });
      panel.append(h("div", { class: "fl" }, h("span", null, "Labels"), lc));
    } else panel.append(h("p", { class: "hint" }, "Tipp: Unter „Labels“ im Kochbuch kannst du Emoji-Labels wie 🍔 oder 🥗 anlegen."));
    panel.append(h("h2", null, "Zutaten und Laden"));
    draft.ings.forEach(function (g, idx) {
      var sel = h("select", { "aria-label": "Laden für Zutat " + (idx + 1), onchange: function (e) { g.store = e.target.value; g.touched = true; } });
      storeList.forEach(function (s) { sel.append(h("option", { value: s.id, selected: s.id === g.store }, s.name)); });
      var sug = h("div", { class: "sugg", role: "listbox", "aria-label": "Vorschläge" });
      var showSug = function () {
        sug.replaceChildren();
        var list = ingSuggest(g.name);
        list.forEach(function (c) {
          sug.append(h("button", { class: "bchip", type: "button", role: "option", onmousedown: function (e) { e.preventDefault(); }, onclick: function () {
            var raw = String(g.name), i = raw.toLowerCase().lastIndexOf(parseItem(raw).name.toLowerCase());
            g.name = (i > 0 ? raw.slice(0, i) : "") + c.name; nm.value = g.name;
            if (c.store && !g.touched) { g.store = resolveStore(c.store); sel.value = g.store; }
            sug.replaceChildren();
          } }, c.name));
        });
      };
      var nm = h("input", { class: "ingname", type: "text", maxlength: "80", placeholder: "z. B. 500 g Hackfleisch", "aria-label": "Zutat " + (idx + 1), value: g.name, autocomplete: "off",
        oninput: function (e) { g.name = e.target.value; showSug(); },
        onfocus: function () { showSug(); },
        onblur: function () { setTimeout(function () { sug.replaceChildren(); }, 200); },
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
      panel.append(h("div", { class: "ingwrap" }, h("div", { class: "ingrow" }, nm, sel, rm), sug, ksel));
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
    rememberIngs(ings);
    var mins = Math.round(Number(draft.minutes)) || 0;
    if (mins < 0 || mins > 1440) { toast("Die Dauer sollte zwischen 1 und 1440 Minuten liegen."); return; }
    var eff = Math.round(Number(draft.effort)) || 0;
    var lbl = (draft.labels || []).filter(function (id) { return labelDefs.some(function (l) { return l.id === id; }); });
    if (draft.id) p = db.doc("recipes/" + draft.id).update({ name: name, ingredients: ings, example: false, effort: eff, minutes: mins, labels: lbl });
    else p = db.collection("recipes").add({ name: name, ingredients: ings, at: Date.now(), effort: eff, minutes: mins, labels: lbl });
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
      : db.doc("plan/" + ds).set({ date: ds, lunch: st.lunch, dinner: st.dinner, outLunch: st.outLunch, noteLunch: st.noteLunch, outDinner: st.outDinner, noteDinner: st.noteDinner, listedLunch: st.listedLunch === true, listedDinner: st.listedDinner === true, kindLunch: st.outLunch ? st.kindLunch : "out", kindDinner: st.outDinner ? st.kindDinner : "out", at: Date.now() });
    p.catch(writeFail);
  }
  var SLOT_NAMES = { lunch: "Mittagessen", dinner: "Abendessen", snack: "Snack", prep: "Mealprep" };
  function slotEl(ds, slot) {
    var Cap = capOf(slot);
    var st = slotsOf(plan[ds]);
    var dishes = st[slot], out = st["out" + Cap];
    var key = ds + "|" + slot;
    var menuOpen = !!pickDay && String(pickDay).indexOf(key + "|") === 0;
    var box = h("div", { class: "slot" });
    var plus = h("button", { class: "slotplus" + (menuOpen ? " on" : ""), type: "button", "aria-expanded": String(menuOpen), "aria-label": SLOT_NAMES[slot] + ": Optionen zum Hinzufügen", onclick: function () { pickDay = menuOpen ? null : key + "|menu"; renderMeal(); } }, menuOpen ? "×" : "+");
    var chips = h("div", { class: "mealchips" });
    if (out) {
      var note = st["note" + Cap];
      var kn = MARK_NAMES[st["kind" + Cap]] || "Auswärts";
      chips.append(h("span", { class: "meal out" }, kn + (note ? ": " + note : ""),
        h("button", { class: "x", type: "button", "aria-label": SLOT_NAMES[slot] + ": " + kn + " entfernen", onclick: function () {
          var cur = slotsOf(plan[ds]); cur["out" + Cap] = false; cur["note" + Cap] = ""; saveDay(ds, cur);
        } }, "×")));
    }
    dishes.forEach(function (d, idx) {
      var rec = (recipes || []).filter(function (r) { return r.id === d.id; })[0];
      var nm = rec ? rec.name : d.name;
      var who = d.who === "F" || d.who === "C" ? d.who : "";
      var whoBtn = h("button", { class: "whob" + (who ? " w" + who : ""), type: "button",
        "aria-label": nm + ": " + (who ? "nur " + who : "für beide") + ". Tippen zum Ändern", title: who ? "Nur " + who : "Für beide (tippen: F, C, beide)",
        onclick: function () {
          var nx = who === "" ? "F" : who === "F" ? "C" : "";
          var cur = slotsOf(plan[ds]);
          cur[slot] = cur[slot].map(function (x, j) { if (j !== idx) return x; var y = Object.assign({}, x); if (nx) y.who = nx; else delete y.who; return y; });
          saveDay(ds, cur);
          plan[ds] = Object.assign({}, plan[ds] || {}, { lunch: cur.lunch, dinner: cur.dinner });
          renderMeal();
        } }, who || "F·C");
      chips.append(h("span", { class: "meal" + (d.side ? " side" : "") + (who ? " by" + who : "") }, whoBtn, (d.side ? "+ " : "") + nm, miniScales(rec),
        h("button", { class: "x", type: "button", "aria-label": nm + " aus dem Plan nehmen", onclick: function () {
          var cur = slotsOf(plan[ds]); cur[slot] = cur[slot].filter(function (_, j) { return j !== idx; }); saveDay(ds, cur);
        } }, "×")));
    });
    if (!chips.children.length) chips.append(h("span", { class: "noneyet" }, "Noch nichts geplant"));
    box.append(h("div", { class: "srow" }, h("span", { class: "slbl", title: SLOT_NAMES[slot] }, slot === "lunch" ? "M:" : "A:"), chips, plus));

    if (pickDay === key + "|dish") {
      var sf = getSF(ds, slot);
      if (!(recipes || []).length) box.append(h("p", { class: "noneyet" }, "Lege zuerst im Kochbuch ein Gericht an."));
      else {
        var qIn = h("input", { type: "search", maxlength: "60", autocomplete: "off", placeholder: "Gericht suchen …", "aria-label": "Gericht suchen", value: pickF.q });
        var pk = h("div", { class: "picker" });
        var fill = function () {
          pk.replaceChildren();
          var q = pickF.q.trim().toLowerCase(), ls = sf.l.filter(function (id) { return labelDefs.some(function (l) { return l.id === id; }); });
          var res = (recipes || []).filter(function (r) {
            var c = timeCat(r.minutes), e = Math.round(Number(r.effort)) || 0;
            if (sf.tm && !(c >= 1 && c <= sf.tm)) return false;
            if (sf.em && !(e >= 1 && e <= sf.em)) return false;
            if (isSide(r) && ls.indexOf("_side") < 0) return false;
            if (!lblOk(r, ls, sf.x)) return false;
            if (!q) return true;
            var hay = [r.name].concat((r.ingredients || []).map(function (g) { return g.name; }), labelsOf(r).map(function (l) { return l.name; })).join(" ").toLowerCase();
            return q.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
          }).sort(function (x, y) { return String(x.name).localeCompare(String(y.name), "de"); });
          if (!res.length) pk.append(h("p", { class: "noneyet" }, "Kein Gericht passt. Ändere die Suche oder lockere die Filter."));
          res.forEach(function (r) {
            var em = labelsOf(r).map(function (l) { return l.emoji; }).join("");
            pk.append(h("button", { class: "bchip", type: "button", onclick: function () {
              pickDay = null;
              var cur = slotsOf(plan[ds]);
              if (cur[slot].some(function (d) { return d.id === r.id; })) { renderMeal(); return; }
              cur[slot] = cur[slot].concat([{ id: r.id, name: r.name }]);
              cur["out" + Cap] = false; cur["note" + Cap] = ""; cur["listed" + Cap] = false;
              saveDay(ds, cur);
              renderMeal();
            } }, r.name + (em ? " " + em : "")));
          });
        };
        qIn.addEventListener("input", function (e) { pickF.q = e.target.value; fill(); });
        var nAct = (sf.tm ? 1 : 0) + (sf.em ? 1 : 0) + sf.l.length + sf.x.length;
        box.append(h("div", { class: "searchrow" }, qIn,
          h("button", { class: "linkbtn fbtn" + (pickFOpen || nAct ? " on" : ""), type: "button", "aria-expanded": String(pickFOpen), "aria-label": "Filter für Zeit, Aufwand und Label", onclick: function () { pickFOpen = !pickFOpen; renderMeal(); } }, "⚙ Filter" + (nAct ? " · " + nAct : ""))));
        var fr = h("div", { class: "filters" });
        fr.append(h("div", { class: "scrow" }, h("span", { class: "zl" }, "Zeit"), scaleInput("🕐", sf.tm, "Zeit höchstens", function (n) { sf.tm = n; setSF(ds, slot, sf); renderMeal(); }), h("span", { class: "hint" }, sf.tm ? "bis " + TIME_CATS[sf.tm - 1].short : "egal")));
        fr.append(h("div", { class: "scrow" }, h("span", { class: "zl" }, "Aufwand"), scaleInput("⚡", sf.em, "Aufwand höchstens", function (n) { sf.em = n; setSF(ds, slot, sf); renderMeal(); }), h("span", { class: "hint" }, sf.em ? "höchstens " + EFFORT_NAMES[sf.em] : "egal")));
        if (labelDefs.length) {
          var lc = h("span", { class: "lchips", role: "group", "aria-label": "Label, mindestens eines" });
          labelDefs.forEach(function (l) {
            lc.append(lblChip(l, lblState(sf, l.id), function () { lblStep(sf, l.id); setSF(ds, slot, sf); renderMeal(); }));
          });
          fr.append(h("div", { class: "scrow" }, h("span", { class: "zl" }, "Label"), lc, h("span", { class: "hint" }, lblHint(sf))));
        }
        if (pickFOpen) box.append(fr);
        box.append(pk);
        fill();
      }
    }
    if (pickDay === key + "|side") {
      var sides = (recipes || []).filter(isSide);
      if (!sides.length) box.append(h("p", { class: "noneyet" }, "Noch keine Beilagen. Gib im Kochbuch einem Gericht das Label „🥣 Beilage“."));
      else {
        var sIn = h("input", { type: "search", maxlength: "60", autocomplete: "off", placeholder: "Beilage suchen …", "aria-label": "Beilage suchen", value: pickF.q });
        var sk = h("div", { class: "picker" });
        var sFill = function () {
          sk.replaceChildren();
          var q = pickF.q.trim().toLowerCase();
          var res = sides.filter(function (r) { return !q || String(r.name).toLowerCase().indexOf(q) >= 0; }).sort(function (x, y) { return String(x.name).localeCompare(String(y.name), "de"); });
          if (!res.length) sk.append(h("p", { class: "noneyet" }, "Keine Beilage passt zur Suche."));
          res.forEach(function (r) {
            sk.append(h("button", { class: "bchip", type: "button", onclick: function () {
              pickDay = null;
              var cur = slotsOf(plan[ds]);
              if (cur[slot].some(function (x) { return x.id === r.id; })) { renderMeal(); return; }
              cur[slot] = cur[slot].concat([{ id: r.id, name: r.name, side: true }]);
              cur["out" + Cap] = false; cur["note" + Cap] = ""; cur["listed" + Cap] = false;
              saveDay(ds, cur); renderMeal();
            } }, r.name));
          });
        };
        sIn.addEventListener("input", function (e) { pickF.q = e.target.value; sFill(); });
        box.append(h("div", { class: "searchrow" }, sIn), sk);
        sFill();
      }
    }
    var mk = ["out"].filter(function (k) { return pickDay === key + "|" + k; })[0];
    if (mk) {
      var ph = { out: "Wo? z. B. bei Oma (kann leer bleiben)", snack: "Was? z. B. Obst (kann leer bleiben)", prep: "Was wird vorbereitet? (kann leer bleiben)" }[mk];
      var inp = h("input", { type: "text", maxlength: "60", placeholder: ph, "aria-label": "Notiz zu " + MARK_NAMES[mk] });
      var go = function () {
        var cur = slotsOf(plan[ds]);
        cur[slot] = []; cur["out" + Cap] = true; cur["kind" + Cap] = mk; cur["note" + Cap] = inp.value.trim(); cur["listed" + Cap] = false;
        pickDay = null; saveDay(ds, cur); renderMeal();
      };
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } });
      box.append(h("div", { class: "outform" }, inp,
        h("button", { class: "primary", type: "button", onclick: go }, "Speichern")));
    }
    if (pickDay === key + "|dice") box.append(diceEl(ds, slot, key));
    var acts = h("div", { class: "slotact" });
    var open1 = pickDay === key + "|dish", open3 = pickDay === key + "|dice";
    acts.append(h("button", { class: "linkbtn", type: "button", onclick: function () { pickDay = open1 ? null : key + "|dish"; renderMeal(); } }, open1 ? "Schließen" : "+ Gericht"));
    var open4 = pickDay === key + "|side";
    acts.append(h("button", { class: "linkbtn", type: "button", onclick: function () { pickDay = open4 ? null : key + "|side"; renderMeal(); } }, open4 ? "Schließen" : "+ Beilage"));
    acts.append(h("button", { class: "linkbtn", type: "button", "aria-label": SLOT_NAMES[slot] + " auswürfeln", onclick: function () { pickDay = open3 ? null : key + "|dice"; renderMeal(); } }, open3 ? "Schließen" : "🎲"));
    if (!out) ["out"].forEach(function (k) {
      var o = pickDay === key + "|" + k;
      acts.append(h("button", { class: "linkbtn", type: "button", onclick: function () { pickDay = o ? null : key + "|" + k; renderMeal(); } }, o ? "Schließen" : MARK_NAMES[k]));
    });
    if (menuOpen) box.append(acts);
    return box;
  }
  /* Essensplan: Würfel */
  var diceState = {};
  /* Gemerkte Filter je Wochentag und Mahlzeit (gelten für alle kommenden Wochen) */
  var slotFilters = {}, weekRoll = {}, weekRollFor = null;
  function sfKey(ds, slot) { return ((dn(ds) + 3) % 7) + "|" + slot; }
  function getSF(ds, slot) {
    var f0 = slotFilters[sfKey(ds, slot)], f = f0 || {};
    return { on: !!f0 && f0.on !== false, tm: Number(f.tm) || 0, em: Number(f.em) || 0, l: Array.isArray(f.l) ? f.l.filter(function (x) { return labelDefs.some(function (l) { return l.id === x; }); }) : [], x: Array.isArray(f.x) ? f.x.filter(function (x) { return labelDefs.some(function (l) { return l.id === x; }); }) : [] };
  }
  function sfActive(f) { return !!(f.tm || f.em || f.l.length || (f.x && f.x.length)); }
  function setSF(ds, slot, f) {
    var k = sfKey(ds, slot);
    var prev = slotFilters[k], on = f.on === undefined ? (!!prev && prev.on !== false) : !!f.on;
    if (!prev && sfActive(f)) on = true;
    if (on || sfActive(f)) slotFilters[k] = { on: on, tm: f.tm, em: f.em, l: f.l.slice(), x: (f.x || []).slice() }; else delete slotFilters[k];
    if (!db) return;
    db.doc("plan/_filters").set({ map: slotFilters, at: Date.now() }).catch(writeFail);
  }
  function commitDish(ds, slot, r) {
    var Cap = capOf(slot), cur = slotsOf(plan[ds]);
    if (cur[slot].some(function (x) { return x.id === r.id; })) return;
    cur[slot] = cur[slot].concat([{ id: r.id, name: r.name }]); cur["out" + Cap] = false; cur["note" + Cap] = ""; cur["listed" + Cap] = false;
    saveDay(ds, cur);
    plan[ds] = Object.assign({}, plan[ds] || {}, { date: ds, lunch: cur.lunch, dinner: cur.dinner, outLunch: cur.outLunch, outDinner: cur.outDinner });
  }
  /* Ganze Woche würfeln: für alle freien Mahlzeiten mit gemerkten Filtern */
  function rollTargets(mon, today) {
    var out = [];
    for (var i = 0; i < 7; i++) {
      var n = mon + i, ds = dnToStr(n);
      if (n < today) continue;
      var st = slotsOf(plan[ds]);
      SLOTS.forEach(function (sl) {
        if (st[sl].length || st["out" + capOf(sl)]) return;
        if (getSF(ds, sl).on) out.push({ ds: ds, slot: sl, key: ds + "|" + sl });
      });
    }
    return out;
  }
  function rollWeek(targets, keep) {
    var used = {};
    var mon = weekStart(dn(targets[0] ? targets[0].ds : todayStr()));
    for (var i = 0; i < 7; i++) allDishes(plan[dnToStr(mon + i)]).forEach(function (x) { used[x.id] = true; });
    Object.keys(weekRoll).forEach(function (k) { if (weekRoll[k] && weekRoll[k].id && keep[k]) used[weekRoll[k].id] = true; });
    targets.forEach(function (t) {
      if (keep[t.key]) return;
      var f = getSF(t.ds, t.slot), prev = weekRoll[t.key] && weekRoll[t.key].id;
      var all = dicePool({ tm: f.tm, e: f.em, l: f.l, x: f.x }, {}).all;
      var pool = all.filter(function (r) { return !used[r.id] && r.id !== prev; });
      if (!pool.length) pool = all.filter(function (r) { return !used[r.id]; });
      if (!pool.length) pool = all.filter(function (r) { return r.id !== prev; });
      var pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : (all[0] || null);
      weekRoll[t.key] = pick ? { id: pick.id } : { id: null };
      if (pick) used[pick.id] = true;
    });
  }
  var planOpen = false, planEdit = null;
  function sfSummary(f) {
    var ls = labelDefs.filter(function (l) { return f.l.indexOf(l.id) >= 0; }).map(function (l) { return l.emoji; }).join("");
    var xs = labelDefs.filter(function (l) { return (f.x || []).indexOf(l.id) >= 0; }).map(function (l) { return l.emoji; }).join("");
    var t = (f.em ? "⚡" + f.em + " " : "") + (f.tm ? "🕐" + f.tm + " " : "") + ls + (xs ? " 🚫" + xs : "");
    return t.trim() || "beliebig";
  }
  function planEditor(ds, slot) {
    var f = getSF(ds, slot), box = h("div", { class: "filters planfilters" });
    var put = function () { setSF(ds, slot, f); renderMeal(); };
    box.append(h("div", { class: "scrow" }, h("span", { class: "zl" }, "Aufwand"), scaleInput("⚡", f.em, "Aufwand höchstens", function (n) { f.em = n; put(); })));
    box.append(h("div", { class: "scrow" }, h("span", { class: "zl" }, "Zeit"), scaleInput("🕐", f.tm, "Zeit höchstens", function (n) { f.tm = n; put(); })));
    if (labelDefs.length) {
      var lc = h("span", { class: "lchips", role: "group", "aria-label": "Label, mindestens eines" });
      labelDefs.forEach(function (l) {
        lc.append(lblChip(l, lblState(f, l.id), function () { lblStep(f, l.id); put(); }));
      });
      box.append(h("div", { class: "scrow" }, h("span", { class: "zl" }, "Label"), lc, h("span", { class: "hint" }, lblHint(f))));
    }
    return box;
  }
  function planConfigEl(mon, today) {
    var wrap = h("div", { class: "planconf" });
    var setDays = function (wds) {
      var ref = dnToStr(mon);
      for (var i = 0; i < 7; i++) {
        var ds = dnToStr(mon + i), on = wds.indexOf(i) >= 0;
        SLOTS.forEach(function (sl) { var f = getSF(ds, sl); f.on = on; setSF(ds, sl, f); });
      }
      renderMeal();
    };
    wrap.append(h("div", { class: "bought" },
      h("button", { class: "bchip", type: "button", onclick: function () { setDays([0, 1, 2, 3, 4, 5, 6]); } }, "Alle 7 Tage"),
      h("button", { class: "bchip", type: "button", onclick: function () { setDays([0, 1, 2, 3, 4]); } }, "Mo–Fr"),
      h("button", { class: "bchip", type: "button", onclick: function () { setDays([]); } }, "Keine")));
    for (var i = 0; i < 7; i++) (function (n) {
      var ds = dnToStr(n), fl = getSF(ds, "lunch"), fd = getSF(ds, "dinner"), dayOn = fl.on || fd.on;
      var card = h("div", { class: "plancard" + (dayOn ? " on" : "") + (n < today ? " past" : "") });
      var chk = h("button", { class: "pchk" + (dayOn ? " on" : ""), type: "button", role: "checkbox", "aria-checked": String(dayOn), "aria-label": WD[(n + 3) % 7] + " einplanen", onclick: function () {
        SLOTS.forEach(function (sl) { var f = getSF(ds, sl); f.on = !dayOn; setSF(ds, sl, f); }); renderMeal();
      } }, dayOn ? "✓" : "");
      var head = h("div", { class: "planhead" }, chk, h("b", null, WD[(n + 3) % 7] + " " + dayLabel(n)));
      var pills = h("span", { class: "planpills" });
      [["lunch", "Mittag", fl], ["dinner", "Abend", fd]].forEach(function (x) {
        pills.append(h("button", { class: "ppill" + (x[2].on ? " on" : ""), type: "button", "aria-pressed": String(x[2].on), onclick: function () { var f = getSF(ds, x[0]); f.on = !f.on; setSF(ds, x[0], f); renderMeal(); } }, x[1]));
      });
      head.append(pills);
      card.append(head);
      if (dayOn) {
        var crit = h("div", { class: "plancrit" });
        [["lunch", "M", fl], ["dinner", "A", fd]].forEach(function (x) {
          if (!x[2].on) return;
          var id = ds + "|" + x[0], open = planEdit === id;
          crit.append(h("button", { class: "linkbtn pcbtn" + (open ? " on" : ""), type: "button", "aria-expanded": String(open), onclick: function () { planEdit = open ? null : id; renderMeal(); } }, x[1] + ": " + sfSummary(x[2])));
        });
        card.append(crit);
        [["lunch", fl], ["dinner", fd]].forEach(function (x) { if (x[1].on && planEdit === ds + "|" + x[0]) card.append(planEditor(ds, x[0])); });
      }
      wrap.append(card);
    })(mon + i);
    return wrap;
  }
  function weekRollEl(mon, today) {
    if (mon + 6 < today) { $("mealtools").replaceChildren(); return null; }
    var targets = rollTargets(mon, today);
    if (weekRollFor !== mon) { weekRoll = {}; weekRollFor = mon; }
    Object.keys(weekRoll).forEach(function (k) { if (!targets.some(function (t) { return t.key === k; })) delete weekRoll[k]; });
    var props = targets.filter(function (t) { return weekRoll[t.key]; });
    var tools = $("mealtools"); tools.replaceChildren();
    tools.append(h("button", { class: "plantitle", type: "button", "aria-expanded": String(planOpen), onclick: function () { planOpen = !planOpen; renderMeal(); } }, "Woche planen", h("span", { class: "chev", "aria-hidden": "true" }, planOpen ? "▾" : "▸")));
    if (!props.length && targets.length) tools.append(h("button", { class: "dicebtn", type: "button", "aria-label": "Woche auswürfeln", title: "Woche auswürfeln", onclick: function () { rollWeek(targets, {}); renderMeal(); } }, "🎲"));
    var wrap = h("div", { class: "panel weekroll" });
    if (!props.length) {
      if (!planOpen) return null;
      wrap.append(planConfigEl(mon, today));
      return wrap;
    }
    var rows = h("div", { class: "wrrows" });
    props.forEach(function (t) {
      var r = (recipes || []).filter(function (x) { return x.id === weekRoll[t.key].id; })[0];
      rows.append(h("div", { class: "wrrow" },
        h("span", { class: "wrwhen" }, WD[(dn(t.ds) + 3) % 7] + " " + (t.slot === "lunch" ? "Mittag" : "Abend")),
        h("span", { class: "wrname" }, r ? r.name : "Nichts passt", r ? labelsEl(r) : null),
        r ? h("button", { class: "linkbtn wrok", type: "button", "aria-label": "Übernehmen: " + r.name, onclick: function () { commitDish(t.ds, t.slot, r); delete weekRoll[t.key]; renderMeal(); } }, "✓") : null,
        h("button", { class: "linkbtn", type: "button", "aria-label": "Neu würfeln", onclick: function () { var keep = {}; targets.forEach(function (x) { if (x.key !== t.key) keep[x.key] = true; }); rollWeek(targets, keep); renderMeal(); } }, "🎲")));
    });
    wrap.append(rows, h("div", { class: "row" },
      h("button", { class: "primary", type: "button", onclick: function () {
        props.forEach(function (t) { var r = (recipes || []).filter(function (x) { return x.id === weekRoll[t.key].id; })[0]; if (r) commitDish(t.ds, t.slot, r); });
        weekRoll = {}; renderMeal();
      } }, "Alle übernehmen"),
      h("button", { class: "linkbtn", type: "button", onclick: function () { rollWeek(targets, {}); renderMeal(); } }, "🎲 Alle neu"),
      h("button", { class: "linkbtn", type: "button", onclick: function () { weekRoll = {}; renderMeal(); } }, "Verwerfen")));
    return wrap;
  }
  function diceInit(key, slot, ds) {
    var d = diceState[key] = diceState[key] || { cur: null, seen: [] };
    var f = getSF(ds, slot);
    d.tm = f.tm; d.e = f.em; d.l = f.l; d.x = f.x;
    return d;
  }
  /* Label-Filter mit drei Zuständen: aus -> muss (grün) -> ausgeschlossen (rot) */
  function lblState(f, id) { return f.l.indexOf(id) >= 0 ? 1 : (f.x || []).indexOf(id) >= 0 ? 2 : 0; }
  function lblStep(f, id) {
    var st = lblState(f, id);
    f.l = f.l.filter(function (v) { return v !== id; }); f.x = (f.x || []).filter(function (v) { return v !== id; });
    if (st === 0) f.l.push(id); else if (st === 1) f.x.push(id);
  }
  function lblOk(r, l, x) {
    var rl = Array.isArray(r.labels) ? r.labels : [];
    if (x && x.length && x.some(function (id) { return rl.indexOf(id) >= 0; })) return false;
    if (l.length && !l.some(function (id) { return rl.indexOf(id) >= 0; })) return false;
    return true;
  }
  function lblChip(l, st, onclick) {
    return h("button", { class: "lchip" + (st === 1 ? " on" : st === 2 ? " ex" : ""), type: "button", "aria-pressed": st ? "true" : "false",
      "aria-label": l.name + (st === 1 ? " (muss dabei sein)" : st === 2 ? " (ausgeschlossen)" : ""), title: l.name + (st === 2 ? " – ausgeschlossen" : ""), onclick: onclick }, l.emoji);
  }
  function lblHint(f) {
    var inc = labelDefs.filter(function (l) { return f.l.indexOf(l.id) >= 0; }).map(function (l) { return l.name; }).join(" oder ");
    var exc = labelDefs.filter(function (l) { return (f.x || []).indexOf(l.id) >= 0; }).map(function (l) { return l.name; }).join(", ");
    return (inc || exc) ? (inc + (inc && exc ? " · " : "") + (exc ? "ohne " + exc : "")) : "egal (2× tippen = ausschließen)";
  }
  function dicePool(d, plannedWeek) {
    var all = (recipes || []).filter(function (r) {
      if (d.tm && !(timeCat(r.minutes) >= 1 && timeCat(r.minutes) <= d.tm)) return false;
      if (d.e && !(Number(r.effort) >= 1 && Number(r.effort) <= d.e)) return false;
      var dl = d.l.filter(function (id) { return labelDefs.some(function (l) { return l.id === id; }); });
      if (isSide(r) && dl.indexOf("_side") < 0) return false;
      return lblOk(r, dl, d.x || []);
    });
    var fresh = all.filter(function (r) { return !plannedWeek[r.id]; });
    return { all: all, fresh: fresh.length ? fresh : all };
  }
  function diceRoll(ds, slot, key) {
    var d = diceInit(key, slot, ds);
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
    var Cap = capOf(slot);
    var d = diceInit(key, slot, ds);
    var save = function () { setSF(ds, slot, { tm: d.tm, em: d.e, l: d.l, x: d.x }); d.cur = null; d.seen = []; renderMeal(); };
    var tSel = h("div", { class: "scrow" }, h("span", { class: "zl" }, "Schnell"),
      scaleInput("🕐", d.tm, "Zeit höchstens", function (n) { d.tm = n; save(); }),
      h("span", { class: "hint" }, d.tm ? "bis " + TIME_CATS[d.tm - 1].short : "egal"));
    var eSel = h("div", { class: "scrow" }, h("span", { class: "zl" }, "Aufwand"),
      scaleInput("⚡", d.e, "Aufwand höchstens", function (n) { d.e = n; save(); }),
      h("span", { class: "hint" }, d.e ? "höchstens " + EFFORT_NAMES[d.e] : "egal"));
    var lSel = null;
    if (labelDefs.length) {
      lSel = h("div", { class: "scrow" }, h("span", { class: "zl" }, "Label"));
      var lchips = h("span", { class: "lchips", role: "group", "aria-label": "Label, mindestens eines" });
      labelDefs.forEach(function (l) {
        lchips.append(lblChip(l, lblState(d, l.id), function () { lblStep(d, l.id); save(); }));
      });
      lSel.append(lchips, h("span", { class: "hint" }, lblHint(d)));
    }
    var week = {};
    var mon = weekStart(dn(ds));
    for (var j = 0; j < 7; j++) allDishes(plan[dnToStr(mon + j)]).forEach(function (x) { week[x.id] = true; });
    var info = dicePool(d, week), cur = (recipes || []).filter(function (r) { return r.id === d.cur; })[0];
    var unknown = (d.tm || d.e || d.l.length || d.x.length) ? (recipes || []).filter(function (r) { return !(Number(r.minutes) >= 1) && !(Number(r.effort) >= 1); }).length : 0;
    var box = h("div", { class: "dice" },
      tSel, eSel, lSel);
    if (!info.all.length) {
      box.append(h("p", { class: "noneyet" }, (d.tm || d.e || d.l.length || d.x.length) ? "Kein Gericht passt zu diesen Wünschen. Ergänze im Kochbuch Aufwand, Dauer oder Labels oder lockere die Auswahl." : "Lege zuerst im Kochbuch ein Gericht an."));
    } else {
      if (cur) {
        var taken = slotsOf(plan[ds])[slot].some(function (x) { return x.id === cur.id; });
        box.append(h("div", { class: "dicecard" },
          h("div", { class: "dname" }, cur.name, labelsEl(cur)),
          boltEl(cur.effort), clockEl(cur.minutes),
          h("p", { class: "dings" }, ingLine(cur) || "Keine Zutaten eingetragen.")));
      }
      box.append(h("div", { class: "row" },
        cur && !taken ? h("button", { class: "primary", type: "button", onclick: function () {
          var c2 = slotsOf(plan[ds]);
          c2[slot] = c2[slot].concat([{ id: cur.id, name: cur.name }]); c2["out" + Cap] = false; c2["note" + Cap] = ""; c2["listed" + Cap] = false;
          pickDay = null; saveDay(ds, c2); renderMeal();
        } }, "Nehmen") : null,
        h("button", { class: cur ? "linkbtn" : "primary", type: "button", "aria-label": cur ? "Nochmal würfeln" : "Würfeln", onclick: function () { diceRoll(ds, slot, key); renderMeal(); } }, "🎲")));
      box.append(h("p", { class: "foot" }, info.all.length + (info.all.length === 1 ? " Gericht passt" : " Gerichte passen") + (info.fresh.length < info.all.length ? "" : "") + "." + (unknown ? " " + unknown + " ohne Angaben zu Aufwand und Dauer werden bei einem Filter nicht vorgeschlagen." : "")));
    }
    return box;
  }
  var mealOpen = {};
  function dayEl(n, ds, today) {
    var open = !!mealOpen[ds];
    var cls = "day nd" + (n === today ? " today" : "") + (n < today ? " past" : "") + (open ? "" : " folded");
    var head = h("div", { class: "dayhead", onclick: function () { if (open && pickDay && String(pickDay).indexOf(ds + "|") === 0) pickDay = null; mealOpen[ds] = !open; renderMeal(); } },
      h("span", { class: "dtitle" }, h("b", null, WD[(n + 3) % 7]), h("span", null, dayLabel(n))),
      h("button", { class: "dtog", type: "button", "aria-expanded": String(open), "aria-label": WD[(n + 3) % 7] + " " + dayLabel(n) + (open ? " zuklappen" : " aufklappen"), }, open ? "▾" : "▸"));
    if (!open) {
      var st = slotsOf(plan[ds]);
      var part = function (sl, tag) {
        var c = capOf(sl), row = h("span", null, tag + " ");
        if (!st[sl].length) { row.append(st["out" + c] ? "Auswärts" : "–"); return row; }
        st[sl].forEach(function (d, i) {
          var rec = (recipes || []).filter(function (r) { return r.id === d.id; })[0];
          row.append((i ? (d.side ? " + " : ", ") : "") + (rec ? rec.name : d.name));
          if (d.who === "F" || d.who === "C") row.append(" ", h("span", { class: "whob w" + d.who + " sm" }, d.who));
          var m = miniScales(rec); if (m) row.append(" ", m);
        });
        return row;
      };
      return h("div", { class: cls }, head, h("div", { class: "dmeals dsum" }, part("lunch", "M:"), part("dinner", "A:")));
    }
    return h("div", { class: cls }, head, h("div", { class: "dmeals" }, slotEl(ds, "lunch"), slotEl(ds, "dinner")));
  }
  var lastDishKey = null;
  function renderMeal() {
    var dk = /\|(dish|side)$/.test(String(pickDay)) ? pickDay : null;
    if (dk !== lastDishKey) { pickF.q = ""; lastDishKey = dk; }
    var box = $("mealdays");
    box.replaceChildren(); $("mealtools").replaceChildren();
    var mon = weekStart(dn(todayStr())) + weekOffset * 7;
    var today = dn(todayStr());
    $("weeklabel").textContent = (weekOffset === 0 ? "Diese Woche · " : "") + dayLabel(mon) + " – " + dayLabel(mon + 6);
    $("weektoday").hidden = weekOffset === 0;
    if (!planLoaded || recipes === null) { $("mealhead").textContent = "Essensplan wird geladen …"; $("mealshop").hidden = true; return; }
    var wr = weekRollEl(mon, today); if (wr) box.append(wr);
    var total = 0, outN = 0, ids = {}, pendSlots = [], allSlots = [], pendIds = {};
    for (var i = 0; i < 7; i++) {
      var n = mon + i, ds = dnToStr(n);
      var st = slotsOf(plan[ds]);
      var dishes = st.lunch.concat(st.dinner);
      total += dishes.length;
      outN += (st.outLunch && st.kindLunch === "out" ? 1 : 0) + (st.outDinner && st.kindDinner === "out" ? 1 : 0);
      dishes.forEach(function (d) { ids[d.id] = true; });
      if (n >= today) SLOTS.forEach(function (s0) { var sp = [s0, capOf(s0)];
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
  function repStep(e) {
    var n = Math.max(1, Math.min(999, Math.round(Number(e.repEvery)) || 1));
    return { d: e.repUnit === "d" ? n : e.repUnit === "w" ? 7 * n : 0, m: e.repUnit === "m" ? n : e.repUnit === "j" ? 12 * n : 0 };
  }
  function isRepeating(e) { return e && (e.repUnit === "d" || e.repUnit === "w" || e.repUnit === "m" || e.repUnit === "j"); }
  /* Startdatum der Wiederholung, die den Tag ds abdeckt (oder null) */
  function occCovering(e, ds) {
    var s0 = String(e.date), d0 = dn(s0), x = dn(ds), len = dn(evEndStr(e)) - d0, st = repStep(e);
    var until = e.repUntil ? String(e.repUntil) : "", skip = Array.isArray(e.repSkip) ? e.repSkip : [];
    if (x < d0) return null;
    var cands = [], j;
    if (st.d) {
      var k = Math.floor((x - d0) / st.d);
      for (j = k; j >= 0 && j >= k - Math.ceil(len / st.d) - 1; j--) cands.push(dnToStr(d0 + j * st.d));
    } else if (st.m) {
      var a = s0.split("-").map(Number), b = ds.split("-").map(Number), od = a[2];
      var md = (b[0] - a[0]) * 12 + (b[1] - a[1]), kk = Math.floor(md / st.m);
      for (j = kk; j >= 0 && j >= kk - 2; j--) cands.push(addMonthsStr(s0, j * st.m, od));
    }
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i], cn = dn(c);
      if (cn <= x && x <= cn + len && (!until || c <= until) && skip.indexOf(c) < 0) return c;
    }
    return null;
  }
  function eventsOn(ds) {
    var list = [];
    events.forEach(function (e) {
      if (!e.date) return;
      if (isRepeating(e)) {
        var s = occCovering(e, ds);
        if (s) {
          var len = dn(evEndStr(e)) - dn(String(e.date));
          list.push(Object.assign({}, e, { date: s, endDate: len > 0 ? dnToStr(dn(s) + len) : "", occDate: s, master: e }));
        }
      } else if (String(e.date) <= ds && ds <= evEndStr(e)) list.push(e);
    });
    return list.sort(function (a, b) {
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
    var next = null;
    for (var ni = 1; ni <= 366 && !next; ni++) {
      var nds = dnToStr(dn(t) + ni);
      next = eventsOn(nds).filter(function (e) { return String(e.date) === nds; })[0] || null;
    }
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
          var past = n < today, folded = past && !calOpen[ds];
          var card = h("div", { class: "wday" + (n === today ? " today" : "") + (past ? " past" : "") + (folded ? " folded" : "") });
          var head = h("div", { class: "whead" });
          if (past) head.append(h("button", { class: "wtog", type: "button", "aria-expanded": String(!folded), "aria-label": WDLONG[(n + 3) % 7] + " " + dayLabel(n) + (folded ? " aufklappen" : " zuklappen"), onclick: function () { if (calOpen[ds]) delete calOpen[ds]; else calOpen[ds] = true; renderCal(); } },
            h("b", null, WDLONG[(n + 3) % 7]), h("span", null, dayLabel(n)), h("span", { class: "chev", "aria-hidden": "true" }, folded ? "▸" : "▾")));
          else head.append(h("b", null, WDLONG[(n + 3) % 7]), h("span", null, dayLabel(n)));
          if (folded) head.append(h("span", { class: "wsum" }, evs.length ? evs.length + (evs.length === 1 ? " Termin" : " Termine") : "keine Termine"));
          else head.append(h("button", { class: "linkbtn", type: "button", onclick: function () { openEv(null, ds); } }, "+ Termin"));
          card.append(head);
          if (!folded) {
            if (!evs.length) card.append(h("p", { class: "noneyet" }, "Keine Termine"));
            else { var lst = h("div", { class: "evlist" }); evs.forEach(function (e) { lst.append(evRow(e)); }); card.append(lst); }
          }
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
      if (isRepeating(e)) {
        var fq = { d: "DAILY", w: "WEEKLY", m: "MONTHLY", j: "YEARLY" }[e.repUnit], rule = "FREQ=" + fq + ";INTERVAL=" + (Math.round(Number(e.repEvery)) || 1);
        if (e.repUntil) rule += ";UNTIL=" + String(e.repUntil).replace(/-/g, "") + (isAllDay(e) ? "" : "T235959");
        L.push("RRULE:" + rule);
        (Array.isArray(e.repSkip) ? e.repSkip : []).forEach(function (sk) {
          var sd = String(sk).replace(/-/g, "");
          L.push(isAllDay(e) ? "EXDATE;VALUE=DATE:" + sd : "EXDATE:" + sd + "T" + String(e.start).replace(":", "") + "00");
        });
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
    var occ = e && e.occDate ? e.occDate : "";
    if (e && e.master) e = e.master;
    evDraft = { id: e ? e.id : null, occ: occ, rep: !!(e && isRepeating(e)) }; confirmEvDel = false;
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
    var reps = !!(e && isRepeating(e));
    if (reps) {
      var en = Math.round(Number(e.repEvery)) || 1;
      $("evrep").value = en === 1 ? e.repUnit + "1" : "custom";
      $("evevery").value = String(en); $("evunit").value = e.repUnit;
    } else { $("evrep").value = ""; $("evevery").value = "2"; $("evunit").value = "w"; }
    $("evuntil").value = reps && e.repUntil ? String(e.repUntil) : "";
    $("evdel").hidden = !e; $("evdel").textContent = reps ? "Ganze Serie löschen" : "Termin löschen"; $("evdel").className = "linkbtn";
    $("evskip").hidden = !(reps && occ); $("evskip").textContent = "Nur den " + (occ ? fmt(occ) : "") + " überspringen";
    syncEvRep();
    syncEvAll();
    $("calmain").hidden = true; $("evform").hidden = false;
    try { window.scrollTo(0, 0); } catch (x) {}
    $("evtitle").focus();
  }
  function closeEv() { evDraft = null; confirmEvDel = false; $("evform").hidden = true; $("calmain").hidden = false; renderCal(); }
  function syncEvRep() {
    var v = $("evrep").value;
    $("evrepbox").hidden = !v;
    $("evcustom").hidden = v !== "custom"; $("evevery").disabled = v !== "custom";
  }
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
    else if (name === "bus") busRender();
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

    /* Bus-Rennen */
    if (busAll !== null) { try { box.append(busHomeCard()); } catch (e) {} }

    /* Essen */
    if (planLoaded && recipes !== null) {
      var st = slotsOf(plan[ts]);
      var line = function (name, dishes, out, note, kind) {
        var txt = out ? (MARK_NAMES[kind] || "Auswärts") + (note ? ": " + note : "") : dishes.length ? dishes.map(function (d) { var r = recipes.filter(function (x) { return x.id === d.id; })[0]; return r ? r.name : d.name; }).join(", ") : "noch nichts geplant";
        return h("div", { class: "mline" }, h("span", { class: "slabel" }, name), h("span", { class: dishes.length || out ? "mt" : "mt none" }, txt));
      };
      box.append(homeCard("Essen heute", "meal", [line("Mittagessen", st.lunch, st.outLunch, st.noteLunch, st.kindLunch), line("Abendessen", st.dinner, st.outDinner, st.noteDinner, st.kindDinner)], "Essensplan"));
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

  var spendOpen = false;
  function renderSpend() {
    var head = $("spendhead");
    var parts = ["budgetbar", "budgetform", "spendsum", "spendopen", "spendform", "spendlist", "spendcats"];
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
      $("spendform").hidden = true; $("spendopen").hidden = true; sum.hidden = true; lst.hidden = true; cats.hidden = true;
      return;
    }
    sum.hidden = false; lst.hidden = false; cats.hidden = false;
    $("spendform").hidden = !!budgetForm || !spendOpen;
    $("spendopen").hidden = !!budgetForm || spendOpen;

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
      lst.append(h("section", { class: "group" }, h("h2", null, "Ausgaben-Verlauf", h("span", { class: "n" }, String(mine.length))), ul));
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
    $("busview").hidden = section !== "bus";
    $("homeview").hidden = section !== "home";
    [["home", "tabhome"], ["putz", "tabputz"], ["shop", "tabshop"], ["meal", "tabmeal"], ["cal", "tabcal"], ["spend", "tabspend"], ["bus", "tabbus"]].forEach(function (p) {
      var b = $(p[1]);
      if (section === p[0] || (p[0] === "meal" && section === "cook")) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    var curTab = $(section === "cook" ? "tabmeal" : "tab" + section);
    if (curTab && $("h1name")) $("h1name").textContent = curTab.textContent;
    setMenu(false);
    if (section === "home") { try { renderHome(); } catch (e) {} }
  }
  /* Menü (Burger) auf- und zuklappen */
  function setMenu(open) {
    var nav = $("mainnav"), btn = $("menubtn");
    if (!nav || !btn) return;
    nav.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
    btn.classList.toggle("open", open);
  }
  $("menubtn").addEventListener("click", function (e) { e.stopPropagation(); setMenu($("mainnav").hidden); });
  document.addEventListener("click", function (e) { var nav = $("mainnav"); if (nav && !nav.hidden && !nav.contains(e.target) && !$("menubtn").contains(e.target)) setMenu(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("mainnav").hidden) { setMenu(false); $("menubtn").focus(); } });

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
  $("tabshop").addEventListener("click", function () { section = "shop"; lsSet("pp-section", "shop"); syncControls(); renderShop(); });
  $("tabbus").addEventListener("click", function () { goSection("bus"); });
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
  $("evrep").addEventListener("change", syncEvRep);
  $("evskip").addEventListener("click", function () {
    if (!evDraft || !evDraft.id || !evDraft.occ || !db) return;
    var cur = events.filter(function (x) { return x.id === evDraft.id; })[0];
    if (!cur) return;
    var skip = (Array.isArray(cur.repSkip) ? cur.repSkip : []).concat([evDraft.occ]).slice(-200);
    db.doc("events/" + evDraft.id).update({ repSkip: skip }).then(function () { closeEv(); toast("Dieser eine Termin entfällt, die Serie läuft weiter."); }).catch(writeFail);
  });
  $("evcancel").addEventListener("click", closeEv);
  $("evdel").addEventListener("click", function () {
    if (!evDraft || !evDraft.id || !db) return;
    if (!confirmEvDel) { confirmEvDel = true; $("evdel").textContent = evDraft.rep ? "Ja, alle löschen" : "Ja, Termin löschen"; $("evdel").className = "linkbtn danger"; return; }
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
    var rv = $("evrep").value, rUnit = "", rEvery = 0, rUntil = "";
    if (rv) {
      if (rv === "custom") {
        rEvery = Math.round(Number($("evevery").value)); rUnit = $("evunit").value;
        if (!(rEvery >= 1 && rEvery <= 999)) { toast("Bitte bei „Eigener Abstand“ eine Zahl von 1 bis 999 eingeben."); $("evevery").focus(); return; }
      } else { rUnit = rv.charAt(0); rEvery = 1; }
      if (["d", "w", "m", "j"].indexOf(rUnit) < 0) { rUnit = ""; rEvery = 0; }
      rUntil = $("evuntil").value || "";
      if (rUntil && rUntil < date) { toast("„Wiederholen bis“ liegt vor dem Startdatum."); return; }
    }
    var doc = { repUnit: rUnit, repEvery: rEvery, repUntil: rUntil, title: title, who: $("evwho").value, date: date, endDate: endDate && endDate !== date ? endDate : "", allDay: all, start: st, end: en, place: $("evplace").value.trim(), note: $("evnote").value.trim() };
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
  $("spendopen").addEventListener("click", function () { spendOpen = true; renderSpend(); $("samount").focus(); });
  $("spendclose").addEventListener("click", function () { spendOpen = false; renderSpend(); });
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
      spendOpen = false; renderSpend();
    }).catch(writeFail);
  });
  ["mealseg", "cookmealseg"].forEach(function (id) {
    $(id).addEventListener("click", function (e) {
      var v = e.target.getAttribute && e.target.getAttribute("data-go");
      if (v === "meal") { pickDay = null; goSection("meal"); } else if (v === "cook") goSection("cook");
    });
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
  $("cooksearch").addEventListener("input", function (e) { cookQ = e.target.value; renderCook(); });
  $("cooksearchclear").addEventListener("click", function () { cookQ = ""; $("cooksearch").value = ""; renderCook(); $("cooksearch").focus(); });
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
    updateQuick();
  });
  $("quickname").addEventListener("input", updateQuick);
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
      follow: Object.keys(newFollow).filter(function (k) { return newFollow[k]; }),
      assignee: who,
      turn: who === "abwechselnd" ? "F" : "",
      lastDone: days > 0 && $("newstart").value === "later" ? todayStr() : "",
      lastBy: "",
      countF: 0,
      countC: 0,
      createdAt: todayStr()
    };
    db.collection("tasks").add(doc).then(function () {
      $("newname").value = ""; $("newpoints").value = "1"; newFollow = {}; renderNewFollow();
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

  /* ---------- Bus-Rennen ---------- */
  var BZ_GOAL = 10, BZ_REPAIR = 10, BZ_DELTA = { bus: 1, flower: 2, wrong: -10 };
  var BZ_NAMES = { bus: "Bus gesehen", flower: "KölleBus", wrong: "Falsch gesehen (Platten)" };
  var BZ_COLORS = { bus: "#f2c300", flower: "#2e9e4f" };
  var busAll = null;                 // null = lädt noch; Einträge: t "ev" (Sichtung) oder "guest" (Gast für einen Tag)
  var busTab = lsGet("pp-bustab"); if (busTab !== "stats") busTab = "race";
  var busPeriod = lsGet("pp-busperiod"); if (busPeriod !== "7" && busPeriod !== "all") busPeriod = "30";
  var busLanes = {}, busShown = {}, busDay = "";

  function busSvg(fill, w, flower) {
    var win = '<rect x="4" y="5" width="7" height="6" rx="1" fill="#d6ecf8"/><rect x="13" y="5" width="7" height="6" rx="1" fill="#d6ecf8"/><rect x="22" y="5" width="7" height="6" rx="1" fill="#d6ecf8"/><path d="M31 5h5.2c1 0 1.8.8 1.8 1.8V11H31z" fill="#d6ecf8"/>';
    var fl = flower ? '<g transform="translate(13 14.5)"><circle cx="0" cy="-2" r="1.6" fill="#fff"/><circle cx="1.9" cy="-.6" r="1.6" fill="#fff"/><circle cx="1.2" cy="1.7" r="1.6" fill="#fff"/><circle cx="-1.2" cy="1.7" r="1.6" fill="#fff"/><circle cx="-1.9" cy="-.6" r="1.6" fill="#fff"/><circle cx="0" cy="0" r="1.1" fill="#f2c300"/></g>' : '';
    return '<svg viewBox="0 0 40 25" width="' + w + '" height="' + Math.round(w * 25 / 40) + '" aria-hidden="true" focusable="false"><rect x="1" y="2" width="38" height="17" rx="4" fill="' + fill + '"/><rect x="1" y="15" width="38" height="2" fill="rgba(0,0,0,.18)"/>' + win + fl +
      '<circle cx="10" cy="20" r="3.6" fill="#222"/><circle cx="10" cy="20" r="1.3" fill="#999"/><circle cx="30" cy="20" r="3.6" fill="#222"/><circle cx="30" cy="20" r="1.3" fill="#999"/></svg>';
  }
  function busIcon(kind) { var el = h("span", { class: "bzicon", "aria-hidden": "true" }); el.innerHTML = busSvg(BZ_COLORS[kind], 30, kind === "flower"); return el; }

  function bzEvents() { return (busAll || []).filter(function (d) { return d.t === "ev" && BZ_DELTA[d.kind] !== undefined && typeof d.date === "string"; }); }
  function bzGuests() { return (busAll || []).filter(function (d) { return d.t === "guest" && typeof d.date === "string"; }); }
  function bzDayEvents(ds) { return bzEvents().filter(function (e) { return e.date === ds; }); }
  function bzPlayers(ds) { return ["F", "C"].concat(bzGuests().filter(function (g) { return g.date === ds; }).sort(function (a, b) { return (a.ci || 0) - (b.ci || 0) || (a.at || 0) - (b.at || 0); }).map(function (g) { return g.id; })); }
  function bzGuest(id) { return bzGuests().filter(function (g) { return g.id === id; })[0] || null; }
  function bzName(id) { var g = bzGuest(id); return g ? String(g.name || "Gast") : id; }
  function bzCls(id) { var g = bzGuest(id); return g ? "G" + ((g.ci || 0) % 4) : id; }
  function bzInit(id) { return bzName(id).charAt(0).toUpperCase(); }

  /* Platten: Ein falsch gerufener Bus steht, bis 10 richtige Punkte gesammelt sind. Erst danach zählen Punkte wieder als Felder. */
  function bzReplay(list, ids) {
    var st = {}, winner = null;
    ids.forEach(function (id) { st[id] = { pos: 0, debt: 0, best: 0, wrong: 0, out: false }; });
    list.slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0) || String(a.id).localeCompare(String(b.id)); }).forEach(function (e) {
      var p = st[e.by]; if (!p || p.out) return;
      if (e.kind === "wrong" && p.debt > 0) { p.out = true; p.wrong++; }   // zweiter Fehler mit Platten: Bus explodiert
      else if (e.kind === "wrong") { p.debt += BZ_REPAIR; p.wrong++; }
      else {
        var d = BZ_DELTA[e.kind], used = Math.min(p.debt, d);
        p.debt -= used; p.pos = Math.min(BZ_GOAL, p.pos + d - used);
        if (p.pos > p.best) p.best = p.pos;
        if (!winner && p.pos >= BZ_GOAL) winner = e.by;
      }
    });
    return { st: st, winner: winner };
  }

  function busWrite(p) { return p.catch(writeFail); }
  function busAdd(id, kind) {
    if (!db || busAll === null) return;
    var ts = todayStr(), ref = db.collection("bus").doc();
    var cur0 = bzReplay(bzDayEvents(ts), bzPlayers(ts)).st[id];
    if (cur0 && cur0.out) return;
    busWrite(ref.set({ t: "ev", date: ts, by: id, kind: kind, enteredBy: me || "", at: Date.now() }));
    var l = busLanes[id];
    if (l && (kind === "flower" || kind === "wrong")) {
      l.tag.textContent = kind === "wrong" ? "💥" : "🌸";
      l.tag.classList.remove("show"); void l.tag.offsetWidth; l.tag.classList.add("show");
      if (kind === "wrong") { l.road.classList.remove("shake"); void l.road.offsetWidth; l.road.classList.add("shake"); }
    }
  }
  function busUndo() {
    var list = bzDayEvents(todayStr()).sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    if (!list.length) return;
    busWrite(db.doc("bus/" + list[0].id).delete());
  }
  function busAddGuest() {
    var inp = $("busguestname"), n = inp.value.trim(); if (!n || !db) return;
    var ts = todayStr(), cur = bzGuests().filter(function (g) { return g.date === ts; });
    if (cur.length >= 4) { inp.value = ""; inp.placeholder = "Maximal 4 Gäste pro Tag"; return; }
    var used = cur.map(function (g) { return g.ci; }), ci = 0; while (used.indexOf(ci) >= 0) ci++;
    busWrite(db.collection("bus").doc().set({ t: "guest", date: ts, name: n.slice(0, 20), ci: ci, at: Date.now() }));
    inp.value = "";
  }
  function busRemoveGuest(id) {
    busWrite(Promise.all(bzEvents().filter(function (e) { return e.by === id; }).map(function (e) { return db.doc("bus/" + e.id).delete(); }).concat([db.doc("bus/" + id).delete()])));
  }

  /* Spieltage und Serien */
  function bzWinners() {
    var days = {}, out = {};
    bzEvents().forEach(function (e) { (days[e.date] = days[e.date] || []).push(e); });
    Object.keys(days).sort().forEach(function (ds) { out[ds] = bzReplay(days[ds], bzPlayers(ds)).winner; });
    return out;
  }
  function bzStreaks(w) {
    var res = { F: { cur: 0, best: 0 }, C: { cur: 0, best: 0 } }, keys = Object.keys(w).sort();
    ["F", "C"].forEach(function (who) {
      var run = 0;
      keys.forEach(function (d) {            // nur Tage mit Sieger zählen; wirklich verloren = jemand anderes gewinnt
        if (!w[d]) return;
        if (w[d] === who) { run++; if (run > res[who].best) res[who].best = run; } else run = 0;
      });
      res[who].cur = run;
    });
    return res;
  }

  /* Rennbahnen */
  function busBuildLane(id) {
    var bus = h("div", { class: "bzbus " + bzCls(id), "aria-hidden": "true" });
    bus.innerHTML = busSvg("currentColor", 46, false);
    var tag = h("span", { class: "bztag", "aria-hidden": "true" }, "🌸");
    var cells = h("div", { class: "bzcells" }); for (var i = 0; i < BZ_GOAL; i++) cells.append(h("i"));
    var road = h("div", { class: "bzroad", role: "img" }, cells, h("div", { class: "bzfinish" }), bus, tag);
    var score = h("span", { class: "bzscore" }), nm = bzName(id);
    function add(kind) { return function () { busAdd(id, kind); }; }
    var flat = h("div", { class: "bzflat", role: "status" });
    var head = h("div", { class: "bzhead" }, h("span", { class: "bzwho " + bzCls(id) }, "Bus von " + nm), score);
    var box = h("div", { class: "bzlane" }, head, road, flat,
      h("div", { class: "bzbtns" },
        h("button", { class: "ok", type: "button", onclick: add("bus"), "aria-label": nm + ": Bus gesehen, plus 1" }, busIcon("bus"), "Bus", h("small", null, "+1 Feld")),
        h("button", { class: "ok", type: "button", onclick: add("flower"), "aria-label": nm + ": KölleBus gesehen, plus 2" }, busIcon("flower"), "KölleBus", h("small", null, "+2 Felder")),
        h("button", { class: "no", type: "button", onclick: add("wrong"), "aria-label": nm + ": Falsch gesehen, Platten, minus 10" }, "❌ Falsch", h("small", null, "Platten (−10)"))));
    if (bzGuest(id)) head.append(h("button", { class: "linkbtn bzremove", type: "button", onclick: function () { busRemoveGuest(id); } }, "Gast entfernen"));
    busLanes[id] = { box: box, bus: bus, tag: tag, road: road, score: score, flat: flat, wasOut: undefined };
    busShown[id] = 0;
    return box;
  }
  /* kleine Auspuff-Wölkchen hinter dem Bus, solange er ein Feld nach vorn fährt */
  function busPuff(l) {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (var i = 0; i < 6; i++) (function (k) {
      setTimeout(function () {
        if (!l.road.isConnected) return;
        var rb = l.road.getBoundingClientRect(), bb = l.bus.getBoundingClientRect();
        var p = h("span", { class: "bzpuff", "aria-hidden": "true" });
        p.style.left = (bb.left - rb.left + 4) + "px";
        p.style.setProperty("--d", (8 + Math.random() * 10).toFixed(0) + "px");
        p.style.setProperty("--s", (0.8 + Math.random() * 0.7).toFixed(2));
        l.road.append(p);
        setTimeout(function () { p.remove(); }, 800);
      }, k * 100);
    })(i);
  }
  /* Explosion: Funken fliegen vom Bus weg */
  function busBoom(l) {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var rb = l.road.getBoundingClientRect(), bb = l.bus.getBoundingClientRect();
    var cx = bb.left - rb.left + bb.width / 2, cy = bb.top - rb.top + bb.height / 2;
    var flash = h("span", { class: "bzflash", "aria-hidden": "true" }, "💥");
    flash.style.left = cx + "px"; flash.style.top = cy + "px";
    l.road.append(flash); setTimeout(function () { flash.remove(); }, 900);
    var cols = ["#ffb300", "#ff6f00", "#e53935", "#ffe082", "#9e9e9e"];
    for (var i = 0; i < 14; i++) {
      var a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 30, sp = h("span", { class: "bzspark", "aria-hidden": "true" });
      sp.style.left = cx + "px"; sp.style.top = cy + "px"; sp.style.background = cols[i % cols.length];
      sp.style.setProperty("--dx", (Math.cos(a) * r).toFixed(0) + "px"); sp.style.setProperty("--dy", (Math.sin(a) * r * 0.7).toFixed(0) + "px");
      l.road.append(sp); (function (n) { setTimeout(function () { n.remove(); }, 800); })(sp);
    }
  }
  function busPlace(id, pos, back) {
    var l = busLanes[id], w = l.road.clientWidth, trackW = w - 44, busW = 46;
    var left = pos / BZ_GOAL * (trackW - busW) + 2;
    if (pos >= BZ_GOAL) left = w - busW - 4;
    var prev = l.bus.style.left === "" ? null : parseFloat(l.bus.style.left), nl = Math.max(2, left);
    l.bus.classList.toggle("back", !!back);
    l.bus.style.left = nl + "px";
    if (prev !== null && !back && nl > prev + 1) busPuff(l);
    l.tag.style.left = Math.max(2, left + 12) + "px";
  }
  function busRenderRace() {
    var ts = todayStr(), ids = bzPlayers(ts), host = $("buslanes");
    if (busDay !== ts) { Object.keys(busLanes).forEach(function (id) { busLanes[id].box.remove(); delete busLanes[id]; delete busShown[id]; }); busDay = ts; }
    Object.keys(busLanes).forEach(function (id) { if (ids.indexOf(id) < 0) { busLanes[id].box.remove(); delete busLanes[id]; delete busShown[id]; } });
    ids.forEach(function (id) { if (!busLanes[id]) host.append(busBuildLane(id)); });
    var list = bzDayEvents(ts), r = bzReplay(list, ids);
    ids.forEach(function (id) {
      var l = busLanes[id], p = r.st[id];
      l.score.textContent = p.pos + " von " + BZ_GOAL + " Feldern";
      l.road.setAttribute("aria-label", bzName(id) + " steht auf Feld " + p.pos + " von " + BZ_GOAL + (p.debt ? ", Platten" : ""));
      busPlace(id, p.pos, p.pos < busShown[id]); busShown[id] = p.pos;
      if (p.out) l.score.textContent = "ausgeschieden";
      if (l.wasOut === false && p.out) busBoom(l);
      l.wasOut = p.out;
      l.bus.classList.toggle("wreck", p.out);
      l.box.classList.toggle("isout", p.out);
      l.box.querySelectorAll(".bzbtns button").forEach(function (b) { b.disabled = p.out; });
      l.bus.classList.toggle("isflat", p.debt > 0 && !p.out);
      l.flat.classList.toggle("show", p.debt > 0 || p.out);
      l.flat.replaceChildren();
      if (p.out) l.flat.append("💥 Der Bus ist explodiert – für heute ausgeschieden.");
      else if (p.debt > 0) {
        var blocks = Math.ceil(p.debt / BZ_REPAIR), earned = blocks * BZ_REPAIR - p.debt, dots = h("span", { class: "bzdots", "aria-hidden": "true" });
        for (var i = 0; i < BZ_REPAIR; i++) dots.append(h("i", { class: i < earned ? "on" : "" }));
        l.flat.append("🔧 Platten! Noch " + p.debt + " richtige Punkte" + (blocks > 1 ? " (" + blocks + " Platten)" : "") + ", dann fährt der Bus weiter.", dots);
      }
    });
    var wb = $("buswin");
    wb.className = "bzbanner" + (r.winner ? " show " + bzCls(r.winner) : "");
    wb.textContent = r.winner ? "🏁 " + bzName(r.winner) + " gewinnt den Tag! Gezählt wird trotzdem weiter." : "";
    var ul = $("buslog"); ul.replaceChildren();
    list.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    if (!list.length) ul.append(h("li", null, h("span", { class: "hint" }, "Heute wurde noch kein Bus gesehen.")));
    list.slice(0, 40).forEach(function (e) {
      var d = new Date(e.at || 0);
      ul.append(h("li", null, h("span", { class: "bzchip " + bzCls(e.by), title: bzName(e.by) }, bzInit(e.by)),
        h("span", { class: "bzev" }, e.kind === "wrong" ? "❌" : busIcon(e.kind), " " + BZ_NAMES[e.kind], e.enteredBy && e.enteredBy !== e.by ? h("span", { class: "hint" }, "  · eingetragen von " + e.enteredBy) : null),
        h("span", { class: "bzpts " + (BZ_DELTA[e.kind] > 0 ? "plus" : "minus") }, BZ_DELTA[e.kind] > 0 ? "+" + BZ_DELTA[e.kind] : "Platten"),
        h("span", { class: "bztime" }, pad(d.getHours()) + ":" + pad(d.getMinutes()))));
    });
    $("busundo").disabled = !list.length;
  }

  /* Statistik */
  function busRenderStats() {
    var ts = todayStr(), from = busPeriod === "all" ? "0000-00-00" : dnToStr(dn(ts) - (Number(busPeriod) - 1));
    var days = {};
    bzEvents().forEach(function (e) { if (e.date >= from && e.date <= ts) (days[e.date] = days[e.date] || []).push(e); });
    var S = { F: { bus: 0, flower: 0, wrong: 0, wins: 0, best: 0 }, C: { bus: 0, flower: 0, wrong: 0, wins: 0, best: 0 } }, guestWins = 0, winners = [];
    Object.keys(days).sort().forEach(function (ds) {
      var r = bzReplay(days[ds], bzPlayers(ds));
      days[ds].forEach(function (e) { if (S[e.by]) S[e.by][e.kind]++; });
      ["F", "C"].forEach(function (w) { if (r.st[w].best > S[w].best) S[w].best = r.st[w].best; });
      if (r.winner) { if (S[r.winner]) S[r.winner].wins++; else guestWins++; }
      winners.push({ ds: ds, w: r.winner });
    });
    var sk = bzStreaks(bzWinners()), box = $("busstatsbody"); box.replaceChildren();
    function seen(w) { return S[w].bus + S[w].flower; }
    function rate(w) { var t = seen(w) + S[w].wrong; return t ? Math.round(seen(w) / t * 100) + " %" : "–"; }
    var tot = seen("F") + seen("C"), pf = tot ? Math.round(seen("F") / tot * 100) : 50;
    if (!Object.keys(days).length) { box.append(h("div", { class: "panel" }, h("p", { class: "noneyet" }, "In diesem Zeitraum gibt es noch keine Einträge."))); }
    box.append(h("div", { class: "panel" }, h("h2", null, "Tagessiege"),
      h("div", { class: "duo" },
        h("div", { class: "bzbig F" }, h("div", { class: "num" }, String(S.F.wins)), h("div", { class: "lbl" }, "F gewinnt")),
        h("div", { class: "bzbig C" }, h("div", { class: "num" }, String(S.C.wins)), h("div", { class: "lbl" }, "C gewinnt"))),
      h("p", { class: "hint" }, (S.F.wins === S.C.wins ? "Gleichstand bei den Tagessiegen." : (S.F.wins > S.C.wins ? "F" : "C") + " führt bei den Tagessiegen.") + (guestWins ? " " + guestWins + (guestWins === 1 ? " Tag" : " Tage") + " gingen an Gäste." : ""))));
    function streakCard(w) { return h("div", { class: "bzbig " + w }, h("div", { class: "num" }, sk[w].cur + (sk[w].cur >= 3 ? " 🔥" : "")), h("div", { class: "lbl" }, w + " Siege in Folge"), h("div", { class: "hint" }, "Rekord: " + sk[w].best)); }
    box.append(h("div", { class: "panel" }, h("h2", null, "Siegesserie"), h("div", { class: "duo" }, streakCard("F"), streakCard("C")),
      h("p", { class: "hint" }, "Gezählt werden nur Spieltage mit einem Sieger. Tage ohne Spiel oder ohne Sieger ändern nichts. Die Serie endet erst, wenn jemand anderes (auch ein Gast) einen Tag gewinnt. Die Serie gilt über alle Tage, unabhängig vom Zeitraum.")));
    var table = h("table", { class: "bztable" }, h("thead", null, h("tr", null, h("th"), h("th", { class: "F" }, "F"), h("th", { class: "C" }, "C"))), h("tbody", null));
    function row(label, a, b, hb) {
      var lead = hb === undefined || a === b ? 0 : ((a > b) === hb ? 1 : -1);
      table.lastChild.append(h("tr", null, h("td", null, label), h("td", { class: lead === 1 ? "lead" : "" }, String(a)), h("td", { class: lead === -1 ? "lead" : "" }, String(b))));
    }
    row("Busse gesehen", S.F.bus, S.C.bus, true);
    row("KölleBusse", S.F.flower, S.C.flower, true);
    row("Falsch gesehen (Platten)", S.F.wrong, S.C.wrong, false);
    row("Trefferquote", rate("F"), rate("C"));
    row("Bester Tag (Felder)", S.F.best, S.C.best, true);
    box.append(h("div", { class: "panel" }, h("h2", null, "Vergleich"), table,
      h("div", { class: "bar", role: "img", "aria-label": "Anteil gesehener Busse: F " + pf + " Prozent" }, h("span", { class: "bf", style: "width:" + pf + "%" }), h("span", { class: "bc", style: "width:" + (100 - pf) + "%" })),
      h("p", { class: "hint" }, "Anteil gesehener Busse (Bus und KölleBus): F " + pf + " %, C " + (100 - pf) + " %. Gäste zählen hier nicht mit.")));
    var dw = h("div", { class: "bzdays" });
    winners.slice(-30).forEach(function (x) {
      dw.append(h("span", { class: "bzd " + (x.w ? bzCls(x.w) : ""), title: x.ds + (x.w ? ": " + bzName(x.w) + " gewinnt" : ": kein Sieger") }, x.w ? bzInit(x.w) : "·"));
    });
    if (winners.length) box.append(h("div", { class: "panel" }, h("h2", null, "Tagessieger der letzten Tage"), dw, h("p", { class: "hint" }, "Jedes Kästchen ist ein Spieltag. Grau heißt: niemand hat die 10 Felder geschafft. Andere Farben sind Gäste.")));
  }

  function busRender() {
    if (busAll === null) { $("busmain").hidden = true; $("busloading").hidden = false; return; }
    $("busmain").hidden = false; $("busloading").hidden = true;
    Array.prototype.forEach.call($("bustabs").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === busTab)); });
    Array.prototype.forEach.call($("busme").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === me)); });
    Array.prototype.forEach.call($("busperiod").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === busPeriod)); });
    $("busracev").hidden = busTab !== "race"; $("busstatsv").hidden = busTab !== "stats";
    $("busmerow").hidden = busTab !== "race";
    if (busTab === "race") busRenderRace(); else busRenderStats();
  }
  function busRefresh() {
    if (section === "bus") busRender();
    if (section === "home") renderHome();
  }
  function busHomeCard() {
    var ts = todayStr(), ids = bzPlayers(ts), r = bzReplay(bzDayEvents(ts), ids);
    var lead = ids.slice().sort(function (a, b) { return r.st[b].pos - r.st[a].pos; });
    var body = [];
    ids.forEach(function (id) {
      var p = r.st[id];
      body.push(h("div", { class: "bzmini" }, h("span", { class: "bzchip " + bzCls(id) }, bzInit(id)),
        h("div", { class: "bztrack" }, h("div", { class: "bzfill " + bzCls(id), style: "width:" + (p.pos / BZ_GOAL * 100) + "%" })),
        h("span", { class: "n" }, p.pos + "/" + BZ_GOAL + (p.debt ? " 🔧" : ""))));
    });
    var top = r.st[lead[0]].pos, second = r.st[lead[1]].pos;
    var txt = r.winner ? "🏁 " + bzName(r.winner) + " hat heute gewonnen." : (top === 0 ? "Noch kein Bus gesehen. Wer sieht den ersten?" : (top === second ? "Gleichstand!" : bzName(lead[0]) + " führt mit " + top + " zu " + second + "."));
    var fl = ids.filter(function (id) { return r.st[id].debt > 0; }).map(bzName);
    body.push(h("p", { class: "foot" }, txt + (fl.length ? " Platten bei: " + fl.join(", ") + "." : "")));
    var sk = bzStreaks(bzWinners());
    if (sk.F.cur || sk.C.cur) body.push(h("p", { class: "foot" }, "Serie: F " + sk.F.cur + " · C " + sk.C.cur + " Siege in Folge"));
    return homeCard("Bus-Rennen", "bus", body, "Zum Rennen");
  }

  $("bustabs").addEventListener("click", function (e) { var v = e.target.getAttribute && e.target.getAttribute("data-v"); if (v !== "race" && v !== "stats") return; busTab = v; lsSet("pp-bustab", v); busRender(); });
  $("busme").addEventListener("click", function (e) { var v = e.target.getAttribute && e.target.getAttribute("data-v"); if (v !== "F" && v !== "C") return; me = v; lsSet("pp-me", v); syncControls(); busRender(); });
  $("busperiod").addEventListener("click", function (e) { var v = e.target.getAttribute && e.target.getAttribute("data-v"); if (v !== "7" && v !== "30" && v !== "all") return; busPeriod = v; lsSet("pp-busperiod", v); busRender(); });
  $("busundo").addEventListener("click", busUndo);
  $("busguestadd").addEventListener("click", busAddGuest);
  $("busguestname").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); busAddGuest(); } });
  window.addEventListener("resize", function () { if (section === "bus" && busTab === "race") busRender(); });

  syncControls();
  render();

  /* ---------- Daten: Supabase (über js/store-supabase.js) ---------- */
  var COLLS = ["tasks", "log", "stores", "shop", "recipes", "plan", "budgets", "spend", "events", "bus"];
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
    listen("recipes", function (a) { recipes = a; renderCook(); renderMeal(); renderShop(); });
    listen("plan", function (a) {
      var m = {};
      a.forEach(function (d) { m[d.id] = d; });
      var cd = m._catalog; delete m._catalog;
      catalogSaved = cd && Array.isArray(cd.list) ? cd.list.filter(function (c) { return c && typeof c.n === "string"; }) : [];
      var fd = m._filters; delete m._filters;
      slotFilters = fd && fd.map && typeof fd.map === "object" ? fd.map : {};
      var ld = m._labels; delete m._labels;
      labelDefs = ld && Array.isArray(ld.list) ? ld.list.filter(function (l) { return l && typeof l.id === "string" && l.id !== "_side" && typeof l.emoji === "string" && typeof l.name === "string"; }).concat([SIDE_DEF]) : [SIDE_DEF];
      plan = m; planLoaded = true;
      renderCookStats(); renderMeal();
      renderCook();
    });
    listen("budgets", function (a) {
      budgets = a;
      if (!budgets.length && !budgetForm) openBudgetForm("new", null);
      renderSpend();
      ensureRepeats();
    });
    listen("events", function (a) { events = a; eventsLoaded = true; if (!evDraft) renderCal(); });
    listen("bus", function (a) { busAll = a; busRefresh(); });
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
