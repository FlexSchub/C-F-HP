/* Darstellung (System / Hell / Dunkel): wird vor dem Zeichnen der Seite gesetzt, damit nichts aufblitzt */
(function () {
  try {
    var t = localStorage.getItem("pp-theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();
