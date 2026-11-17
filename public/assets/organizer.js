// The Organizer's and Hosts' single page: sign in, pick or create a list, then Steps 1 to 7 top to bottom.
// Steps 1 to 3 live here; Steps 4 to 7 and the extras are in organizer-work.js (they share window.OR).
(function () {
  const { el, api, toast, fail } = window.VL;
  const root = document.getElementById("app");
  const OR = (window.OR = { S: { me: null, sid: null, ov: null, open: null, codeSent: false, email: "", creating: false }, body: {}, extras: () => [] });
  const S = OR.S;
  const WHATS = { "list.created": "List created", "list.updated": "Settings changed", "list.reopened": "List reopened for a new round", "list.erased": "Personal details erased", "enrolment.closed": "Enrolment closed", "member.signed_in": "A voter signed in", "staff.signed_in": "The team signed in", "record.created": "A voter started a record", "record.confirmed": "A voter sent a record", "record.edited": "A record was changed", "record.resubmitted": "A voter sent a record again", "record.withdrawn": "A voter withdrew a record", "record.added": "A record was added by the team", "record.corrected": "A record was corrected by the team", "record.opened": "A record was opened", "record.approved": "A record was approved", "record.sent_back": "A record was sent back", "records.approved": "Records were approved", "records.sent_back": "Records were sent back", "records.imported": "A list was uploaded", "records.removed": "Records were removed", "records.undone": "An action was undone", "records.weighted": "Vote weights were set", "unit.voter_chosen": "Who votes for a flat was chosen", "unit.voter_choice_undone": "An authorization to vote was taken back", "unit.voter_authorized": "A person was authorized to vote", "unit.voter_unauthorized": "A person's authorization to vote was taken away", "doc.added": "A document was added", "doc.removed": "A document was removed", "doc.opened": "A document was opened", "publication.draft": "Draft list published", "publication.frozen": "Final list frozen", "team.host_added": "A host was added", "team.host_removed": "A host was removed", "team.organizer_changed": "The Organizer role was handed over", "export.full": "Full list downloaded", "export.masked": "Masked list downloaded", "order.created": "Order started", "order.test_paid": "Test payment" };
  OR.words = (t) => WHATS[t] || t;
  OR.isOrg = () => S.ov && S.ov.role === "organizer";
  const roleWord = () => (S.ov ? (S.ov.permanentHost ? "Townhall Records host" : S.ov.role === "organizer" ? "Organizer" : "Host") : "");

  // ------------------------------------------------------------------------------------------------ boot, sign-in, list switching
  async function boot() {
    try { S.me = await api("GET", "/api/me"); } catch (e) { if (e.status !== 401) { fail(e); return; } S.me = null; }
    if (!S.me) { drawSignIn(); return; }
    const want = (location.hash.match(/^#\/(soc_[0-9a-f]+)/) || [])[1];
    S.sid = S.me.lists.some((l) => l.id === want) ? want : S.me.lists[0] ? S.me.lists[0].id : null;
    S.creating = !S.sid;
    if (S.sid) await reload(); else draw();
  }
  async function reload(openKey) {
    S.ov = await api("GET", `/api/lists/${S.sid}`);
    if (openKey !== undefined) S.open = openKey;
    draw();
  }
  OR.reload = reload;
  function drawSignIn() {
    const err = window.VL.err(); const web = [];
    if (!S.codeSent) {
      const em = el("input", { id: "em", type: "email", autocomplete: "email", required: true, value: S.email, placeholder: "name@example.com" });
      const btn = el("button", { class: "btn brass big", type: "submit" }, "Send me a code"); const cap = window.VL.captcha();
      web.push(el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); S.email = em.value.trim(); await window.VL.busy(btn, async () => { try { await api("POST", "/api/auth/start", { email: S.email, turnstileToken: cap.token() }); S.codeSent = true; drawSignIn(); devHint(); } catch (x) { err.show(x.message); cap.reset(); } }); } } },
        el("label", { for: "em" }, "Your e-mail ID"), em, cap.node, err, el("div", { class: "row" }, btn), el("p", { class: "tiny muted" }, "New to Voter List? Townhall Records sets up each Organizer first. Please ask us to add your e-mail ID, and you can begin right away. Hosts invited by an Organizer can sign in straight away.")));
    } else {
      const cd = el("input", { id: "cd", class: "codebox", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "14", required: true, placeholder: "000000" });
      const btn = el("button", { class: "btn brass big", type: "submit" }, "Continue");
      web.push(el("p", {}, "If this e-mail ID is set up, a 6-digit code is on its way to ", el("b", {}, S.email), ". It works for 10 minutes. Please check Spam too, or try again a little later."), el("p", { id: "devhint", class: "note hidden" }),
        el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); await window.VL.busy(btn, async () => { try { await api("POST", "/api/auth/verify", { email: S.email, code: cd.value }); S.codeSent = false; await boot(); } catch (x) { err.show(x.message); cd.focus(); } }); } } },
          el("label", { for: "cd" }, "The code"), cd, el("p", { class: "tiny muted" }, "You can paste it, with or without spaces."), err,
          el("div", { class: "row" }, btn, el("button", { class: "btn ghost", type: "button", on: { click: () => { S.codeSent = false; drawSignIn(); } } }, "Use a different e-mail ID"))));
    }
    root.replaceChildren(el("div", { class: "page" }, el("div", { class: "hero" }, el("h1", {}, "Voter List for your society"), el("p", { class: "muted" }, "Build, check, publish and freeze the voter list for your meeting or election. For Organizers and Hosts.")),
      el("section", { class: "step now" }, el("header", {}, el("span", { class: "dot now" }, "1"), el("h2", {}, "Sign in")), el("div", { class: "body" }, web)),
      el("p", { class: "tiny muted center" }, "Voters do not sign in here. They use the link you share with them.")));
    document.getElementById("who").replaceChildren();
  }
  async function devHint() {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    try { const j = await (await fetch(`/dev/code?to=${encodeURIComponent(S.email)}`)).json(); const n = document.getElementById("devhint"); if (n && j.code) { n.textContent = "Test mode: your code is " + j.code; n.classList.remove("hidden"); } } catch { /* not the dev server */ }
  }
  async function signOut() { try { await api("POST", "/api/auth/logout", {}); } catch { /* already out */ } S.me = null; S.ov = null; S.sid = null; drawSignIn(); }

  // ------------------------------------------------------------------------------------------------ the page
  function stepsFor() {
    const ov = S.ov, d = ov.steps.done, cur = ov.steps.current, org = ov.role === "organizer", frozen = ov.list.phase === "frozen";
    const st = (k) => (d[k] ? "done" : cur === k ? "now" : "todo");
    const mk = (key, short, title, o) => ({ key, short, title, open: S.open === key, ...o });
    const c = ov.counts;
    return [
      mk("setup", "Set up", "Step 1. Set up your list", { state: st("setup"), summary: `${ov.list.kind}, ${(ov.rules.find((r) => r.code === ov.list.ruleCode) || {}).name || ""}`, body: OR.body.setup }),
      mk("share", "Share", "Step 2. Share the link", { state: st("share"), summary: d.share ? "Link ready to share" : "", body: OR.body.share }),
      mk("team", "Team", "Step 3. Your team", { state: st("team"), summary: `${ov.team.hostsUsed} of ${ov.team.max} hosts`, body: OR.body.team }),
      mk("review", "Check", "Step 4. Check the records", { state: st("review"), summary: `${c.submitted} waiting, ${c.approved} approved`, body: OR.body.review }),
      mk("checks", "Final checks", "Step 5. Final checks", { state: st("checks"), summary: ov.checks.errors ? `${ov.checks.errors} to fix` : ov.checks.warnings ? `${ov.checks.warnings} to look at` : ov.checks.onList ? "All clear" : "", body: OR.body.checks }),
      mk("draft", "Draft", "Step 6. Publish the draft list", { state: !org ? "locked" : ov.checks.onList ? st("draft") : "locked", lockedNote: !org ? "Only the Organizer publishes" : "Opens when someone is approved", summary: d.draft ? "Draft published" : "", body: OR.body.draft }),
      mk("frozen", "Final", "Step 7. Publish the final list", { state: !org ? "locked" : frozen ? "done" : ov.checks.canFreeze ? st("frozen") : "locked", lockedNote: !org ? "Only the Organizer publishes" : "Opens when the checks in Step 5 are clear", summary: frozen ? "Frozen" : "", body: OR.body.frozen }),
    ];
  }
  OR.go = (key) => { S.open = key; draw(key); };
  function draw(focusKey) {
    const who = document.getElementById("who");
    who.replaceChildren(S.me ? el("span", {}, S.me.email) : null, S.me ? el("button", { class: "btn ghost small", type: "button", on: { click: signOut } }, "Sign out") : null);
    if (S.creating || !S.ov) {
      root.replaceChildren(el("div", { class: "page" }, el("div", { class: "hero" }, el("h1", {}, "Let us set up your voter list"), el("p", { class: "muted" }, "It takes about two minutes. You can change most things later.")),
        el("section", { class: "step now" }, el("header", {}, el("span", { class: "dot now" }, "1"), el("h2", {}, "Step 1. Set up your list")), el("div", { class: "body" }, OR.body.setup()))));
      return;
    }
    const ov = S.ov, steps = stepsFor();
    const switcher = S.me.lists.length > 1 ? el("div", { class: "row" }, el("label", { for: "sw", class: "tiny" }, "Your lists"), el("select", { id: "sw", on: { change: async (e) => { S.sid = e.target.value; location.hash = "#/" + S.sid; S.open = null; await reload(); } } }, S.me.lists.map((l) => el("option", { value: l.id, selected: l.id === S.sid }, l.name)))) : null;
    const newBtn = ov.role === "organizer" || true ? el("button", { class: "btn ghost small", type: "button", on: { click: () => { S.creating = true; S.ov = null; draw(); } } }, "Start another list") : null;
    const frozenNote = ov.list.phase === "frozen" ? el("p", { class: "note ok" }, "This list is frozen. Its records are fixed. Step 7 has the final list and the way to reopen it for a new meeting.") : null;
    const page = el("div", { class: "page" }, el("div", { class: "hero" }, el("h1", {}, ov.list.name), el("p", { class: "muted" }, "You are signed in as ", el("b", {}, roleWord()), ov.masked ? ". Names, mobiles and e-mail IDs are masked for you until you open a record." : "."), switcher, el("div", { class: "row" }, newBtn)),
      frozenNote, window.VL.stepbar(steps, OR.go), window.VL.stepcards(steps, OR.go), ...OR.extras());
    root.replaceChildren(page);
    if (focusKey) window.VL.focusStep(focusKey);
  }
  OR.draw = draw;

  // ------------------------------------------------------------------------------------------------ Step 1: set up
  OR.body.setup = function () {
    const ov = S.ov, L = ov ? ov.list : null, creating = !ov, org = creating || ov.role === "organizer", frozen = L && L.phase === "frozen";
    const rules = creating ? S.me.rules : ov.rules;
    const err = window.VL.err();
    const f = {
      name: el("input", { id: "ln", type: "text", required: true, maxlength: "120", value: L ? L.name : "", placeholder: "e.g. Sample Heights Residents Welfare Association" }),
      kind: el("select", { id: "lk" }, (creating ? S.me.kinds : ["RWA", "AOA", "HOA", "Co-operative society", "Others"]).map((k) => el("option", { value: k, selected: L ? L.kind === k : k === "RWA" }, k))),
      kindOther: el("input", { id: "lo", type: "text", maxlength: "60", value: L ? L.kindOther : "", placeholder: "What kind of body is it?" }),
      state: el("input", { id: "ls", type: "text", maxlength: "60", value: L ? L.state : "", placeholder: "e.g. Karnataka" }),
      regNo: el("input", { id: "lr", type: "text", maxlength: "60", value: L ? L.regNo : "" }),
      regOffice: el("input", { id: "lg", type: "text", maxlength: "100", value: L ? L.regOffice : "" }),
      cutoff: el("input", { id: "lc", type: "datetime-local", value: L && L.cutoffLocal ? L.cutoffLocal : "" }),
      docs: el("input", { id: "ld", type: "checkbox", checked: !!(L && L.docsRequired) }),
      weight: el("select", { id: "lw" }, [["equal", "Equal: every flat has the same weight"], ["unequal", "Votes are weighted (for example by share of the building)"]].map(([v, t]) => el("option", { value: v, selected: L ? L.weightMode === v : v === "equal" }, t))),
      reasonPublic: el("select", { id: "lq" }, [["role", "Only reasons that follow from the role (for example Tenant or Co-owner). Dues and your own notes stay private."], ["none", "No reasons at all on the public list"], ["all", "Every reason, including unpaid dues and your own notes"]].map(([v, t]) => el("option", { value: v, selected: (L && L.reasonPublic ? L.reasonPublic : "role") === v }, t))),
    };
    let rule = L ? L.ruleCode : 2;
    const ruleBox = el("div", { class: "choices" }, rules.map((r) => el("label", {}, el("input", { type: "radio", name: "rule", value: r.code, checked: r.code === rule, on: { change: () => { rule = r.code; } } }), el("span", {}, r.name, el("small", {}, r.blurb + (r.proxy ? " A signed proxy form is needed." : ""))))));
    const kindSync = () => { f.kindOther.parentElement.classList.toggle("hidden", f.kind.value !== "Others"); }; f.kind.addEventListener("change", kindSync);
    const btn = el("button", { class: "btn brass big", type: "submit" }, creating ? "Create my list and get my link" : "Save");
    const dis = !org || frozen;
    const form = el("form", { on: { submit: async (e) => {
      e.preventDefault(); err.clear();
      const body = { name: f.name.value, kind: f.kind.value, kindOther: f.kindOther.value, state: f.state.value, country: "India", regNo: f.regNo.value, regOffice: f.regOffice.value, ruleCode: rule, weightMode: f.weight.value, reasonPublic: f.reasonPublic.value, docsRequired: f.docs.checked, cutoff: f.cutoff.value || null };
      await window.VL.busy(btn, async () => {
        try {
          if (creating) { const x = await api("POST", "/api/lists", body); S.me = await api("GET", "/api/me"); S.sid = x.list.id; location.hash = "#/" + S.sid; S.creating = false; await reload("share"); window.VL.focusStep("share"); toast("Your list is ready. Here is your link."); }
          else { await api("PATCH", `/api/lists/${S.sid}`, body); S.me = await api("GET", "/api/me"); await reload("setup"); toast("Saved."); }
        } catch (x) { err.show(x.message); }
      });
    } } },
    el("label", { for: "ln" }, "Name of the society or association"), f.name,
    el("div", { class: "fieldrow" }, el("div", {}, el("label", { for: "lk" }, "Kind"), f.kind), el("div", {}, el("label", { for: "ls" }, "State"), f.state)),
    el("div", {}, el("label", { for: "lo" }, "Kind (please describe)"), f.kindOther),
    el("div", { class: "fieldrow" }, el("div", {}, el("label", { for: "lr" }, "Registration number (optional)"), f.regNo), el("div", {}, el("label", { for: "lg" }, "Registering office (optional)"), f.regOffice)),
    el("fieldset", { style: "border:0;padding:0;margin:10px 0" }, el("legend", { class: "big", style: "font-weight:600" }, "Who may vote?"), ruleBox, el("p", { class: "tiny muted" }, "Please choose what your bye-laws say. Your registrar or a lawyer can confirm it.")),
    el("label", { for: "lw" }, "How are votes counted?"), f.weight,
    el("label", { for: "lq" }, "When someone is not allowed to vote, what may the public list say?"), f.reasonPublic, el("p", { class: "tiny muted" }, "You and your Hosts always see the reason, and so does the person, when they look up their own status. This only decides what everyone else can read on the published list. It applies when you publish the next draft or the final list; a draft that is already public stays as it was until you publish it again."),
    el("label", { for: "lc" }, "Enrolment closes on (optional)"), f.cutoff, el("p", { class: "tiny muted" }, "Voters can enrol and change their details until this time. You can also close it yourself later."),
    !creating && !dis && !(L && L.cutoffAt && L.cutoffAt <= Date.now()) ? el("div", { class: "row" }, el("button", { class: "btn ghost small", type: "button", on: { click: async () => {
      if (!(await window.VL.confirm("Close enrolment now?", "Voters will no longer be able to enrol or change their details. You can still check what was sent.", "Yes, close it"))) return;
      try { await api("PATCH", `/api/lists/${S.sid}`, { closeNow: true }); S.me = await api("GET", "/api/me"); await reload("setup"); toast("Enrolment is closed."); } catch (x) { fail(x); } } } }, "Close enrolment now")) : null,
    !creating && L && L.cutoffAt && L.cutoffAt <= Date.now() ? el("p", { class: "note" }, "Enrolment is closed. People can no longer be added; you can still check and publish.") : null,
    el("label", { style: "display:flex;gap:10px;align-items:center;font-weight:400" }, f.docs, "Ask every voter for one supporting document"),
    err, el("div", { class: "row" }, dis ? null : btn));
    kindSync();
    if (dis) form.querySelectorAll("input,select").forEach((n) => { n.disabled = true; });
    return [el("p", { class: "muted" }, creating ? "You will become the Organizer of this list. Townhall Records also keeps a standing host seat on every list to help check records." : frozen ? "The list is frozen, so settings are fixed." : !org ? "Only the Organizer can change these settings." : "What happens next: you get one link to share with every voter."), form];
  };

  // ------------------------------------------------------------------------------------------------ Step 2: the link, and an optional upload
  OR.body.share = function () {
    const ov = S.ov, url = location.origin + ov.list.link, org = ov.role === "organizer";
    const msg = `Please enrol for the voter list of ${ov.list.name} here: ${url}`;
    const up = uploadBox();
    return [el("p", { class: "big" }, "One link for everyone. Voters sign in with their e-mail ID and a 6-digit code."),
      el("div", { class: "linkbox" }, el("input", { type: "text", readonly: true, value: url, "aria-label": "The voter link", on: { focus: (e) => e.target.select() } }), el("button", { class: "btn", type: "button", on: { click: () => window.VL.copy(url) } }, "Copy the link")),
      el("div", { class: "row" }, el("a", { class: "btn ghost", href: "https://wa.me/?text=" + encodeURIComponent(msg), target: "_blank", rel: "noopener" }, "Share on WhatsApp"), el("a", { class: "btn ghost", href: ov.list.link, target: "_blank", rel: "noopener" }, "Open the voter page"),
        org && !ov.steps.done.share ? el("button", { class: "btn brass", type: "button", on: { click: async () => { try { await api("POST", `/api/lists/${S.sid}/step/link_shared`, {}); await OR.reload("team"); window.VL.focusStep("team"); } catch (x) { fail(x); } } } }, "I have shared the link") : null),
      el("p", { class: "tiny muted" }, "What happens next: voters enrol, and their records appear in Step 4 for you to check."),
      el("p", { class: "tiny muted" }, "A tip for busy days: people you upload or add here are already known to the list, so their codes never wait. New people who find the link themselves share 25 codes a day."),
      ov.list.phase === "open" ? up : null];
  };
  function uploadBox() {
    const err = window.VL.err(); const out = el("div"); const ta = el("textarea", { id: "up", placeholder: "Or paste rows here: Flat, Name, Role, Mobile, E-mail", style: "min-height:90px" }); const file = el("input", { id: "uf", type: "file", accept: ".csv,.xlsx" });
    const send = async (dry) => {
      err.clear(); const f = file.files[0]; let body;
      try {
        if (f) { if (/\.xlsx$/i.test(f.name)) { const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = no; r.readAsDataURL(f); }); body = { format: "xlsx", base64: b64, filename: f.name }; } else body = { format: "csv", text: await f.text(), filename: f.name }; }
        else if (ta.value.trim()) body = { format: "paste", text: ta.value }; else { err.show("Please choose a file or paste some rows."); return; }
        const x = await api("POST", `/api/lists/${S.sid}/records/import`, { ...body, dryRun: dry });
        if (dry) {
          window.VL.fill(out, el("div", { class: "note" }, el("b", {}, `${x.willAdd} people will be invited`), `, out of ${x.read} rows read.`, " Skipped: ", Object.entries(x.skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${({ duplicate: "already there", noEmail: "without a usable e-mail ID", noUnit: "without a flat", notAllowed: "with a role this list does not allow", noName: "without a name", badUnit: "with a flat or member ID that could not be used (too long, odd characters, or a phone number or e-mail ID)" })[k]}`).join(", ") || "none", "."),
            x.problems.length ? el("ul", { class: "small" }, x.problems.slice(0, 8).map((p) => el("li", {}, typeof p === "string" ? p : p.message || JSON.stringify(p)))) : null,
            x.willAdd ? el("div", { class: "row" }, el("button", { class: "btn brass", type: "button", on: { click: () => send(false) } }, `Invite ${x.willAdd} people`)) : null);
        } else { toast(`${x.added} people invited. They will find their details ready when they sign in.`); await OR.reload("share"); }
      } catch (x) { err.show(x.message); }
    };
    return el("details", { style: "margin-top:12px" }, el("summary", { class: "big", style: "cursor:pointer" }, "Already have a list? Upload it (optional)"),
      el("p", { class: "small muted" }, "People you upload are invited, not approved. Each one signs in, checks their details and confirms. ", el("a", { href: "/api/template.xlsx" }, "Excel template"), " · ", el("a", { href: "/api/template.csv" }, "CSV template")),
      el("label", { for: "uf" }, "A CSV or Excel file"), file, ta, err, el("div", { class: "row" }, el("button", { class: "btn", type: "button", on: { click: () => send(true) } }, "Preview what will happen")), out);
  }

  // ------------------------------------------------------------------------------------------------ Step 3: the team
  OR.body.team = function () {
    const ov = S.ov, org = ov.role === "organizer"; const box = el("div", { class: "muted" }, "Loading…");
    const show = async () => {
      const t = await api("GET", `/api/lists/${S.sid}/team`);
      window.VL.fill(box, el("ul", { style: "list-style:none;padding:0;margin:0" }, t.team.map((m) => el("li", { class: "listrow" }, el("span", { class: "main" }, el("b", {}, m.email), " ", el("span", { class: "badge " + (m.role === "organizer" ? "info" : "") }, m.permanent ? "Townhall Records host" : m.role === "organizer" ? "Organizer" : "Host"), m.you ? el("span", { class: "tiny muted" }, " (you)") : null,
        m.permanent ? el("div", { class: "tiny muted" }, "A standing seat on every list. It does not use up one of your 10 host seats.") : null),
        org && !m.permanent && m.role === "host" ? [el("button", { class: "btn ghost small", type: "button", on: { click: async () => { if (!(await window.VL.confirm("Hand over the Organizer role?", `${m.email} becomes the Organizer, and you become a Host. Only the Organizer can publish.`, "Yes, hand over"))) return; try { await api("POST", `/api/lists/${S.sid}/team/organizer`, { email: m.email }); await OR.reload("team"); } catch (x) { fail(x); } } } }, "Make Organizer"),
          el("button", { class: "btn ghost small", type: "button", on: { click: async () => { if (!(await window.VL.confirm("Remove this host?", m.email, "Yes, remove"))) return; try { await api("DELETE", `/api/lists/${S.sid}/team/${encodeURIComponent(m.email)}`); await OR.reload("team"); } catch (x) { fail(x); } } } }, "Remove")] : null))),
        el("p", { class: "small" }, `${t.hostsUsed} of ${t.max} host seats used (the Townhall Records host is extra).`));
    };
    show().catch(fail);
    const err = window.VL.err(); const em = el("input", { id: "he", type: "email", autocomplete: "off", placeholder: "host@example.com" }); const btn = el("button", { class: "btn brass", type: "submit" }, "Add this host");
    const form = el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); await window.VL.busy(btn, async () => { try { const hx = await api("POST", `/api/lists/${S.sid}/team`, { email: em.value }); em.value = ""; await OR.reload("team"); toast(hx.mailed === false ? "Host added. The e-mail could not be sent today, so please tell them yourself." : "Host added. They were told by e-mail."); } catch (x) { err.show(x.message); } }); } } },
      el("label", { for: "he" }, "Add a host by e-mail ID"), em, err, el("div", { class: "row" }, btn));
    return [el("p", { class: "muted" }, org ? "A host checks records for you. You are the one Organizer. You can add up to 10 hosts, and Townhall Records keeps one standing host to help." : "This is your team. The Organizer adds and removes hosts. Townhall Records keeps one standing host to help."), box,
      org && ov.list.phase === "open" ? form : null,
      org && !ov.steps.done.team ? el("div", { class: "row" }, el("button", { class: "btn ghost", type: "button", on: { click: async () => { try { await api("POST", `/api/lists/${S.sid}/step/hosts_skipped`, {}); await OR.reload("review"); window.VL.focusStep("review"); } catch (x) { fail(x); } } } }, "Skip for now")) : null,
      !org ? el("p", { class: "tiny muted" }, "Only the Organizer can change the team.") : null];
  };

  (async function init() { await boot(); })();
})();
