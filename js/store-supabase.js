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
        emit(coll);
      }).catch(function (e) {
        loading[coll] = null;
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

    function docRef(coll, id) {
      if (collections.indexOf(coll) < 0) throw new Error("Unbekannte Sammlung");
      return {
        id: id,
        coll: coll,
        set: function (data) {
          return sb.from("docs").upsert({ coll: coll, id: id, data: clean(data) }, { onConflict: "coll,id" })
            .then(function (r) { if (r.error) throw mapError(r.error); applySet(coll, id, data); });
        },
        update: function (patch) {
          return sb.rpc("update_doc", { p_coll: coll, p_id: id, p_patch: clean(patch) })
            .then(function (r) { if (r.error) throw mapError(r.error); applyPatch(coll, id, patch); });
        },
        delete: function () {
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
      start: startRealtime,
      stop: function () { if (channel) { sb.removeChannel(channel); channel = null; } }
    };
    return db;
  };
})();
