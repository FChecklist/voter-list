// Attendance: the voter's page, /attend/<link>. Sign in with the e-mail code, see the open sessions, mark present in an online session.
// Plain page, no framework. Every value goes in as text (no innerHTML). The server decides who may mark; this page only shows its answer.
(function () {
  const { el, api, toast, fail } = window.VL;
  const slug = location.pathname.split("/").filter(Boolean).pop();
  const A = (p) => `/api/v/${slug}${p}`;
  const S = { pub: null, me: null, email: "", codeSent: false, pick: {} };
  const root = document.getElementById("app");
  const terms = () => el("a", { href: "/terms/", target: "_blank", rel: "noopener" }, "Terms and Conditions");
  const maskMail = (e) => (/@[^@.]+$/.test(e) ? e.replace(/^(.)[^@]*@/, "$1****@") : e.replace(/^(.).*(@)(.).*(\..+)$/, "$1****$2$3****$4"));

  async function load() {
    try { S.pub = await api("GET", A("/attendance")); } catch (e) {
      if (e.status !== 410) throw e;
      document.getElementById("who").replaceChildren();
      root.replaceChildren(el("div", { class: "page" }, el("div", { class: "hero" }, el("h1", {}, "Attendance"), el("p", { class: "muted" }, "This list has been closed. Nothing can be marked here."))));
      return;
    }
    try { S.me = await api("GET", A("/attend/me")); } catch (e) { if (e.status === 401) S.me = null; else throw e; }
    draw();
  }
  async function signOut() { try { await api("POST", A("/logout"), {}); } catch { /* already out */ } S.me = null; S.codeSent = false; draw(); }

  function draw() {
    const signedIn = !!S.me;
    document.getElementById("who").replaceChildren(signedIn ? [el("span", { class: "tiny" }, S.me.email), " ", el("button", { class: "btn ghost small", type: "button", on: { click: signOut } }, "Sign out")] : []);
    const go = () => draw();
    const steps = [
      { key: "signin", short: "Sign in", title: "Step 1. Sign in", state: signedIn ? "done" : "now", summary: signedIn ? S.me.email : "", open: false, body: signinBody },
      { key: "sessions", short: "Sessions", title: "Step 2. Mark present", state: signedIn ? "now" : "locked", open: false, lockedNote: "Opens after sign in", body: sessionsBody },
    ];
    root.replaceChildren(el("div", { class: "page" }, el("div", { class: "hero" }, el("h1", {}, "Attendance"), el("p", { class: "muted" }, S.pub.list)), window.VL.stepbar(steps, go), window.VL.stepcards(steps, go)));
  }

  function signinBody() {
    const err = window.VL.err();
    if (!S.codeSent) {
      const email = el("input", { id: "em", type: "email", autocomplete: "email", inputmode: "email", required: true, value: S.email, placeholder: "name@example.com" });
      const btn = el("button", { class: "btn brass big", type: "submit" }, "Send a code"); const cap = window.VL.captcha();
      return [el("p", { class: "muted" }, "We will e-mail a 6-digit code. There is no password."),
        el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); S.email = email.value.trim(); await window.VL.busy(btn, async () => { try { await api("POST", A("/start"), { email: S.email, turnstileToken: cap.token() }); S.codeSent = true; draw(); devHint(); } catch (x) { err.show(x.message); cap.reset(); } }); } } },
          el("label", { for: "em" }, "E-mail ID"), email, cap.node, err, el("div", { class: "row" }, btn))];
    }
    const code = el("input", { id: "cd", class: "codebox", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "14", required: true, placeholder: "000000" });
    const btn = el("button", { class: "btn brass big", type: "submit" }, "Continue");
    return [el("p", {}, "A 6-digit code is on its way to ", el("b", {}, maskMail(S.email)), ". It works for 10 minutes."), el("p", { id: "devhint", class: "note hidden" }),
      el("form", { on: { submit: async (e) => { e.preventDefault(); err.clear(); await window.VL.busy(btn, async () => { try { await api("POST", A("/verify"), { email: S.email, code: code.value }); S.codeSent = false; await load(); } catch (x) { err.show(x.message); code.focus(); } }); } } },
        el("label", { for: "cd" }, "The code"), code, err,
        el("div", { class: "row" }, btn, el("button", { class: "btn ghost", type: "button", on: { click: () => { S.codeSent = false; draw(); } } }, "Use a different e-mail ID")))];
  }
  async function devHint() {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    try { const j = await (await fetch(`/dev/code?to=${encodeURIComponent(S.email)}`)).json(); const n = document.getElementById("devhint"); if (n && j.code) { n.textContent = "Test mode: the code is " + j.code; n.classList.remove("hidden"); } } catch { /* not the dev server */ }
  }

  function sessionsBody() {
    const open = S.pub.sessions.filter((s) => s.status === "open");
    if (!S.me.rows.length) return [el("p", { class: "note bad" }, "This e-mail ID is not on the list.")];
    if (!open.length) return [el("p", { class: "muted" }, "There is no open session now.")];
    return open.map((s) => session(s));
  }

  function session(s) {
    const err = window.VL.err();
    const many = S.me.rows.length > 1;
    const which = many ? el("select", { id: "w" + s.id, "aria-label": "Flat / House / Member ID" }, S.me.rows.map((r) => el("option", { value: r.voterId }, r.unit))) : null;
    const body = [el("h3", {}, s.title), el("p", { class: "small" }, window.VL.localTime(s.startsAt), s.place ? " | " + s.place : "", " | ", s.modeText)];
    if (s.mode !== "online") return el("section", { class: "card" }, body, el("p", { class: "note" }, "This session is not online. Please ask the Organizer or a co-organizer to mark present."));
    const btn = el("button", { class: "btn brass big", type: "button" }, "Mark present");
    btn.addEventListener("click", () => window.VL.busy(btn, async () => {
      err.clear();
      try { await api("POST", A(`/attendance/${s.id}/here`), which ? { voterId: which.value } : {}); toast("Marked present."); S.pub = await api("GET", A("/attendance")); draw(); }
      catch (x) { if (x.code === "already_present") { toast("Already marked present."); } else err.show(x.message); }
    }));
    return el("section", { class: "card" }, body, which ? [el("label", { for: "w" + s.id }, "Flat / House / Member ID"), which] : null, err, el("div", { class: "row" }, btn),
      el("p", { class: "tiny muted" }, "By pressing Mark present, this e-mail ID is recorded as present under the ", terms(), "."));
  }

  load().catch(fail);
})();
