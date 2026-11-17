// The voter's single page: /v/<link>. Steps 1 to 7, top to bottom. Everything is text (no innerHTML with data).
(function () {
  const { el, api, toast, fail } = window.VL;
  const slug = location.pathname.split("/").filter(Boolean).pop();
  const A = (p) => `/api/v/${slug}${p}`;
  const S = { info: null, me: null, email: "", codeSent: false, codeFor: "", rid: null, open: null, adding: false, pub: { rows: [], total: 0, q: "", loaded: false } };
  const root = document.getElementById("app");
  const DOCS = ["Sale Deed or Share Certificate", "Allotment or Possession Letter", "Rent Agreement", "Proxy Nomination Form", "Society ID", "Registration Paper", "Others"];
  const maskMail = (e) => e.replace(/^(.).*(@)(.).*(\..+)$/, "$1****$2$3****$4");
  const CAP_HELP = { Owner: "You own the flat or house", "Co-owner": "You share ownership with someone", Tenant: "You live here on rent", Proxy: "You act for the owner, with their written authority", Member: "You are a member of the society" };

  const recs = () => (S.me ? S.me.records.filter((r) => r.status !== "removed") : []);
  const cur = () => { const r = recs(); return r.find((x) => x.id === S.rid) || r[0] || null; };
  const sent = (r) => !!r && (r.status === "submitted" || r.status === "approved");

  async function loadInfo() { S.info = await api("GET", A("")); }
  async function loadMe() {
    try { S.me = await api("GET", A("/me")); } catch (e) { if (e.status === 401) S.me = null; else throw e; }
    const r = recs(); if (!r.some((x) => x.id === S.rid)) S.rid = r[0] ? r[0].id : null;
  }
  async function loadPub(q, more) {
    if (!S.info || !S.info.shown) { S.pub = { rows: [], total: 0, q: "", loaded: true }; return; }
    const off = more ? S.pub.rows.length : 0;
    const j = await api("GET", A(`/list?offset=${off}&limit=50&unit=${encodeURIComponent(q ?? S.pub.q)}`));
    S.pub = { rows: more ? S.pub.rows.concat(j.rows) : j.rows, total: j.total, q: q ?? S.pub.q, loaded: true };
  }

  function go(key) { S.open = key; draw(key); }
  function draw(focusKey) {
    const steps = buildSteps();
    const now = steps.find((s) => s.state === "now");
    const i = S.info;
    const head = el("div", { class: "hero" }, el("h1", {}, i.name), el("p", { class: "muted" }, `${i.kind}${i.state ? ", " + i.state : ""}. `, i.rule.blurb),
      closingNote(i));
    const page = el("div", { class: "page" }, head, window.VL.stepbar(steps, go), window.VL.stepcards(steps, go),
      el("p", { class: "tiny muted center" }, "Need help? Please ask the person who shared this link with you. ", i.permanentNote));
    root.replaceChildren(page);
    if (focusKey) window.VL.focusStep(focusKey); else if (now && S.justMoved) { window.VL.focusStep(now.key); }
    S.justMoved = false;
    const who = document.getElementById("who");
    who.replaceChildren(...(S.me ? [el("span", {}, S.me.email), el("button", { class: "btn ghost small", type: "button", on: { click: signOut } }, "Sign out")] : []));
  }
  function closingNote(i) {
    if (i.phase === "frozen") return el("p", { class: "note warn" }, "This list is final. Enrolment is closed.");
    if (!i.enrolOpen) return el("p", { class: "note warn" }, "Enrolment has closed.");
    if (i.cutoffLocal) return el("p", { class: "note" }, "You can enrol and change your details until ", el("b", {}, window.VL.localTime(i.cutoffLocal)), ".");
    return null;
  }
  async function signOut() { try { await api("POST", A("/logout"), {}); } catch { /* already out */ } S.me = null; S.codeSent = false; S.open = null; draw(); }

  // ------------------------------------------------------------------------------------------------ the seven steps
  function buildSteps() {
    const signedIn = !!S.me, r = cur(), has = !!r, isSent = sent(r);
    const closed = !S.info.enrolOpen;
    const mk = (key, short, title, o) => ({ key, short, title, ...o, open: S.open === key });
    const s = [
      mk("signin", "Sign in", "Step 1. Sign in", { state: signedIn ? "done" : "now", summary: signedIn ? S.me.email : "", body: signinBody }),
      mk("enrol", "Enrol", "Step 2. Tell us who you are", { state: !signedIn ? "locked" : has ? "done" : closed ? "todo" : "now", summary: has ? `${r.unit}, ${window.VL.cap(r.capacity)}` : "", body: enrolBody, lockedNote: "Opens after you sign in" }),
      mk("confirm", "Send", "Step 3. Check and send", { state: !has ? "locked" : isSent ? "done" : "now", summary: isSent ? "Sent to the list team" : "", body: confirmBody, lockedNote: "Opens after step 2" }),
      mk("details", "Details", "Step 4. Your information", { state: !has ? "locked" : "todo", summary: has ? r.name : "", body: detailsBody, lockedNote: "Opens after step 2" }),
      mk("docs", "Files", "Step 5. Documents", { state: !has ? "locked" : "todo", summary: has ? (r.docs.length ? `${r.docs.length} added` : "None added") : "", body: docsBody, lockedNote: "Opens after step 2" }),
      mk("status", "Status", "Step 6. Where things stand", { state: !has ? "locked" : isSent || r.status === "sent_back" ? "now" : "todo", summary: has ? statusWord(r) : "", body: statusBody, lockedNote: "Opens after step 2" }),
      mk("list", "List", "Step 7. The public list", { state: "todo", summary: S.info.shown ? (S.info.shown.provisional ? "Provisional list published" : "Final list published") : "Not published yet", body: listBody }),
    ];
    // only one "now": the first not-done among 1 to 3, else status
    let seen = false; for (const x of s) { if (x.state === "now") { if (seen) x.state = "todo"; seen = true; } }
    return s;
  }
  const statusWord = (r) => ({ invited: "Ready for you to check", draft: "Not sent yet", submitted: "With the list team", approved: "Approved", sent_back: "Sent back to you" })[r.status] || r.status;

  // ---- step 1
  function signinBody() {
    const err = window.VL.err();
    if (!S.codeSent) {
      const email = el("input", { id: "em", type: "email", autocomplete: "email", inputmode: "email", required: true, value: S.email, placeholder: "name@example.com" });
      const btn = el("button", { class: "btn brass big", type: "submit" }, "Send me a code"); const cap = window.VL.captcha();
      return [el("p", { class: "muted" }, "We will e-mail you a 6-digit code. There is no password to remember."),
        el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); S.email = email.value.trim(); await window.VL.busy(btn, async () => { btn.textContent = "Sending…"; try { await api("POST", A("/start"), { email: S.email, turnstileToken: cap.token() }); S.codeSent = true; S.codeFor = S.email; S.justMoved = false; draw("signin"); devHint(); } catch (x) { err.show(x.message); cap.reset(); } }); } } },
          el("label", { for: "em" }, "Your e-mail ID"), email, cap.node, err, el("div", { class: "row" }, btn)),
        el("p", { class: "tiny muted" }, "What happens next: you enter the code here, and stay signed in for 8 hours on this device.")];
    }
    const code = el("input", { id: "cd", class: "codebox", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "14", required: true, "aria-describedby": "cdh", placeholder: "000000" });
    const btn = el("button", { class: "btn brass big", type: "submit" }, "Continue");
    return [el("p", {}, "A 6-digit code is on its way to ", el("b", {}, maskMail(S.codeFor)), ". It works for 10 minutes. Nothing after a few minutes? Please check Spam, or try again later (a busy day can delay codes). If you cannot see it, please look in Spam or Promotions."),
      el("p", { id: "devhint", class: "note hidden" }),
      el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); await window.VL.busy(btn, async () => { btn.textContent = "Checking…"; try { await api("POST", A("/verify"), { email: S.codeFor, code: code.value }); await loadMe(); S.codeSent = false; S.open = null; S.justMoved = true; draw(); } catch (x) { err.show(x.message); code.focus(); } }); } } },
        el("label", { for: "cd" }, "The code"), code, el("p", { id: "cdh", class: "tiny muted" }, "You can paste it, with or without spaces."), err,
        el("div", { class: "row" }, btn, el("button", { class: "btn ghost", type: "button", on: { click: () => { S.codeSent = false; draw("signin"); } } }, "Use a different e-mail ID")))];
  }
  async function devHint() { // only on a developer's own computer
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    try { const j = await (await fetch(`/dev/code?to=${encodeURIComponent(S.codeFor)}`)).json(); const n = document.getElementById("devhint"); if (n && j.code) { n.textContent = "Test mode: your code is " + j.code; n.classList.remove("hidden"); } } catch { /* not the dev server */ }
  }

  // ---- the record form (used to enrol, and to change details)
  function recordForm(r, opts) {
    const i = S.info, err = window.VL.err();
    const unit = el("input", { id: "un", type: "text", autocomplete: "off", required: true, maxlength: "40", value: r ? r.unit : "", placeholder: "A-101" });
    const name = el("input", { id: "nm", type: "text", autocomplete: "name", required: true, maxlength: "100", value: r ? r.name : "" });
    const mobile = el("input", { id: "mb", type: "tel", autocomplete: "tel-national", inputmode: "tel", required: true, maxlength: "20", value: r ? r.mobile : "" });
    const proxy = el("input", { id: "pf", type: "text", autocomplete: "off", maxlength: "100", value: r ? r.proxyFor : "" });
    const proxyRow = el("div", {}, el("label", { for: "pf" }, "Name of the owner you act for"), proxy);
    const caps = i.rule.capacities; let chosen = r && r.capacity ? r.capacity : caps.length === 1 ? caps[0] : "";
    const radios = caps.map((c) => el("label", {}, el("input", { type: "radio", name: "cap", value: c, checked: c === chosen, required: true, on: { change: () => { chosen = c; sync(); } } }), el("span", {}, window.VL.cap(c), el("small", {}, CAP_HELP[c] || ""))));
    const sync = () => proxyRow.classList.toggle("hidden", chosen !== "Proxy"); sync();
    const lockUnit = r && r.status === "approved";
    if (lockUnit) unit.disabled = true;
    const btn = el("button", { class: "btn brass big", type: "submit" }, opts.cta);
    return el("form", { on: { submit: async (e) => {
      e.preventDefault(); err.clear();
      await window.VL.busy(btn, async () => { btn.textContent = "Saving…"; try { await opts.save({ unit: unit.value, name: name.value, mobile: mobile.value, capacity: chosen, proxyFor: chosen === "Proxy" ? proxy.value : "" }); } catch (x) { err.show(x.message); } });
    } } },
    el("fieldset", { style: "border:0;padding:0;margin:0" }, el("legend", { class: "big", style: "font-weight:600" }, "I am the"), el("div", { class: "choices" }, radios)),
    proxyRow,
    el("div", { class: "fieldrow" }, el("div", {}, el("label", { for: "un" }, "Flat or house number"), unit, lockUnit ? el("p", { class: "tiny muted" }, "The flat cannot be changed once approved. Please ask the list team.") : null), el("div", {}, el("label", { for: "nm" }, "Your name, as in the sale deed or society record"), name)),
    el("div", { class: "fieldrow" }, el("div", {}, el("label", { for: "mb" }, "Mobile number"), mobile), el("div", {}, el("label", {}, "E-mail ID"), el("p", { class: "mono", style: "margin:8px 0" }, S.me.email))),
    err, el("div", { class: "row" }, btn));
  }

  // ---- step 2
  function enrolBody() {
    const list = recs();
    if (!S.info.enrolOpen && !list.length) return [el("p", { class: "note warn" }, "Enrolment is closed for this list.")];
    const parts = [];
    if (list.length && !S.adding) {
      const r = cur();
      parts.push(el("p", { class: "big" }, r.status === "invited" ? "The list team has prepared your details. Please check them in the next step." : "You are enrolled for "), list.length > 1 ? chipsFor(list) : el("p", {}, el("b", {}, `${r.unit}, as ${window.VL.cap(r.capacity)}`), r.proxyFor ? ` for ${r.proxyFor}` : ""));
      if (S.info.enrolOpen && list.length < 5) parts.push(el("div", { class: "row" }, el("button", { class: "btn ghost", type: "button", on: { click: () => { S.adding = true; draw("enrol"); } } }, "Add another flat or house")));
      return parts;
    }
    parts.push(el("p", { class: "muted" }, S.adding ? "Add another flat or house you own, rent or look after." : "Please tell us about the flat or house you are enrolling for."),
      recordForm(null, { cta: "Save and continue", save: async (b) => { const x = await api("POST", A("/records"), b); S.adding = false; await loadMe(); S.rid = x.id; S.open = null; S.justMoved = true; draw(); } }));
    if (S.adding) parts.push(el("button", { class: "btn ghost", type: "button", on: { click: () => { S.adding = false; draw("enrol"); } } }, "Cancel"));
    return parts;
  }
  function chipsFor(list) {
    return el("div", { class: "chips", role: "group", "aria-label": "Which home" }, list.map((x) => el("button", { class: "chip", type: "button", "aria-pressed": String(x.id === (cur() || {}).id), on: { click: () => { S.rid = x.id; draw(); } } }, x.unit)));
  }
  const homeChips = () => (recs().length > 1 ? [el("p", { class: "tiny muted" }, "Which home?"), chipsFor(recs())] : []);

  // ---- step 3
  function confirmBody() {
    const r = cur(), err = window.VL.err();
    if (!r) return [];
    if (sent(r)) return [...homeChips(), el("p", { class: "note ok" }, r.status === "approved" ? "Approved. You are on the list." : "Sent. The list team will check it."), el("p", {}, r.next)];
    const consent = el("input", { id: "cs", type: "checkbox" });
    const btn = el("button", { class: "btn brass big", type: "submit" }, r.status === "sent_back" ? "Send again" : "Send to the list team");
    const needsLetter = r.needsProxyLetter, needsDoc = S.info.docsRequired && !r.docs.length;
    return [...homeChips(),
      r.status === "sent_back" ? el("div", { class: "note bad" }, el("b", {}, "The list team sent this back to you. "), r.reason || "Please check your details.", el("br"), "Please change what is needed in Step 4 (details) or Step 5 (documents), then send it again here.") : null,
      el("p", {}, "Please check what you are sending:"),
      summary(r),
      needsLetter || needsDoc ? el("div", { class: "note warn" }, needsLetter ? "A proxy needs the owner's signed Proxy Nomination Form. Please add it below." : "This list asks for one supporting document. Please add it below.") : null,
      needsLetter || needsDoc ? docsBody() : null,
      el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); if (!consent.checked) { err.show("Please tick the box to say you agree."); consent.focus(); return; }
        await window.VL.busy(btn, async () => { btn.textContent = "Sending…"; try { await api("POST", A(`/records/${r.id}/confirm`), { consent: true }); await loadMe(); S.open = null; S.justMoved = true; draw(); toast("Sent to the list team."); } catch (x) { err.show(x.message); } }); } } },
      el("div", { class: "note" }, el("label", { style: "display:flex;gap:10px;align-items:flex-start;font-weight:400" }, consent, el("span", {}, "I agree that these details are used to build this society's voter list. The list team, its hosts and the Townhall Records host who helps societies check records can see them. The public list shows my flat number, my role and a masked name, mobile number and e-mail ID. I can withdraw my record while the list is open."))),
      el("details", { class: "small", style: "margin:8px 0" }, el("summary", {}, "How your details are looked after"),
        el("ul", {}, el("li", {}, "Used only to build and check this society's voter list."), el("li", {}, "Kept safely with the list, for as long as your society keeps its voter records. A signed fingerprint of each final list stays, so that nobody can change it later."),
          el("li", {}, "You may ask to see or correct your details, and you may withdraw your record until the list is final. Your contact is the Organizer: the person who shared this link. Every correction is written to a signed trail. A record you withdraw yourself is cleared after 30 days."),
          el("li", {}, "Any document you add can be opened only by the list team, and each opening is logged."), el("li", {}, "A final list that was already signed stays exactly as it was, so a later withdrawal takes effect from the next list."))),
      err, el("div", { class: "row" }, btn)),
      el("p", { class: "tiny muted" }, "What happens next: the list team checks your record. You can see the answer in Step 6.")];
  }
  const summary = (r) => el("dl", { class: "kv" }, el("dt", {}, "Flat or house"), el("dd", {}, r.unit), el("dt", {}, "Name"), el("dd", {}, r.name), el("dt", {}, "Role"), el("dd", {}, window.VL.cap(r.capacity) + (r.proxyFor ? ` for ${r.proxyFor}` : "")), el("dt", {}, "Mobile"), el("dd", {}, r.mobile), el("dt", {}, "E-mail ID"), el("dd", {}, r.email));

  // ---- step 4
  function detailsBody() {
    const r = cur(); if (!r) return [];
    const editable = r.canEdit && (S.info.enrolOpen || false);
    const parts = [...homeChips(), summary(r)];
    if (r.whatIsOnTheList) parts.push(el("p", { class: "note" }, "Your earlier approved details stay on the list until your change is checked."));
    if (!editable) { parts.push(el("p", { class: "muted" }, S.info.enrolOpen ? "These details cannot be changed right now." : "Details cannot be changed after the closing time.")); return parts; }
    parts.push(el("h3", {}, "Change your details"), recordForm(r, { cta: "Save my changes", save: async (b) => { const x = await api("PATCH", A(`/records/${r.id}`), b); await loadMe(); S.open = r.status === "sent_back" ? "confirm" : "status"; S.justMoved = false; draw(S.open); toast(x.status === "submitted" ? "Saved. It goes for a fresh check." : "Saved."); } }));
    return parts;
  }

  // ---- step 5
  function docsBody() {
    const r = cur(); if (!r) return [];
    const err = window.VL.err(); const max = r.docsMax || 3;
    const uidn = "-" + (S.open || "x"); // the same form can be on the page in two steps at once: ids must differ
    const type = el("select", { id: "dt" + uidn }, (r.status === "approved" ? ["Proxy Nomination Form"] : DOCS).map((d) => el("option", { value: d, selected: d === (r.capacity === "Proxy" && !r.docs.some((x) => x.docType === "Proxy Nomination Form") ? "Proxy Nomination Form" : r.capacity === "Tenant" ? "Rent Agreement" : "Sale Deed or Share Certificate") }, d)));
    const file = el("input", { id: "fl" + uidn, type: "file", accept: ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" });
    const btn = el("button", { class: "btn", type: "button" }, "Add this document");
    btn.addEventListener("click", async () => {
      err.clear(); const f = file.files[0]; if (!f) { err.show("Please choose a file first."); return; }
      if (f.size > 400 * 1024) { err.show("That file is larger than 400 KB. Please use a smaller scan or photo."); return; }
      const mime = f.type || (/\.pdf$/i.test(f.name) ? "application/pdf" : ""); if (!["application/pdf", "image/jpeg", "image/png"].includes(mime)) { err.show("Please choose a PDF, JPG or PNG file."); return; }
      await window.VL.busy(btn, async () => {
        btn.textContent = "Adding…";
        try {
          const b64 = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1] || ""); fr.onerror = () => no(new Error("That file could not be read.")); fr.readAsDataURL(f); });
          await api("POST", A(`/records/${r.id}/docs`), { docType: type.value, filename: f.name, mime, base64: b64 }); await loadMe(); draw(S.open || "docs"); toast("Document added.");
        } catch (x) { err.show(x.message); }
      });
    });
    return [...(S.open === "confirm" ? [] : homeChips()),
      el("p", { class: "muted" }, `You can add up to ${max} documents (PDF, JPG or PNG, 400 KB each). Please cover any Aadhaar or other ID number before you add a photo or scan.`),
      r.docs.length ? el("ul", { class: "docs", style: "list-style:none;padding:0" }, r.docs.map((d) => el("li", {}, el("span", {}, el("b", {}, d.docType), " ", el("span", { class: "muted small" }, d.filename)),
        el("a", { class: "btn ghost small", href: A(`/records/${r.id}/docs/${d.id}`), target: "_blank", rel: "noopener" }, "View"),
        r.status !== "approved" ? el("button", { class: "btn ghost small", type: "button", on: { click: async () => { try { await api("DELETE", A(`/records/${r.id}/docs/${d.id}`)); await loadMe(); draw(S.open || "docs"); } catch (x) { fail(x); } } } }, "Remove") : null))) : el("p", { class: "muted" }, "No documents added yet."),
      r.docs.length >= max ? el("p", { class: "note" }, "You have added the most documents allowed. Remove one to add another.") : [el("label", { for: "dt" + uidn }, "What is this document?"), type, el("label", { for: "fl" + uidn }, "The file"), file, err, el("div", { class: "row" }, btn)],
      r.status === "approved" ? el("p", { class: "tiny muted" }, "Your record is approved, so its documents are kept as they are. If you want to become a proxy, you can still add the owner's Proxy Nomination Form here; then change your role in Step 4.") : null];
  }

  // ---- step 6
  const WHAT = { created: ["You started your record", ""], confirmed: ["You sent it to the list team", ""], edited: ["You changed your details", ""], resubmitted: ["You sent it again", ""], approved: ["Approved. You are on the list", "ok"], sent_back: ["Sent back to you", "bad"], withdrawn: ["You withdrew your record", ""], removed: ["Removed by the list team", "bad"], doc_added: ["You added a document", ""], doc_removed: ["You removed a document", ""], imported: ["The list team prepared your record", ""], added: ["The list team added your record", ""], corrected: ["The list team corrected a detail", ""], undone: ["A change by the list team was undone", ""] };
  function statusBody() {
    const r = cur(); if (!r) return [];
    const tone = r.status === "approved" ? "ok" : r.status === "sent_back" ? "bad" : "";
    return [...homeChips(),
      el("p", {}, el("span", { class: "badge " + (tone || "info") }, statusWord(r)), r.onTheList ? el("span", { class: "badge ok", style: "margin-left:6px" }, "On the list") : null),
      r.status === "sent_back" ? el("div", { class: "note bad" }, el("b", {}, "Why it was sent back: "), r.reason) : null,
      r.vote ? (r.vote.allowed ? el("div", { class: "note ok" }, "As the list stands now, you are allowed to vote.") : el("div", { class: "note bad" }, el("b", {}, "As the list stands now, you are not allowed to vote."), " ", r.vote.reason, el("div", { class: "small" }, "If this is wrong, please ask the Organizer of the list."))) : null,
      el("div", { class: "next" }, el("b", {}, "What happens next. "), r.next),
      r.status === "sent_back" ? el("div", { class: "row" }, el("button", { class: "btn brass", type: "button", on: { click: () => go("details") } }, "Fix my details")) : null,
      el("h3", {}, "History"), el("ol", { class: "timeline" }, r.timeline.map((t) => { const w = WHAT[t.what] || [t.what, ""]; return el("li", { class: w[1] }, el("b", {}, w[0]), " ", el("span", { class: "muted small" }, window.VL.fmtDate(t.at)), t.reason && t.what === "sent_back" ? el("div", { class: "small" }, "Reason: " + t.reason) : null); })),
      r.canWithdraw ? el("div", { class: "row" }, el("button", { class: "btn ghost small", type: "button", on: { click: async () => { if (!(await window.VL.confirm("Withdraw this record?", "It will no longer be considered for the list, and its details are cleared after 30 days. You can enrol again before the closing time.", "Yes, withdraw"))) return; try { await api("POST", A(`/records/${r.id}/withdraw`), {}); await loadMe(); S.open = null; draw(); toast("Withdrawn."); } catch (x) { fail(x); } } } }, "Withdraw my record")) : null];
  }

  // ---- step 7
  function listBody() {
    const p = S.info.shown;
    if (!S.pub.loaded) { loadPub().then(() => { if (S.open === "list") draw("list"); }).catch(() => {}); return [el("p", { class: "muted" }, "Loading…")]; }
    if (!p) return [el("p", {}, "The list has not been published yet. When the list team publishes it, you will find it here with your name masked as ", el("span", { class: "mono" }, "Ra**** Sh****"), ".")];
    const q = el("input", { id: "q", type: "search", placeholder: "Search by flat number, e.g. A-101", value: S.pub.q, "aria-label": "Search by flat number" });
    let t; q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(async () => { await loadPub(q.value.trim()); const pos = q.selectionStart; draw("list"); const n = document.getElementById("q"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 350); });
    return [el("p", { class: "note " + (p.provisional ? "warn" : "ok") }, p.provisional ? `Provisional list ${p.seq}, published ${window.VL.fmtDate(p.publishedAt)}. It may still change.` : `Final list${p.event ? " for " + p.event : ""}, frozen at the cut-off of ${window.VL.localTime(p.cutoffLocal)}. It cannot change.`),
      el("p", { class: "small muted" }, `${(p.provisional && !S.pub.q ? S.pub.total : p.people)} ${(p.provisional && !S.pub.q ? S.pub.total : p.people) === 1 ? "person" : "people"}${p.provisional ? "" : ` in ${p.units} ${p.units === 1 ? "flat" : "flats"}`}. Fingerprint `, el("span", { class: "mono" }, p.fingerprintShort), ". Names, mobile numbers and e-mail IDs are masked."),
      q,
      S.pub.rows.length ? window.VL.table(S.pub.rows.some((x) => x.reason) ? ["Flat", "Name", "Role", "May vote", "Why not", "Mobile", "E-mail ID"] : ["Flat", "Name", "Role", "May vote", "Mobile", "E-mail ID"], S.pub.rows.map((x) => el("tr", {}, el("td", {}, x.unit), el("td", {}, x.name), el("td", {}, x.capacity + (x.forOwner ? " for " + x.forOwner : "")), el("td", {}, x.mayVote ? "Yes" : "No"), S.pub.rows.some((y) => y.reason) ? el("td", {}, x.reason || "") : null, el("td", { class: "mono" }, x.mobile), el("td", { class: "mono" }, x.email)))) : el("p", { class: "muted" }, S.pub.q ? "No one is listed for that flat." : "No one is listed."),
      S.pub.rows.length < S.pub.total ? el("div", { class: "row" }, el("button", { class: "btn ghost", type: "button", on: { click: async () => { await loadPub(undefined, true); draw("list"); } } }, `Show more (${S.pub.total - S.pub.rows.length} left)`)) : null,
      el("div", { class: "row" }, el("a", { class: "btn ghost small", href: A("/list.pdf") }, "Download PDF"), el("a", { class: "btn ghost small", href: A("/list.csv") }, "Download CSV"),
        !p.provisional ? el("button", { class: "btn ghost small", type: "button", on: { click: () => showProof() } }, "Check the proof") : null),
      (S.info.earlierFinal || []).length ? el("div", {}, el("h3", {}, "Earlier final lists"), el("p", { class: "small muted" }, "These were signed earlier and stay exactly as they were."),
        S.info.earlierFinal.map((e) => el("div", { class: "row", style: "align-items:center" }, el("span", { class: "small" }, `Final list ${e.seq}${e.event ? " for " + e.event : ""}, frozen ${window.VL.localTime(e.cutoffLocal)}`),
          el("a", { class: "btn ghost small", href: A("/list.pdf?pub=" + encodeURIComponent(e.id)) }, "PDF"), el("button", { class: "btn ghost small", type: "button", on: { click: () => showProof(e.id) } }, "Check the proof")))) : null];
  }
  async function showProof(pubId) {
    try {
      const x = await api("GET", A("/proof" + (pubId ? "?pub=" + encodeURIComponent(pubId) : "")));
      window.VL.show("Proof of the final list", el("p", { class: x.ok ? "note ok" : "note bad" }, x.ok ? "The list matches its fingerprint, and the signature is valid." : "The proof does not match. Please tell the Organizer."),
        el("dl", { class: "kv" }, el("dt", {}, "Fingerprint"), el("dd", { class: "hash" }, x.fingerprint), el("dt", {}, "Signature"), el("dd", {}, x.signature.valid ? "Valid (Ed25519)" : "Not valid"), el("dt", {}, "Signed at entry"), el("dd", {}, "#" + x.signature.auditSeq), el("dt", {}, "Public key"), el("dd", { class: "hash" }, x.signature.publicKey)));
    } catch (e) { fail(e); }
  }

  // ------------------------------------------------------------------------------------------------ start
  (async function init() {
    if (!/^[0-9a-f]{16}$/.test(slug)) { root.replaceChildren(el("div", { class: "page" }, el("h1", {}, "This link is not valid"), el("p", {}, "Please ask the person who shared it for the correct link."))); return; }
    try { await loadInfo(); } catch (e) { root.replaceChildren(el("div", { class: "page" }, el("h1", {}, "This link is not valid"), el("p", {}, "Please ask the person who shared it for the correct link."))); return; }
    document.title = S.info.name + " | Voter List";
    if (S.info.erased) { root.replaceChildren(el("div", { class: "page" }, el("h1", {}, S.info.name), el("p", { class: "note" }, "This list is closed and its personal details have been erased as planned."))); return; }
    await loadMe().catch(() => {}); draw();
  })();
})();
