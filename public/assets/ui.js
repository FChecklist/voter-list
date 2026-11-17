// Small shared helpers. No framework, no innerHTML with data: every value goes in as text, so a name like <script> is only ever shown, never run.
(function () {
  const VL = (window.VL = {});
  // What people read for a role (the stored value for the first role stays "Owner").
  VL.cap = (c) => (c === "Owner" ? "Owner / 1st Name in Registration" : c || "");
  // append() that flattens arrays and skips null/false, so conditional children are safe everywhere
  const nativeAppend = Element.prototype.append;
  Element.prototype.append = function (...kids) { return nativeAppend.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
  VL.el = function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (k === "value") n.value = v;
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "hidden" || k === "open") n[k] = !!v;
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat(Infinity)) { if (c == null || c === false) continue; n.append(c instanceof Node ? c : document.createTextNode(String(c))); }
    return n;
  };
  const el = VL.el;
  VL.api = async function api(method, path, body) {
    const init = { method, credentials: "same-origin", headers: { "x-vl": "1" } };
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, init); } catch { throw Object.assign(new Error("The connection dropped. Nothing was changed. Please try again."), { status: 0 }); }
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok) throw Object.assign(new Error((j && j.error) || "Something went wrong."), { status: res.status, code: j && j.code, body: j });
    return j;
  };
  // The free Cloudflare Turnstile box. It appears only when the server has it set up; otherwise this is an empty space and sign-in works as before.
  let cfgP = null;
  VL.config = () => (cfgP = cfgP || fetch("/api/config", { credentials: "same-origin" }).then((r) => r.json()).catch(() => ({})));
  let tsP = null;
  const loadTurnstile = () => (tsP = tsP || new Promise((ok, no) => { if (window.turnstile) return ok(); const s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.onload = () => ok(); s.onerror = () => no(new Error("turnstile")); document.head.appendChild(s); }));
  VL.captcha = function captcha() {
    const node = el("div", { class: "captcha" }); let token = "", wid = null;
    VL.config().then((c) => { if (!c.turnstileSiteKey) return; return loadTurnstile().then(() => { wid = window.turnstile.render(node, { sitekey: c.turnstileSiteKey, callback: (t) => { token = t; }, "expired-callback": () => { token = ""; }, "error-callback": () => { token = ""; } }); }); }).catch(() => { node.replaceChildren(el("p", { class: "tiny muted" }, "The safety box could not open. Please check your connection, or pause any content blocker for this page, then try again.")); });
    return { node, token: () => token, reset: () => { token = ""; if (wid !== null && window.turnstile) try { window.turnstile.reset(wid); } catch { /* the box may be gone */ } } };
  };
  VL.fill = function fill(n, ...kids) { n.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k instanceof Node ? k : document.createTextNode(String(k))))); return n; };
  VL.toast = function toast(msg, bad) {
    const t = el("div", { class: "toast" + (bad ? " bad" : ""), role: bad ? "alert" : "status" }, msg);
    document.body.append(t); setTimeout(() => t.remove(), bad ? 7000 : 3500);
  };
  VL.fail = (e) => VL.toast(e && e.message ? e.message : String(e), true);
  VL.fmtDate = (ms) => (ms ? new Date(ms).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  VL.fmtDay = (iso) => (iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");
  VL.milli = (n) => { const v = n / 1000; return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, ""); };
  VL.plural = (n, a, b) => `${n} ${n === 1 ? a : b || a + "s"}`;
  // modal: fields = [{name,label,type,options,value,help}] -> resolves to {name:value} or null
  VL.ask = function ask(title, intro, fields, okLabel) {
    return new Promise((resolve) => {
      const d = el("dialog", { "aria-labelledby": "dlg_title" });
      const form = el("form", { method: "dialog" });
      const inputs = {};
      form.append(el("h2", { id: "dlg_title" }, title), intro ? el("p", { class: "small" }, intro) : null);
      for (const f of fields || []) {
        const id = "f_" + f.name;
        let input;
        if (f.type === "select") input = el("select", { id }, f.options.map((o) => el("option", { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)));
        else if (f.type === "textarea") input = el("textarea", { id, value: f.value || "" });
        else if (f.type === "checkbox") input = el("input", { id, type: "checkbox", checked: !!f.value });
        else input = el("input", { id, type: f.type || "text", value: f.value || "", autocomplete: "off", maxlength: f.max });
        inputs[f.name] = input;
        form.append(f.type === "checkbox" ? el("label", {}, input, " ", f.label) : [el("label", { for: id }, f.label), input], f.help ? el("p", { class: "tiny muted" }, f.help) : null);
      }
      const ok = el("button", { class: "btn brass", type: "submit", value: "ok" }, okLabel || "OK");
      const no = el("button", { class: "btn ghost", type: "button", on: { click: () => d.close("cancel") } }, "Cancel");
      form.append(el("div", { class: "row end" }, no, ok));
      d.append(form); document.body.append(d);
      d.addEventListener("close", () => {
        const out = d.returnValue === "ok" ? Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === "checkbox" ? i.checked : i.value])) : null;
        d.remove(); resolve(out);
      });
      d.showModal(); const first = Object.values(inputs)[0]; if (first) first.focus();
    });
  };
  // the short list offered whenever someone is marked "not allowed to vote" (mirrors src/reasons.ts)
  VL.REASONS = [["dues", "Dues unpaid"], ["tenant", "Tenant"], ["coowner", "Co-owner, or not the 1st name (only the Owner / 1st name may vote)"], ["not_member", "Not a member of the society"], ["proxy_papers", "Proxy papers awaited"], ["other", "Another reason (I will write it below)"]];
  // asks for the reason: resolves to {reason, note} or null; never lets "no reason" through
  VL.askReason = async function askReason(title, intro, cur, okLabel, save) {
    for (;;) {
      const a = await VL.ask(title, intro, [{ name: "reason", type: "select", label: "Why is this person not allowed to vote?", options: [{ value: "", label: "Choose a reason..." }, ...VL.REASONS.map(([value, label]) => ({ value, label }))], value: (cur && cur.reason) || "" }, { name: "note", label: "Your own words (needed for 'Another reason', optional for the others)", max: 120, value: (cur && cur.note) || "", help: "Please do not write phone numbers or e-mail IDs." }], okLabel || "Save");
      if (!a) return null;
      if (!a.reason) { VL.toast("Please choose a reason from the list.", true); cur = a; continue; }
      if (a.reason === "other" && a.note.trim().length < 3) { VL.toast("Please write the reason in a few words.", true); cur = a; continue; }
      const out = { reason: a.reason, note: a.note.trim() };
      if (save) { try { await save(out); } catch (e) { VL.fail(e); cur = out; continue; } }
      return out;
    }
  };
  VL.confirm = async (title, text, okLabel) => !!(await VL.ask(title, text, [], okLabel || "Yes, do it"));
  VL.show = function show(title, ...body) {
    const d = el("dialog", { style: "max-width:min(900px,96vw)" }, el("h2", {}, title), ...body, el("div", { class: "row end" }, el("button", { class: "btn", on: { click: () => d.close() } }, "Close")));
    d.addEventListener("close", () => d.remove()); document.body.append(d); d.showModal();
  };
  VL.copy = async (text) => { try { await navigator.clipboard.writeText(text); VL.toast("Copied."); } catch { VL.toast("Please copy it by hand: " + text); } };
  VL.table = function table(heads, rows) {
    return el("div", { class: "tablewrap", tabindex: "0", role: "region", "aria-label": "Table: scroll sideways to see every column" }, el("table", {}, el("thead", {}, el("tr", {}, heads.map((h) => el("th", {}, h)))), el("tbody", {}, rows)));
  };
})();
