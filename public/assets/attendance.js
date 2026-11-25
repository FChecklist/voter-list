// Attendance: the Organizer's and co-organizers' page. Sign in, pick a list (or upload a sheet), make a session, see who is marked, mark, close, download the sheet.
// Plain page, no framework. Every value goes in as text (no innerHTML). The server decides who may do what; the buttons only follow what the server says.
(function () {
  const { el, api, toast, fail } = window.VL;
  const root = document.getElementById("app");
  const S = { me: null, sid: null, sessions: [], sid2: null, detail: null, find: "", codeSent: false, email: "", open: "list", sheet: null };
  const list = () => (S.me ? S.me.lists.find((l) => l.id === S.sid) || null : null);
  const isOrg = () => !!list() && list().role === "organizer";
  const base = () => `/api/lists/${S.sid}/attendance/sessions`;
  const maskMail = (e) => e.replace(/^(.).*(@)(.).*(\..+)$/, "$1****$2$3****$4");
  const when = (s) => window.VL.localTime(s);
  const terms = () => el("a", { href: "/terms/", target: "_blank", rel: "noopener" }, "Terms and Conditions");

  async function boot() {
    try { S.me = await api("GET", "/api/attendance/lists"); } catch (e) { if (e.status !== 401) { fail(e); return; } S.me = null; }
    if (!S.me) { drawSignIn(); return; }
    const want = (location.hash.match(/^#\/(soc_[0-9a-f]+)/) || [])[1];
    S.sid = S.me.lists.some((l) => l.id === want) ? want : S.me.lists[0] ? S.me.lists[0].id : null;
    S.open = S.sid ? "sessions" : "list";
    if (S.sid) await loadSessions(); else draw();
  }
  async function loadSessions() {
    S.sessions = (await api("GET", base())).sessions;
    if (S.sid2) await loadDetail(S.sid2, true);
    draw();
  }
  async function loadDetail(id, quiet) {
    S.sid2 = id;
    try { S.detail = await api("GET", base() + "/" + id + "?find=" + encodeURIComponent(S.find)); } catch (e) { S.sid2 = null; S.detail = null; if (!quiet) fail(e); }
  }
  async function signOut() { try { await api("POST", "/api/auth/logout", {}); } catch { /* already out */ } S.me = null; S.sid = null; S.sid2 = null; S.detail = null; drawSignIn(); }

  // ------------------------------------------------------------------------------------------------ sign in
  function drawSignIn() {
    const err = window.VL.err(); const body = [];
    if (!S.codeSent) {
      const em = el("input", { id: "em", type: "email", autocomplete: "email", required: true, value: S.email, placeholder: "name@example.com" });
      const btn = el("button", { class: "btn brass big", type: "submit" }, "Send a code"); const cap = window.VL.captcha();
      body.push(el("p", { class: "muted" }, "We will e-mail a 6-digit code. There is no password."),
        el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); S.email = em.value.trim(); await window.VL.busy(btn, async () => { try { await api("POST", "/api/auth/start", { email: S.email, turnstileToken: cap.token() }); S.codeSent = true; drawSignIn(); devHint(); } catch (x) { err.show(x.message); cap.reset(); } }); } } },
          el("label", { for: "em" }, "E-mail ID"), em, cap.node, err, el("div", { class: "row" }, btn)));
    } else {
      const cd = el("input", { id: "cd", class: "codebox", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "14", required: true, placeholder: "000000" });
      const btn = el("button", { class: "btn brass big", type: "submit" }, "Continue");
      body.push(el("p", {}, "If this e-mail ID is set up, a 6-digit code is on its way to ", el("b", {}, maskMail(S.email)), ". It works for 10 minutes."), el("p", { id: "devhint", class: "note hidden" }),
        el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); await window.VL.busy(btn, async () => { try { await api("POST", "/api/auth/verify", { email: S.email, code: cd.value }); S.codeSent = false; await boot(); } catch (x) { err.show(x.message); cd.focus(); } }); } } },
          el("label", { for: "cd" }, "The code"), cd, err,
          el("div", { class: "row" }, btn, el("button", { class: "btn ghost", type: "button", on: { click: () => { S.codeSent = false; drawSignIn(); } } }, "Use a different e-mail ID"))));
    }
    root.replaceChildren(el("div", { class: "page" }, el("div", { class: "hero" }, el("h1", {}, "Attendance"), el("p", { class: "muted" }, "Make a session, mark who is present, close it and download the sheet. For Organizers and co-organizers.")),
      el("section", { class: "step now" }, el("header", {}, el("span", { class: "dot now" }, "1"), el("h2", {}, "Sign in")), el("div", { class: "body" }, body)),
      el("p", { class: "tiny muted center" }, "Voters do not sign in here. They use the link on the page of the list.")));
    document.getElementById("who").replaceChildren();
  }
  async function devHint() {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    try { const j = await (await fetch(`/dev/code?to=${encodeURIComponent(S.email)}`)).json(); const n = document.getElementById("devhint"); if (n && j.code) { n.textContent = "Test mode: the code is " + j.code; n.classList.remove("hidden"); } } catch { /* not the dev server */ }
  }

  // ------------------------------------------------------------------------------------------------ the page
  function draw() {
    const who = document.getElementById("who");
    who.replaceChildren(el("span", { class: "tiny" }, S.me.email), " ", el("button", { class: "btn ghost small", type: "button", on: { click: signOut } }, "Sign out"));
    const l = list();
    const go = (k) => { S.open = k; draw(); window.VL.focusStep(k); };
    const steps = [
      { key: "list", short: "List", title: "Step 1. Choose the list", state: l ? "done" : "now", summary: l ? l.name : "", open: S.open === "list", body: listBody },
      { key: "sessions", short: "Sessions", title: "Step 2. Sessions", state: !l ? "locked" : S.sessions.length ? "done" : "now", summary: l ? window.VL.plural(S.sessions.length, "session") : "", open: S.open === "sessions", lockedNote: "Opens after a list is chosen", body: sessionsBody },
      { key: "mark", short: "Mark", title: "Step 3. Mark present, close and download", state: !S.detail ? "locked" : "now", summary: S.detail ? S.detail.session.title : "", open: S.open === "mark", lockedNote: "Opens after a session is chosen", body: markBody },
    ];
    root.replaceChildren(el("div", { class: "page" }, el("div", { class: "hero" }, el("h1", {}, "Attendance"), l ? el("p", { class: "muted" }, l.name, " (", l.role === "organizer" ? "Organizer" : "Co-organizer", ")") : null), window.VL.stepbar(steps, go), window.VL.stepcards(steps, go)));
  }

  function listBody() {
    const l = S.me.lists; const out = [];
    out.push(l.length ? el("p", {}, "Choose the list that people will be marked from.") : el("p", { class: "note" }, "There is no list yet. Upload a sheet below to start."));
    for (const x of l) out.push(el("div", { class: "row" }, el("button", { class: "btn" + (x.id === S.sid ? " brass" : " ghost"), type: "button", on: { click: async () => { S.sid = x.id; S.sid2 = null; S.detail = null; location.hash = "#/" + x.id; S.open = "sessions"; try { await loadSessions(); } catch (e) { fail(e); } } } }, x.name), el("span", { class: "tiny muted" }, x.kind === "sheet" ? "Uploaded sheet" : "Voter List")));
    out.push(el("h3", {}, "Upload a sheet"), ...uploadForm());
    return out;
  }

  function uploadForm() {
    const err = window.VL.err(); const out = el("div");
    const title = el("input", { id: "ut", type: "text", maxlength: "80", required: true });
    const country = el("select", { id: "uc" }, S.me.countries.map((c) => el("option", { value: c }, c)));
    const fmt = el("select", { id: "uf" }, [["paste", "Paste the rows"], ["csv", "CSV file"], ["xlsx", "Excel file"]].map(([v, t]) => el("option", { value: v }, t)));
    const text = el("textarea", { id: "ux", rows: "6", placeholder: "Flat / House / Member ID, Name, E-mail ID" });
    const file = el("input", { id: "ufile", type: "file", accept: ".csv,.xlsx" });
    const read = () => new Promise((ok, no) => {
      if (fmt.value === "paste") return ok({ text: text.value });
      const f = file.files && file.files[0]; if (!f) return no(new Error("Please choose a file."));
      const r = new FileReader(); r.onerror = () => no(new Error("That file could not be read.")); r.onload = () => { const b = new Uint8Array(r.result); let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); ok(fmt.value === "csv" ? { text: new TextDecoder().decode(b) } : { base64: btoa(s) }); };
      r.readAsArrayBuffer(f);
    });
    const send = async (dry) => {
      err.clear();
      try {
        const body = { title: title.value, country: country.value, format: fmt.value, dryRun: dry, ...(await read()) };
        const x = await api("POST", "/api/attendance/rosters", body);
        if (dry) { S.sheet = x; showPreview(); return; }
        toast("The list is ready."); S.sheet = null; await boot(); S.open = "sessions"; draw();
      } catch (e) { err.show(e.message); }
    };
    const prev = el("button", { class: "btn", type: "button", on: { click: () => send(true) } }, "Check the sheet");
    const make = el("button", { class: "btn brass", type: "button", on: { click: () => send(false) } }, "Make the list");
    const note = el("div", { id: "up-note" });
    const showPreview = () => {
      const x = S.sheet; if (!x) return;
      const sk = x.skipped; const bad = sk.noEmail + sk.noUnit + sk.badUnit + sk.noName + sk.duplicate;
      window.VL.fill(note, el("p", { class: "note ok" }, window.VL.plural(x.willAdd, "person", "people"), " will be added. ", window.VL.plural(bad, "row"), " will be left out."),
        bad ? el("ul", { class: "small" }, Object.keys(sk).filter((k) => sk[k]).map((k) => el("li", {}, window.VL.plural(sk[k], "row"), ": ", x.why[k]))) : null);
    };
    out.append(el("label", { for: "ut" }, "Name of the list"), title, el("label", { for: "uc" }, "Country"), country, el("label", { for: "uf" }, "How to bring in the rows"), fmt,
      el("label", { for: "ux" }, "Rows"), text, el("label", { for: "ufile" }, "Or choose a file"), file,
      el("p", { class: "tiny muted" }, "Each row needs a Flat / House / Member ID, a Name and an e-mail ID. The e-mail ID is how a person signs in."),
      el("p", { class: "small" }, "Get the template: ", el("a", { href: "/api/attendance/template.xlsx" }, "Excel"), " or ", el("a", { href: "/api/attendance/template.csv" }, "CSV"), "."),
      err, note, el("div", { class: "row" }, prev, make));
    return [out];
  }

  function sessionsBody() {
    const l = list(); const out = [];
    if (l) out.push(el("p", { class: "small" }, "Voters sign in and mark present at this link: ", el("a", { href: l.link, target: "_blank", rel: "noopener" }, location.origin + l.link), " ", el("button", { class: "btn ghost small", type: "button", on: { click: () => window.VL.copy(location.origin + l.link) } }, "Copy the link")));
    if (isOrg()) out.push(newSession());
    else out.push(el("p", { class: "note" }, "Only the Organizer makes or closes a session. A co-organizer can mark people present."));
    if (!S.sessions.length) out.push(el("p", { class: "muted" }, "There is no session yet."));
    else out.push(window.VL.table(["Title", "Date and time", "Place", "How", "Status", "Present", ""], S.sessions.map((s) => el("tr", {},
      el("td", {}, s.title), el("td", {}, when(s.startsAt)), el("td", {}, s.place), el("td", {}, s.modeText), el("td", {}, s.status === "open" ? "Open for marking" : "Closed"), el("td", {}, s.counts.present + " of " + s.counts.eligible),
      el("td", {}, el("button", { class: "btn ghost small", type: "button", on: { click: async () => { S.find = ""; await loadDetail(s.id); S.open = "mark"; draw(); window.VL.focusStep("mark"); } } }, "Open"))))));
    return out;
  }

  function newSession() {
    const err = window.VL.err();
    const title = el("input", { id: "st", type: "text", maxlength: "80", required: true });
    const at = el("input", { id: "sa", type: "datetime-local", required: true });
    const place = el("input", { id: "sp", type: "text", maxlength: "120" });
    const mode = el("select", { id: "sm" }, [["in_person", "In person"], ["online", "Online"], ["offline", "Offline"]].map(([v, t]) => el("option", { value: v }, t)));
    const btn = el("button", { class: "btn brass", type: "submit" }, "Create the session");
    return el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); await window.VL.busy(btn, async () => { try { await api("POST", base(), { title: title.value, startsAt: at.value, place: place.value, mode: mode.value }); toast("Session created."); await loadSessions(); } catch (x) { err.show(x.message); } }); } } },
      el("h3", {}, "New session"), el("label", { for: "st" }, "Title"), title, el("label", { for: "sa" }, "Date and time"), at, el("label", { for: "sp" }, "Place"), place,
      el("label", { for: "sm" }, "How people are checked"), mode,
      el("p", { class: "tiny muted" }, "In an online session, voters mark themselves present after they sign in. In an in person or offline session, the Organizer or a co-organizer marks them."), err, el("div", { class: "row" }, btn));
  }

  function markBody() {
    const d = S.detail; if (!d) return [];
    const s = d.session; const open = s.status === "open"; const out = [];
    out.push(el("p", {}, el("b", {}, s.title), " | ", when(s.startsAt), " | ", s.modeText, " | ", open ? "Open for marking" : "Closed"), el("p", {}, s.counts.present + " of " + s.counts.eligible + " present."));
    const find = el("input", { id: "fd", type: "search", value: S.find, maxlength: "60", placeholder: "Flat / House / Member ID or Name" });
    out.push(el("form", { on: { submit: async (e) => { e.preventDefault(); S.find = find.value; await loadDetail(s.id); draw(); } } }, el("label", { for: "fd" }, "Find a person"), find, el("div", { class: "row" }, el("button", { class: "btn small", type: "submit" }, "Find"))));
    out.push(window.VL.table(["Flat / House / Member ID", "Name", "E-mail ID", "Status", ""], d.people.map((p) => el("tr", {}, el("td", {}, p.unit), el("td", {}, p.name), el("td", {}, p.email), el("td", {}, p.present ? "Present" : "Not marked"),
      el("td", {}, !p.present && open ? el("button", { class: "btn small", type: "button", on: { click: () => markOne(s.id, p.voterId) } }, "Mark present") : null)))));
    if (d.people.length >= 50) out.push(el("p", { class: "tiny muted" }, "Only the first 50 matches are shown. Use the find box, or download the sheet."));
    out.push(el("p", { class: "tiny muted" }, "Mark only a person who is present in the room or on paper."), el("p", { class: "tiny muted" }, "By pressing Mark present, the entry is recorded under the ", terms(), "."));
    const row = el("div", { class: "row" }, el("a", { class: "btn ghost", href: `/api/lists/${S.sid}/attendance/sessions/${s.id}/sheet.csv` }, "Download the sheet (CSV)"));
    if (isOrg() && open) row.append(el("button", { class: "btn", type: "button", on: { click: () => closeIt(s) } }, "Close the session"));
    out.push(row);
    return out;
  }
  async function markOne(id, voterId) { try { await api("POST", `/api/lists/${S.sid}/attendance/sessions/${id}/mark`, { voterId }); toast("Marked present."); await loadSessions(); } catch (e) { fail(e); await loadSessions().catch(() => {}); } }
  async function closeIt(s) {
    if (!(await window.VL.confirm("Close this session?", "Nobody can be marked after it is closed.", "Yes, close it"))) return;
    try { await api("POST", `/api/lists/${S.sid}/attendance/sessions/${s.id}/close`, {}); toast("Session closed."); await loadSessions(); } catch (e) { fail(e); }
  }

  boot().catch(fail);
})();
