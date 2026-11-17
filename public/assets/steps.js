// The step bar and step cards used by both single pages. A step is one of: done, now (the one to act on), open (reopened by the person), locked.
(function () {
  const VL = window.VL, el = VL.el;
  /** steps: [{key, short, title, state:'done'|'now'|'locked'|'todo', summary, body: ()=>Node[], open:boolean}] */
  VL.stepbar = function (steps, goto) {
    return el("ol", { class: "stepbar", "aria-label": "Your progress" }, steps.map((s, i) => el("li", { class: s.state === "now" ? "now" : "" },
      el("button", { type: "button", disabled: s.state === "locked", "aria-current": s.state === "now" ? "step" : false, on: { click: () => goto(s.key) } },
        el("span", { class: "dot " + (s.state === "done" ? "done" : s.state === "now" ? "now" : "") }, s.state === "done" ? "✓" : String(i + 1)),
        el("span", {}, s.short)))));
  };
  VL.stepcards = function (steps, goto) {
    return steps.map((s, i) => {
      const isOpen = s.open || s.state === "now";
      const head = el("header", {},
        el("span", { class: "dot " + (s.state === "done" ? "done" : s.state === "now" ? "now" : "") }, s.state === "done" ? "✓" : String(i + 1)),
        el("h2", { id: "h-" + s.key, tabindex: "-1" }, s.title),
        !isOpen && s.summary ? el("span", { class: "sum" }, s.summary) : null,
        !isOpen && s.state !== "locked" ? el("button", { class: "btn ghost small", type: "button", "aria-label": (s.state === "done" ? "Change: " : "Open: ") + s.title, on: { click: () => goto(s.key) } }, s.state === "done" ? "Change" : "Open") : null,
        s.state === "locked" ? el("span", { class: "sum tiny" }, s.lockedNote || "Opens after the step above") : null);
      return el("section", { class: "step " + (s.state === "now" ? "now" : s.state === "locked" ? "locked" : ""), id: "step-" + s.key, "aria-labelledby": "h-" + s.key }, head,
        isOpen && s.state !== "locked" ? el("div", { class: "body" }, s.body()) : null);
    });
  };
  /** After a step opens, bring it into view and move keyboard focus to its heading. */
  VL.focusStep = function (key) {
    const h = document.getElementById("h-" + key); if (!h) return;
    const sec = document.getElementById("step-" + key); if (sec) sec.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    h.focus({ preventScroll: true });
  };
  VL.err = () => { const n = el("p", { class: "note bad hidden", role: "alert" }); n.show = (m) => { n.textContent = m; n.classList.remove("hidden"); n.scrollIntoView({ block: "nearest" }); }; n.clear = () => n.classList.add("hidden"); return n; };
  VL.localTime = (s) => { // "2026-11-15T18:00" is already in the list's own time; show it as written, never shifted
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(s || ""); if (!m) return "";
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toLocaleString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  };
  VL.busy = async (btn, fn) => { const t = btn.textContent; btn.disabled = true; try { return await fn(); } finally { btn.disabled = false; btn.textContent = t; } };
})();
