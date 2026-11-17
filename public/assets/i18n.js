// Language switch. Each person picks a language for their own view; it is remembered in this browser and nothing else changes (no page change, nobody else is affected).
// More languages = one more file in /assets/lang/ that adds itself to window.VL_LANGS, plus one script line in the two pages. The page text stays in English in the code;
// a language file maps each English sentence to its own words ("words"), and may add a few patterns for sentences with a name or number inside ("patterns").
// Anything without a translation is simply shown in English, so a missing line never breaks a page.
(function () {
  const LANGS = (window.VL_LANGS = window.VL_LANGS || {});
  const KEY = "vl-lang";
  const ATTRS = ["placeholder", "aria-label", "title", "alt"];
  const seen = new WeakMap(); // text node -> { src: the English, out: what we put there }; element -> { attr: { src, out } }
  let lang = "en", mo = null;

  const readPref = () => { try { return localStorage.getItem(KEY) || "en"; } catch { return "en"; } };
  const writePref = (l) => { try { localStorage.setItem(KEY, l); } catch { /* private window: the choice lasts for this visit only */ } };

  function translate(src) {
    const L = LANGS[lang]; if (!L) return null;
    const core = src.trim(); if (!core) return null;
    const lead = src.slice(0, src.length - src.trimStart().length), tail = src.slice(src.trimEnd().length);
    let out = L.words && Object.prototype.hasOwnProperty.call(L.words, core) ? L.words[core] : null;
    if (out == null && L.patterns) for (const [re, fn] of L.patterns) { const m = re.exec(core); if (m) { out = fn(...m.slice(1)); break; } }
    return out == null ? null : lead + out + tail;
  }
  const skip = (n) => { const p = n.nodeType === 1 ? n : n.parentElement; return !p || !!p.closest("script,style,[translate='no'],[data-i18n='off']"); };

  function doText(node) {
    let rec = seen.get(node);
    if (!rec || node.data !== rec.out) rec = { src: node.data, out: node.data }; // the page wrote new text: that is the new English
    const t = lang === "en" ? null : translate(rec.src);
    const next = t == null ? rec.src : t;
    if (node.data !== next) node.data = next;
    rec.out = next; seen.set(node, rec);
  }
  function doAttrs(el) {
    let rec = seen.get(el) || {};
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      let r = rec[a]; const cur = el.getAttribute(a);
      if (!r || cur !== r.out) r = { src: cur, out: cur };
      const t = lang === "en" ? null : translate(r.src); const next = t == null ? r.src : t;
      if (cur !== next) el.setAttribute(a, next);
      r.out = next; rec[a] = r;
    }
    seen.set(el, rec);
  }
  function apply(root) {
    if (!root || skip(root)) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n = w.currentNode;
    do { if (n.nodeType === 3) { if (!skip(n)) doText(n); } else if (n.nodeType === 1 && !skip(n)) doAttrs(n); } while ((n = w.nextNode()));
  }
  function sweep() {
    if (mo) mo.disconnect();
    try { apply(document.body); document.documentElement.lang = lang === "en" ? "en-IN" : (LANGS[lang] && LANGS[lang].tag) || lang; } finally { watch(); }
  }
  function watch() {
    if (!mo) mo = new MutationObserver(() => { if (lang !== "en") sweep(); }); // straight away (not on the next frame), so a hidden or slow tab never shows English for long
    mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function set(l) {
    lang = l === "en" || LANGS[l] ? l : "en"; writePref(lang);
    const sel = document.getElementById("vl-lang"); if (sel) sel.value = lang;
    sweep();
  }

  function mount() {
    const host = document.querySelector(".top-in"); if (!host || document.getElementById("vl-lang")) return;
    const names = Object.keys(LANGS); if (!names.length) return;
    const el = window.VL.el;
    const sel = el("select", { id: "vl-lang", class: "langpick", "aria-label": "Language", on: { change: () => set(sel.value) } },
      el("option", { value: "en", translate: "no" }, "English"), names.map((k) => el("option", { value: k, translate: "no" }, LANGS[k].name || k)));
    const wrap = el("label", { class: "lang", for: "vl-lang" }, el("span", { class: "lang-t" }, "Language"), sel);
    host.append(wrap);
  }

  function boot() { mount(); lang = readPref(); if (lang !== "en" && !LANGS[lang]) lang = "en"; const sel = document.getElementById("vl-lang"); if (sel) sel.value = lang; sweep(); }
  // The language files are deferred scripts too and run after this one, so start only when the whole page has been read.
  if (document.readyState === "complete") boot(); else document.addEventListener("DOMContentLoaded", boot);
  window.VL = window.VL || {}; window.VL.setLang = set; window.VL.tr = (s) => { const t = lang === "en" ? null : translate(s); return t == null ? s : t; }; window.VL.lang = () => lang;
})();
