/* Speicher-Adapter: Supabase (Postgres) hinter einer einfachen Schnittstelle.
   Die App selbst (app.js) kennt nur diese Schnittstelle:
     db.collection(name).onSnapshot / get / add / doc(id)
     db.doc("sammlung/id").set / update / delete
     db.batch().set(ref, daten).commit()
   Wer später den Speicher wechselt (z. B. auf eine selbst gehostete Datenbank),
   muss nur diese Datei ersetzen. */
(function () {
  "use strict";

  function clean(v) { return JSON.parse(JSON.stringify(v === undefined ? {} : v)); }
  function newId() {
    var a = new Uint8Array(15);
    crypto.getRandomValues(a);
    var s = "";
    for (var i = 0; i < a.length; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[a[i] % 36];
    return s;
  }
  function mapError(err) {
    if (!err) return err;
    var c = String(err.code || "");
    var e = new Error(err.message || "Fehler");
    // 42501 = Zeilensicherheit hat den Zugriff verweigert, PGRST301/jwt = Anmeldung ungültig
    if (c === "42501" || c === "PGRST301" || c === "PGRST303" || err.status === 401 || err.status === 403) e.code = "permission-denied";
    else e.code = c || (err.status ? "http-" + err.status : "fehler");
    return e;
  }

  window.createSupabaseStore = function (sb, collections) {
    var cache = {}, loaded = {}, listeners = {}, loading = {};
    collections.forEach(function (c) { cache[c] = new Map(); listeners[c] = []; });
    var channel = null, wasSubscribed = false;

    function snapshot(coll) {
      var ids = Array.from(cache[coll].keys()).sort();
      return {
        docs: ids.map(function (id) {
          var d = cache[coll].get(id);
          return { id: id, data: function () { return clean(d); } };
        })
      };
    }
    function emit(coll) {
      if (!loaded[coll]) return;
      var snap = snapshot(coll);
      listeners[coll].slice().forEach(function (l) { try { l.cb(snap); } catch (e) { if (window.console) console.error(e); } });
    }
    function fetchAll(coll) {
      var rows = [], page = 1000;
      function next(from) {
        return sb.from("docs").select("id,data").eq("coll", coll).order("id", { ascending: true }).range(from, from + page - 1)
          .then(function (r) {
            if (r.error) throw mapError(r.error);
            rows = rows.concat(r.data || []);
            return (r.data && r.data.length === page) ? next(from + page) : rows;
          });
      }
      return next(0);
    }
    function load(coll) {
      if (loading[coll]) return loading[coll];
      loading[coll] = fetchAll(coll).then(function (rows) {
        var m = new Map();
        rows.forEach(function (r) { m.set(r.id, r.data || {}); });
        cache[coll] = m; loaded[coll] = true; loading[coll] = null;
        reapplyQ(coll);
        emit(coll);
      }).catch(function (e) {
        loading[coll] = null;
        if (loaded[coll] && isNet(e)) return;   // offline: vorhandene Daten behalten, keine Fehlermeldung
        listeners[coll].slice().forEach(function (l) { if (l.err) l.err(e); });
      });
      return loading[coll];
    }
    function reloadAll() { collections.forEach(function (c) { if (listeners[c].length) load(c); }); }

    function startRealtime() {
      if (channel) return;
      channel = sb.channel("haushalt-docs")
        .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, function (p) {
          var row = p.eventType === "DELETE" ? p.old : p.new;
          if (!row || !cache[row.coll]) return;
          if (p.eventType === "DELETE") cache[row.coll].delete(row.id);
          else cache[row.coll].set(row.id, row.data || {});
          reapplyQ(row.coll);
          emit(row.coll);
        })
        .subscribe(function (status) {
          if (status === "SUBSCRIBED") {
            // Nach einem Verbindungsabbruch alles neu laden, damit nichts fehlt.
            if (wasSubscribed) reloadAll();
            wasSubscribed = true;
          }
        });
    }
    document.addEventListener("visibilitychange", function () { if (!document.hidden) reloadAll(); });

    function applySet(coll, id, data) { cache[coll].set(id, clean(data)); emit(coll); }
    function applyPatch(coll, id, patch) {
      var old = cache[coll].get(id) || {};
      cache[coll].set(id, Object.assign({}, old, clean(patch))); emit(coll);
    }
    function applyDelete(coll, id) { cache[coll].delete(id); emit(coll); }

    /* Offline-Warteschlange (nur Einkauf): Ohne Netz werden Änderungen lokal angezeigt,
       auf dem Gerät gemerkt und bei Verbindung der Reihe nach gesendet. */
    var QCOLL = "shop", QKEY = "pp-queue", queue = [], flushing = false, qlisteners = [];
    try { queue = JSON.parse(localStorage.getItem(QKEY) || "[]"); if (!Array.isArray(queue)) queue = []; } catch (e) { queue = []; }
    function saveQ() { try { localStorage.setItem(QKEY, JSON.stringify(queue)); } catch (e) {} qlisteners.forEach(function (f) { try { f(queue.length); } catch (e) {} }); }
    function isNet(err) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
      var m = String((err && (err.message || err.details)) || err || "");
      return !!(err && (err.netfail || /failed to fetch|networkerror|load failed|network request failed|timeout|abort/i.test(m)));
    }
    function execOp(op) {
      var q;
      if (op.k === "set") q = sb.from("docs").upsert({ coll: op.coll, id: op.id, data: op.data }, { onConflict: "coll,id" });
      else if (op.k === "update") q = sb.rpc("update_doc", { p_coll: op.coll, p_id: op.id, p_patch: op.data });
      else q = sb.from("docs").delete().eq("coll", op.coll).eq("id", op.id);
      return Promise.resolve(q).then(function (r) { return r || {}; }, function (e) { return { error: { message: String(e && e.message || e), netfail: true } }; });
    }
    function applyOp(op, quiet) {
      if (op.k === "set") cache[op.coll].set(op.id, clean(op.data));
      else if (op.k === "update") cache[op.coll].set(op.id, Object.assign({}, cache[op.coll].get(op.id) || {}, clean(op.data)));
      else cache[op.coll].delete(op.id);
      if (!quiet) emit(op.coll);
    }
    function reapplyQ(coll) { queue.forEach(function (op) { if (op.coll === coll) applyOp(op, true); }); }
    function flushQ() {
      if (flushing || !queue.length || navigator.onLine === false) return Promise.resolve();
      flushing = true;
      var done = 0;
      function next() {
        if (!queue.length) return Promise.resolve();
        return execOp(queue[0]).then(function (r) {
          if (r.error && isNet(r.error)) return;               // weiter warten
          queue.shift(); done++; saveQ();                     // gesendet (oder abgelehnt und verworfen)
          return next();
        });
      }
      return next().then(function () {
        flushing = false;
        if (done && listeners[QCOLL].length) return load(QCOLL);
      });
    }
    window.addEventListener("online", function () { flushQ(); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) flushQ(); });
    function writeQ(op) {
      var data = op.data === undefined ? undefined : clean(op.data);
      op = { k: op.k, coll: op.coll, id: op.id, data: data };
      function park() { queue.push(op); saveQ(); applyOp(op); setTimeout(flushQ, 3000); }
      if (queue.length || flushing || navigator.onLine === false) { park(); flushQ(); return Promise.resolve(); }
      return execOp(op).then(function (r) {
        if (r.error) { if (isNet(r.error)) { park(); return; } throw mapError(r.error); }
        applyOp(op);
      });
    }

    function docRef(coll, id) {
      if (collections.indexOf(coll) < 0) throw new Error("Unbekannte Sammlung");
      return {
        id: id,
        coll: coll,
        set: function (data) {
          if (coll === QCOLL) return writeQ({ k: "set", coll: coll, id: id, data: data });
          return sb.from("docs").upsert({ coll: coll, id: id, data: clean(data) }, { onConflict: "coll,id" })
            .then(function (r) { if (r.error) throw mapError(r.error); applySet(coll, id, data); });
        },
        update: function (patch) {
          if (coll === QCOLL) return writeQ({ k: "update", coll: coll, id: id, data: patch });
          return sb.rpc("update_doc", { p_coll: coll, p_id: id, p_patch: clean(patch) })
            .then(function (r) { if (r.error) throw mapError(r.error); applyPatch(coll, id, patch); });
        },
        delete: function () {
          if (coll === QCOLL) return writeQ({ k: "delete", coll: coll, id: id });
          return sb.from("docs").delete().eq("coll", coll).eq("id", id)
            .then(function (r) { if (r.error) throw mapError(r.error); applyDelete(coll, id); });
        }
      };
    }

    var db = {
      collection: function (coll) {
        if (collections.indexOf(coll) < 0) throw new Error("Unbekannte Sammlung");
        return {
          doc: function (id) { return docRef(coll, id || newId()); },
          add: function (data) { var ref = docRef(coll, newId()); return ref.set(data).then(function () { return ref; }); },
          get: function () {
            return fetchAll(coll).then(function (rows) {
              return { docs: rows.map(function (r) { return { id: r.id, data: function () { return clean(r.data || {}); } }; }) };
            });
          },
          onSnapshot: function (cb, err) {
            var l = { cb: cb, err: err };
            listeners[coll].push(l);
            if (loaded[coll]) cb(snapshot(coll)); else load(coll);
            return function () { listeners[coll] = listeners[coll].filter(function (x) { return x !== l; }); };
          }
        };
      },
      doc: function (path) {
        var p = String(path).split("/");
        return docRef(p[0], p[1]);
      },
      batch: function () {
        var ops = [];
        return {
          set: function (ref, data) { ops.push({ coll: ref.coll, id: ref.id, data: clean(data) }); },
          commit: function () {
            if (!ops.length) return Promise.resolve();
            return sb.from("docs").upsert(ops, { onConflict: "coll,id" }).then(function (r) {
              if (r.error) throw mapError(r.error);
              var touched = {};
              ops.forEach(function (o) { cache[o.coll].set(o.id, o.data); touched[o.coll] = true; });
              Object.keys(touched).forEach(emit);
            });
          }
        };
      },
      savePush: function (sub, who) {
        return sb.from("push_subs").upsert({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, who: who }, { onConflict: "endpoint" })
          .then(function (r) { if (r.error) throw mapError(r.error); });
      },
      removePush: function (endpoint) {
        return sb.from("push_subs").delete().eq("endpoint", endpoint).then(function (r) { if (r.error) throw mapError(r.error); });
      },
      pending: function () { return queue.length; },
      onPending: function (f) { qlisteners.push(f); },
      flush: flushQ,
      start: function () { startRealtime(); flushQ(); },
      stop: function () { if (channel) { sb.removeChannel(channel); channel = null; } }
    };
    return db;
  };
})();
