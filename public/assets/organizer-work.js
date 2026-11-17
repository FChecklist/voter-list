// The Organizer's and Hosts' page, part 2: Step 4 (check records), Step 5 (final checks), Steps 6 and 7 (publish), and the extras.
(function () {
  const { el, api, toast, fail } = window.VL;
  const OR = window.OR, S = OR.S;
  const R = { tab: "submitted", q: "", sel: new Set(), data: null, off: 0 };
  const TABS = [["submitted", "Waiting", "submitted"], ["sent_back", "Sent back", "sent_back"], ["approved", "Approved", "approved"], ["invited", "Invited", "invited"], ["all", "All", null]];
  const HK = { created: "Started by the voter", confirmed: "Sent by the voter", edited: "Details changed", resubmitted: "Sent again by the voter", approved: "Approved", sent_back: "Sent back", imported: "Prepared from an upload", added: "Added by the team", corrected: "Corrected", removed: "Removed", withdrawn: "Withdrawn by the voter", undone: "Undone", doc_added: "Document added", doc_removed: "Document removed", voter_chosen: "Authorized (or un-authorized) to vote for the flat", weight: "Vote weight set" };
  const STATUS = { invited: ["Invited", "info"], draft: ["Not sent", ""], submitted: ["Waiting", "warn"], approved: ["Approved", "ok"], sent_back: ["Sent back", "bad"] };

  // ------------------------------------------------------------------------------------------------ Step 4: check the records
  OR.body.review = function () {
    const ov = S.ov, open = ov.list.phase === "open"; const box = el("div", { class: "muted" }, "Loading…"); const undo = el("div");
    async function load() {
      try {
        R.data = await api("GET", `/api/lists/${S.sid}/records?status=${R.tab}&q=${encodeURIComponent(R.q)}&offset=${R.off}&limit=50`);
        paint(); const a = (await api("GET", `/api/lists/${S.sid}/actions`)).actions.slice(0, 1).find((x) => x.undoable);
        window.VL.fill(undo, a && open ? el("div", { class: "undobar" }, el("span", {}, "Last action: ", el("b", {}, actionWords(a)), "."), el("button", { class: "btn small", type: "button", on: { click: async () => { try { await api("POST", `/api/lists/${S.sid}/undo`, { key: a.key }); R.sel.clear(); toast("Undone."); await OR.reload("review"); } catch (x) { fail(x); } } } }, "Undo")) : null);
      } catch (x) { fail(x); }
    }
    function paint() {
      const d = R.data, c = d.counts;
      const tabs = el("div", { class: "chips", role: "group", "aria-label": "Show records" }, TABS.map(([k, label, key]) => el("button", { class: "chip", type: "button", "aria-pressed": String(R.tab === k), on: { click: () => { R.tab = k; R.off = 0; R.sel.clear(); load(); } } }, label, key ? ` (${c[key] || 0})` : ` (${d.total === undefined ? "" : (c.invited + c.draft + c.submitted + c.approved + c.sent_back)})`)));
      const q = el("input", { type: "search", placeholder: d.masked ? "Search by flat number" : "Search by flat, name or e-mail ID", value: R.q, "aria-label": "Search records" });
      let t; q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { R.q = q.value.trim(); R.off = 0; load(); }, 350); });
      const rows = d.records.map((r) => el("div", { class: "listrow" },
        open && (r.status === "submitted" || R.tab !== "submitted") ? el("input", { type: "checkbox", checked: R.sel.has(r.id), "aria-label": "Select " + r.unit, on: { change: (e) => { e.target.checked ? R.sel.add(r.id) : R.sel.delete(r.id); bar(); } } }) : null,
        el("div", { class: "main" }, el("b", {}, r.unit), " ", r.name, el("div", { class: "tiny muted" }, `${window.VL.cap(r.capacity)}${r.proxyFor ? " for " + r.proxyFor : ""}${r.docs ? ` · ${r.docs} document${r.docs > 1 ? "s" : ""}` : ""}${r.hasEarlierApproval && r.status === "submitted" ? " · changed after approval" : ""}${r.source === "upload" ? " · uploaded" : ""}`)),
        el("span", { class: "badge " + (STATUS[r.status] || ["", ""])[1] }, (STATUS[r.status] || [r.status])[0]),
        el("button", { class: "btn ghost small", type: "button", "aria-label": "Open " + r.unit + " " + r.name, on: { click: () => openRecord(r.id) } }, "Open")));
      window.VL.fill(box, tabs, q, rows.length ? rows : el("p", { class: "muted" }, R.q ? "Nothing matches." : R.tab === "submitted" ? "Nothing is waiting. New records appear here when voters send them." : "Nothing here."),
        d.total > d.offset + d.records.length ? el("div", { class: "row" }, el("button", { class: "btn ghost", type: "button", on: { click: () => { R.off += 50; load(); } } }, "Show the next 50")) : null,
        d.offset > 0 ? el("div", { class: "row" }, el("button", { class: "btn ghost", type: "button", on: { click: () => { R.off = Math.max(0, R.off - 50); load(); } } }, "Back")) : null, bulk);
      bar();
    }
    const bulk = el("div");
    function bar() {
      const n = R.sel.size; const items = () => R.data.records.filter((r) => R.sel.has(r.id)).map((r) => ({ id: r.id, rev: r.revision }));
      window.VL.fill(bulk, n ? el("div", { class: "bulkbar", role: "region", "aria-label": "Actions for the selected records" }, el("b", {}, `${n} selected`),
        el("button", { class: "btn brass small", type: "button", on: { click: () => decide(items(), "approve") } }, "Approve"),
        el("button", { class: "btn small", type: "button", on: { click: async () => { const a = await window.VL.ask("Not approved: tell the voter what to fix", "The voter sees this and can fix and send again. Please do not write phone numbers or e-mail IDs.", [{ name: "reason", type: "textarea", label: "What should the voter fix?", max: 400 }], "Send back"); if (a) decide(items(), "send_back", a.reason); } } }, "Not approved…"),
        el("button", { class: "btn ghost small", style: "color:#fff;border-color:#fff", type: "button", on: { click: async () => { const a = await window.VL.ask("Remove these records?", "They leave the list and the queue. You can undo this straight after.", [{ name: "reason", label: "Why? (a few words)", max: 200 }], "Remove"); if (a) { try { const x = await api("POST", `/api/lists/${S.sid}/records/remove`, { ids: [...R.sel], reason: a.reason }); R.sel.clear(); toast(`${x.removed} removed.`); await OR.reload("review"); } catch (e) { fail(e); } } } } }, "Remove…")) : null);
    }
    async function decide(items, decision, reason) {
      try {
        const x = await api("POST", `/api/lists/${S.sid}/records/decide`, { items, decision, reason: reason || "" }); R.sel.clear();
        const skip = x.skipped && (x.skipped.length !== undefined ? x.skipped.length : Object.values(x.skipped).reduce((a, b) => a + b, 0));
        toast(`${x.applied} ${decision === "approve" ? "approved" : "sent back"}.` + (skip ? ` ${skip} skipped because they changed meanwhile or are your own.` : "")); await OR.reload("review");
      } catch (e) { if (e.code === "changed") { toast("A record changed while you were looking. Nothing was approved. Please look again.", true); R.sel.clear(); await OR.reload("review"); } else fail(e); }
    }
    load();
    const add = open ? el("div", { class: "row" }, el("button", { class: "btn ghost", type: "button", on: { click: async () => {
      const caps = ov.rules.find((r) => r.code === ov.list.ruleCode).capacities;
      const a = await window.VL.ask("Add a person", "Added people are approved straight away.", [{ name: "agreed", type: "checkbox", label: "This person has agreed to be on the voter list" }, { name: "unit", label: "Flat or house number" }, { name: "name", label: "Name" }, { name: "capacity", type: "select", label: "Role", options: caps.map((c) => ({ value: c, label: window.VL.cap(c) })) }, { name: "mobile", label: "Mobile number" }, { name: "email", label: "E-mail ID", type: "email" }], "Add");
      if (a) { try { await api("POST", `/api/lists/${S.sid}/records`, a); toast("Added."); await OR.reload("review"); } catch (e) { fail(e); } }
    } } }, "Add a person")) : null;
    return [el("p", { class: "muted" }, "Open a record, check it, then Approve it or send it back with a reason. The voter fixes it and sends it again, and it comes back here."), undo, box, add, el("p", { class: "tiny muted" }, "What happens next: when nothing is waiting, go on to the final checks.")];
  };
  const actionWords = (a) => `${({ approved: "Approved", sent_back: "Sent back", removed: "Removed", imported: "Uploaded", added: "Added", corrected: "Corrected", voter_chosen: "Authorized or un-authorized a person to vote", weight: "Set a weight" })[a.kind] || a.kind} ${a.count > 1 ? a.count + " records" : ""}`.trim();

  async function openRecord(id) {
    let x; try { x = await api("GET", `/api/lists/${S.sid}/records/${id}`); } catch (e) { fail(e); return; }
    const r = x.record, open = S.ov.list.phase === "open", d = el("dialog", { style: "max-width:min(640px,96vw)" });
    const act = (decision) => async () => {
      let reason = "";
      if (decision === "send_back") { const a = await window.VL.ask("Not approved: tell the voter what to fix", "The voter sees this and can fix and send again. Please do not write phone numbers or e-mail IDs.", [{ name: "reason", type: "textarea", label: "What should the voter fix?", max: 400 }], "Send back"); if (!a) return; reason = a.reason; }
      try { const y = await api("POST", `/api/lists/${S.sid}/records/decide`, { items: [{ id, rev: r.revision }], decision, reason }); d.close(); toast(y.applied ? (decision === "approve" ? "Approved." : "Sent back.") : "Nothing changed: you cannot decide your own record, or it changed meanwhile."); await OR.reload("review"); } catch (e) { if (e.code === "changed") { d.close(); toast("It changed while you were looking. Please open it again.", true); await OR.reload("review"); } else fail(e); }
    };
    const caps = S.ov.rules.find((q) => q.code === S.ov.list.ruleCode).capacities; const err = window.VL.err();
    const why = el("input", { type: "text", id: "e6", maxlength: "200", placeholder: "e.g. Name typed wrongly" });
    const ed = { unit: el("input", { type: "text", value: r.unit, id: "e1" }), name: el("input", { type: "text", value: r.name, id: "e2" }), mobile: el("input", { type: "text", value: r.mobile, id: "e3" }), capacity: el("select", { id: "e4" }, caps.map((c) => el("option", { value: c, selected: c === r.capacity }, window.VL.cap(c)))), proxyFor: el("input", { type: "text", value: r.proxyFor, id: "e5" }) };
    // may this person vote? "No" always needs a reason; a reason the Organizer gave can only be changed by the Organizer
    const locked = r.noVoteBy === "organizer" && S.ov.role !== "organizer" && (r.canVote === false || r.isVoter === false);
    const vs = { can: el("select", { id: "e7", disabled: locked }, [["yes", "Yes"], ["no", "No"]].map(([v, t]) => el("option", { value: v, selected: (v === "yes") === !(r.canVote === false || r.isVoter === false) }, t))), why: el("select", { id: "e8", disabled: locked }, [["", "Choose a reason..."], ...window.VL.REASONS].map(([v, t]) => el("option", { value: v, selected: v === (r.noVoteReason || "") }, t))), note: el("input", { type: "text", id: "e9", "aria-label": "Your own words for the reason", maxlength: "120", value: r.noVoteNote || "", disabled: locked, placeholder: "Your own words (needed for 'Another reason')" }) };
    const voteSync = () => { vs.why.parentElement.classList.toggle("hidden", vs.can.value === "yes"); }; vs.can.addEventListener("change", voteSync);
    const voteNow = r.isVoter === false || r.canVote === false ? (r.noVoteText ? `${r.noVoteText} (set by ${r.noVoteBy === "organizer" ? "the Organizer" : r.noVoteBy === "host" ? "a Host" : "the list team"})` : "Not allowed to vote. No reason has been given yet: please choose one below.") : r.isVoter === true ? "Authorized to vote" : "Decided with the flat in Step 5";
    const saveEdit = async () => { err.clear(); const body = {}; for (const k of Object.keys(ed)) if (ed[k].value !== (r[k] || "")) body[k] = ed[k].value;
      const wantCan = vs.can.value === "yes";
      const wasAllowed = !(r.canVote === false || r.isVoter === false);
      if (wantCan && r.isVoter === false) { err.show("This person was taken off by the Organizer's choice. Authorize them again in Step 5."); return; }
      if (!locked && (wantCan !== wasAllowed || (!wantCan && (vs.why.value !== (r.noVoteReason || "") || vs.note.value.trim() !== (r.noVoteNote || ""))))) { if (r.isVoter !== false) body.canVote = wantCan; if (!wantCan) { if (!vs.why.value) { err.show("Please choose a reason from the list."); return; } if (vs.why.value === "other" && vs.note.value.trim().length < 3) { err.show("Please write the reason in a few words."); return; } body.notAllowedReason = vs.why.value; body.notAllowedNote = vs.note.value.trim(); } } if (!Object.keys(body).length) { err.show("Nothing was changed."); return; } if (!why.value.trim()) { err.show("Please write why, in a few words."); return; } body.reason = why.value; try { await api("PATCH", `/api/lists/${S.sid}/records/${id}`, body); d.close(); toast("Corrected."); await OR.reload("review"); } catch (e) { err.show(e.message); } };
    d.append(el("h2", {}, `${r.unit}: ${r.name}`), el("p", {}, el("span", { class: "badge " + (STATUS[r.status] || ["", ""])[1] }, (STATUS[r.status] || [r.status])[0]), x.onTheList ? el("span", { class: "badge ok", style: "margin-left:6px" }, "On the list") : null),
      r.status === "sent_back" && r.reason ? el("p", { class: "note bad" }, "Sent back: " + r.reason) : null,
      el("dl", { class: "kv" }, el("dt", {}, "Role"), el("dd", {}, window.VL.cap(r.capacity) + (r.proxyFor ? ` for ${r.proxyFor}` : "")), el("dt", {}, "Mobile"), el("dd", {}, r.mobile || "-"), el("dt", {}, "E-mail ID"), el("dd", {}, r.email || "-"), el("dt", {}, "Voting"), el("dd", { class: r.isVoter === false || r.canVote === false ? "bad" : "" }, voteNow)),
      S.ov.masked ? el("p", { class: "tiny muted" }, "You opened this record, so it has been noted in the signed log.") : null,
      el("h3", {}, "Documents"), x.docs.length ? el("ul", { class: "docs", style: "list-style:none;padding:0" }, x.docs.map((q) => el("li", {}, el("b", {}, q.docType), " ", el("span", { class: "muted small" }, q.filename), el("a", { class: "btn ghost small", target: "_blank", rel: "noopener", href: `/api/lists/${S.sid}/records/${id}/docs/${q.id}` }, "View")))) : el("p", { class: "muted" }, "No documents."),
      el("h3", {}, "History"), el("ol", { class: "timeline" }, x.history.map((h) => el("li", { class: h.kind === "sent_back" ? "bad" : h.kind === "approved" ? "ok" : "" }, el("b", {}, HK[h.kind] || h.kind), / by /.test(HK[h.kind] || "") ? "" : " by " + h.by, h.you ? " (you)" : "", " ", el("span", { class: "muted small" }, window.VL.fmtDate(h.at)), h.reason && h.kind === "sent_back" ? el("div", { class: "small" }, h.reason) : null))),
      open ? el("details", {}, el("summary", {}, "Correct a detail"), el("div", { class: "fieldrow" }, el("div", {}, el("label", { for: "e1" }, "Flat"), ed.unit), el("div", {}, el("label", { for: "e2" }, "Name"), ed.name), el("div", {}, el("label", { for: "e3" }, "Mobile"), ed.mobile), el("div", {}, el("label", { for: "e4" }, "Role"), ed.capacity)), el("label", { for: "e5" }, "Proxy for (owner's name)"), ed.proxyFor, el("label", { for: "e7" }, "Allowed to vote?"), vs.can, el("div", {}, el("label", { for: "e8" }, "Why is this person not allowed to vote?"), vs.why, vs.note, locked ? el("p", { class: "tiny muted" }, "The Organizer gave this reason, so only the Organizer can change it.") : null), el("label", { for: "e6" }, "Why is it being corrected?"), why, err, el("div", { class: "row" }, el("button", { class: "btn small", type: "button", on: { click: saveEdit } }, "Save the correction"))) : null,
      el("div", { class: "row end" }, el("button", { class: "btn ghost", type: "button", on: { click: () => d.close() } }, "Close"),
        open && r.status !== "approved" ? [el("button", { class: "btn", type: "button", on: { click: act("send_back") } }, "Not approved…"), el("button", { class: "btn brass", type: "button", on: { click: act("approve") } }, "Approve")] : null,
        null));
    d.addEventListener("close", () => d.remove()); document.body.append(d); voteSync(); d.showModal();
  }

  // the reason for "not allowed to vote" that a trail entry carries (who gave it is the Who column; when is the When column)
  const whyGiven = (pl) => { const x = pl && (pl.notAllowed || pl); if (!x || !x.reason) return ""; const hit = window.VL.REASONS.find((r) => r[0] === x.reason); return (hit ? hit[1] : x.reason) + (x.note ? " (" + x.note + ")" : ""); };
  // ------------------------------------------------------------------------------------------------ Step 5: final checks
  // one flat with everyone registered for it, each with an authorize / take-away button (Organizer only); taking someone off always asks for a reason
  const personRow = (u, o, open, after) => {
    const org = S.ov.role === "organizer";
    const give = async (onlyReason) => { // onlyReason: the person stays as they are and only the reason is written (a person who may attend but not vote)
      const a = await window.VL.askReason(`Why is ${o.name} not allowed to vote?`, "You, your Hosts and the person can read this reason. What the public list shows is your choice in Step 1.", { reason: o.reasonCode || undefined, note: o.reasonNote }, "Save the reason", async (a) => {
        if (onlyReason && o.authorized) await api("PATCH", `/api/lists/${S.sid}/records/${o.voterId}`, { canVote: false, notAllowedReason: a.reason, notAllowedNote: a.note, reason: "Reason for not voting added" });
        else await api("POST", `/api/lists/${S.sid}/units/choose`, { unit: u.unit, voterId: o.voterId, authorized: false, reason: a.reason, note: a.note });
      });
      return !!a;
    };
    const click = async () => { try { if (o.authorized) { if (!(await give())) return; } else await api("POST", `/api/lists/${S.sid}/units/choose`, { unit: u.unit, voterId: o.voterId, authorized: true }); await after(); } catch (e) { fail(e); } };
    const word = org ? (o.authorized ? "Authorized ✓ (tap to take away)" : "Not authorized (tap to authorize)") : (o.authorized ? "Authorized" : "Not authorized");
    return el("div", { style: "margin-top:6px" },
      el("div", { class: "row", style: "display:flex;gap:10px;align-items:center;justify-content:space-between" }, el("span", {}, `${o.name} (${o.capacity})`), el("button", { class: "chip" + (o.authorized ? " on" : ""), type: "button", "aria-pressed": String(o.authorized), disabled: !open || !org, on: { click } }, word)),
      o.reason ? el("div", { class: "small " + (o.reasonMissing ? "bad" : "muted"), style: "margin-top:2px" }, o.reason, !o.authorized && !o.reasonCode && !o.reasonMissing && org && open ? [" ", el("button", { class: "btn ghost small", type: "button", on: { click: async () => { try { if (await give()) await after(); } catch (e) { fail(e); } } } }, "Not allowed: choose a reason")] : null, o.reasonMissing && org && open ? [" ", el("button", { class: "btn ghost small", type: "button", on: { click: async () => { try { if (await give(true)) await after(); } catch (e) { fail(e); } } } }, "Choose the reason")] : null, !o.reasonMissing && o.reasonCode && !o.authorized && org && open ? [" ", el("button", { class: "btn ghost small", type: "button", on: { click: async () => { try { if (await give(true)) await after(); } catch (e) { fail(e); } } } }, "Change the reason")] : null) : null);
  };
  const keepPlace = (fn) => async () => { const y = window.scrollY; await fn(); window.scrollTo(0, y); };
  const flatCard = (u, open, after) => el("div", { class: "claim" }, el("b", {}, "Flat " + u.unit), u.people.map((o) => personRow(u, o, open, keepPlace(after))));
  const lookupBox = (open) => {
    const out = el("div", {}); const q = el("input", { type: "text", placeholder: "Flat or house number", "aria-label": "Look up a flat", style: "max-width:14rem", value: S.lookupQ || "", on: { keydown: (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } } } });
    const run = async () => { const t = q.value.trim(); S.lookupQ = t; if (!t) { window.VL.fill(out, null); return; } try { const r = await api("GET", `/api/lists/${S.sid}/checks?find=${encodeURIComponent(t)}`); window.VL.fill(out, r.lookup.length ? r.lookup.map((u) => flatCard(u, open, () => OR.reload("checks"))) : el("p", { class: "muted small" }, "No flat like that is on the list yet.")); } catch (e) { fail(e); } };
    if (S.lookupQ) setTimeout(run, 0); // after a change the whole page is read again (the counts above must follow), and this look-up comes back with it
    return el("div", {}, el("h3", {}, "Look up any flat"), el("p", { class: "muted small" }, S.ov.role === "organizer" ? "Any flat, even one with a single person, can be checked here. You can take someone's authorization away (a reason is needed) or give it back." : "Any flat can be looked up here. The Organizer decides who may vote."), el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, q, el("button", { class: "btn small", type: "button", on: { click: run } }, "Look up")), out);
  };
  OR.body.checks = function () {
    const box = el("div", { class: "muted" }, "Looking over the list…"); const open = S.ov.list.phase === "open";
    api("GET", `/api/lists/${S.sid}/checks`).then((c) => {
      const s = c.summary;
      window.VL.fill(box, el("div", { class: "stat" }, [[c.onList, "people on the list"], [s.units, "flats"], [s.authorized, "people authorized to vote"], [s.canVote, "flats that may vote"], [c.notIncluded, "not on the list yet"]].map(([n, t]) => el("div", {}, el("b", {}, String(n)), el("span", {}, t)))),
        c.flats.length ? el("div", {}, el("h3", {}, "Flats that need your choice"), el("p", { class: "muted small" }, S.ov.role === "organizer" ? "Flats with more than one person, and flats where nobody is authorized, are shown here with everyone registered for them. You decide who may vote: authorize as many people as you like for each flat, or none." : "Flats that need a choice are shown with everyone registered for them. The Organizer decides who may vote."), c.flatsMore ? el("p", { class: "note" }, `${c.flatsMore} more flats are not shown here. Authorize these first and the next ones appear.`) : null, c.flats.map((u) => flatCard(u, open, () => OR.reload("checks")))) : null,
        c.onList ? lookupBox(open) : null,
        c.issues.length ? el("div", {}, el("h3", {}, "Please look at these"), c.issues.map((i) => el("div", { class: "issue" }, el("span", { class: "badge " + (i.severity === "error" ? "bad" : "warn") }, i.severity === "error" ? "Fix" : "Check"), el("div", {}, el("div", {}, i.message), i.hint ? el("div", { class: "tiny muted" }, i.hint) : null)))) : el("p", { class: "note ok" }, c.onList ? "Everything looks right." : "No one is on the list yet. Approve records in Step 4."),
        c.weights.length ? weightsBox(c.weights, open) : null);
    }).catch(fail);
    return [el("p", { class: "muted" }, "We look for problems in plain words, so the final list is right. Errors must be fixed. Warnings need your OK."), box, el("p", { class: "tiny muted" }, "What happens next: publish the draft so everyone can see it, then freeze it at the closing time.")];
  };
  function weightsBox(ws, open) {
    const inputs = ws.map((w) => [w, el("input", { type: "text", inputmode: "decimal", value: String(w.weightMilli / 1000), "aria-label": "Weight of flat " + w.unit, style: "max-width:110px" })]);
    return el("div", {}, el("h3", {}, "Vote weight per flat"), el("p", { class: "small muted" }, "For example 1 for a standard flat, 1.5 for a larger one."), inputs.map(([w, i]) => el("div", { class: "listrow" }, el("b", { class: "main" }, "Flat " + w.unit), i)),
      open ? el("div", { class: "row" }, el("button", { class: "btn", type: "button", on: { click: async () => { const items = inputs.filter(([w, i]) => i.value !== String(w.weightMilli / 1000)).map(([w, i]) => ({ unit: w.unit, weight: i.value })); if (!items.length) { toast("No weight was changed."); return; } try { for (let k = 0; k < items.length; k += 60) await api("PUT", `/api/lists/${S.sid}/weights`, { items: items.slice(k, k + 60) }); toast("Weights saved."); await OR.reload("checks"); } catch (e) { fail(e); } } } }, "Save weights")) : null);
  }

  // ------------------------------------------------------------------------------------------------ Step 6: draft
  OR.body.draft = function () {
    const ov = S.ov, drafts = ov.publications.filter((p) => p.kind === "draft"), open = ov.list.phase === "open", url = location.origin + ov.list.link;
    const btn = el("button", { class: "btn brass big", type: "button" }, drafts.length ? "Publish a fresh draft" : "Publish the draft list");
    btn.addEventListener("click", () => window.VL.busy(btn, async () => { btn.textContent = "Publishing…"; try { await api("POST", `/api/lists/${S.sid}/publish/draft`, {}); toast("Draft published. Everyone with the link can see it."); await OR.reload("draft"); } catch (e) { fail(e); } }));
    const d = drafts[0];
    return [el("p", { class: "big" }, "Show everyone the list as it stands now. It is marked provisional, and voters can still correct their details."),
      d ? el("p", { class: "note ok" }, `Draft ${d.seq} is public: ${d.people} people in ${d.units} flats, published ${window.VL.fmtDate(d.publishedAt)}. Fingerprint `, el("span", { class: "mono" }, d.fingerprintShort), ".") : null,
      open ? el("div", { class: "row" }, btn, d ? el("a", { class: "btn ghost", href: ov.list.link, target: "_blank", rel: "noopener" }, "See the public page") : null) : null,
      el("p", { class: "tiny muted" }, "Names, mobiles and e-mail IDs show as ", el("span", { class: "mono" }, "Ra**** Sh****"), ". Publishing again replaces the draft. What happens next: when everything is right, publish the final list in Step 7."), el("p", { class: "tiny muted" }, "Link: " + url)];
  };

  // ------------------------------------------------------------------------------------------------ Step 7: freeze
  OR.body.frozen = function () {
    const ov = S.ov, L = ov.list, frozen = L.phase === "frozen";
    const pubs = ov.publications.filter((p) => p.kind === "frozen");
    const list = pubs.length ? el("div", {}, el("h3", {}, "Final lists"), pubs.map((p) => el("div", { class: "claim" }, el("b", {}, p.event || "Final list " + p.seq), el("div", { class: "small muted" }, `Frozen at the cut-off of ${window.VL.localTime(p.cutoffLocal)} · ${p.people} people in ${p.units} flats`), el("div", { class: "small" }, "Fingerprint ", el("span", { class: "mono" }, p.fingerprintShort)),
      el("div", { class: "row" }, el("a", { class: "btn ghost small", href: `/api/lists/${S.sid}/publications/${p.id}/export.pdf` }, "Masked PDF"), el("a", { class: "btn ghost small", href: `/api/lists/${S.sid}/publications/${p.id}/export.csv` }, "Masked CSV"), el("a", { class: "btn ghost small", href: `/api/lists/${S.sid}/publications/${p.id}/export.pdf?full=1` }, "Full PDF (Organizer)"), el("a", { class: "btn ghost small", href: `/api/lists/${S.sid}/publications/${p.id}/export.csv?full=1` }, "Full CSV (Organizer)"))))) : null;
    if (frozen) {
      const reason = el("input", { id: "rr", type: "text", maxlength: "300", placeholder: "Why? e.g. Special general meeting in January" }), typed = el("input", { id: "rt", type: "text", placeholder: "REOPEN", autocomplete: "off" }), err = window.VL.err();
      return [el("p", { class: "note ok" }, "The final list is frozen and signed. Anyone with the voter link can see it and check the proof."), list,
        el("details", {}, el("summary", {}, "Need a new round? Reopen the list"), el("p", { class: "small muted" }, "Earlier final lists stay exactly as they are. Voters can enrol and change records again until you freeze a new list."), el("label", { for: "rr" }, "Reason"), reason, el("label", { for: "rt" }, "Type REOPEN to confirm"), typed, err,
          el("div", { class: "row" }, el("button", { class: "btn", type: "button", on: { click: async () => { try { await api("POST", `/api/lists/${S.sid}/reopen`, { reason: reason.value, confirm: typed.value }); toast("Reopened."); await OR.reload("setup"); } catch (e) { err.show(e.message); } } } }, "Reopen the list")))];
    }
    const err = window.VL.err(); const ack = el("div"); const state = { ackPending: false, ackWarnings: false, closeNow: false };
    const ev = el("input", { id: "ev", type: "text", maxlength: "200", placeholder: "e.g. Annual General Meeting 2026" });
    const type = el("select", { id: "et" }, [["meeting", "General meeting"], ["election", "Election"]].map(([v, t]) => el("option", { value: v }, t)));
    const typed = el("input", { id: "ft", type: "text", placeholder: "FREEZE", autocomplete: "off" });
    const cut = L.cutoffLocal ? (L.cutoffAt > ov.now ? "future" : "passed") : "none";
    const now = el("input", { type: "checkbox", id: "cn", on: { change: (e) => { state.closeNow = e.target.checked; } } });
    const btn = el("button", { class: "btn brass big", type: "button" }, "Freeze and publish the final list");
    btn.addEventListener("click", () => window.VL.busy(btn, async () => {
      err.clear();
      try { const x = await api("POST", `/api/lists/${S.sid}/publish/frozen`, { eventName: ev.value, eventType: type.value, confirm: typed.value, ...state }); toast("Final list published and signed."); await OR.reload("frozen"); }
      catch (e) {
        if (e.code === "pending") { window.VL.fill(ack, el("div", { class: "note warn" }, e.message, el("label", { style: "display:flex;gap:10px;font-weight:400" }, el("input", { type: "checkbox", on: { change: (q) => { state.ackPending = q.target.checked; } } }), "I understand. Freeze anyway."))); }
        else if (e.code === "warnings") { window.VL.fill(ack, el("div", { class: "note warn" }, e.message, el("label", { style: "display:flex;gap:10px;font-weight:400" }, el("input", { type: "checkbox", on: { change: (q) => { state.ackWarnings = q.target.checked; } } }), "I have looked at them. Freeze anyway."))); }
        else err.show(e.message);
      }
    }));
    return [el("p", { class: "big" }, "Freeze the list as it stands. It becomes final, fingerprinted and signed. Nobody can change it afterwards."),
      L.cutoffLocal ? el("p", { class: "note " + (cut === "passed" ? "ok" : "warn") }, cut === "passed" ? "The closing time has passed: " : "The closing time is ", el("b", {}, window.VL.localTime(L.cutoffLocal)), cut === "future" ? ". You can wait for it, or close enrolment now with the box below." : ".") : el("p", { class: "note warn" }, "No closing time is set. Tick the box below to close enrolment now, or set a closing time in Step 1."),
      cut !== "passed" ? el("label", { style: "display:flex;gap:10px;align-items:center;font-weight:400" }, now, "Close enrolment now") : null,
      el("div", { class: "fieldrow" }, el("div", {}, el("label", { for: "ev" }, "What is the list for?"), ev), el("div", {}, el("label", { for: "et" }, "Kind of event"), type)),
      el("label", { for: "ft" }, "Type FREEZE to confirm"), typed, ack, err, el("div", { class: "row" }, btn), list,
      el("p", { class: "tiny muted" }, "What happens next: the public page shows the final list, with a proof anyone can check. You can reopen the list later for a new meeting.")];
  };

  // ------------------------------------------------------------------------------------------------ extras: audit trail and retention
  const X = { audit: null, erase: null, open: null };
  OR.extras = function () {
    if (!S.ov) return [];
    const mk = (key, title, body) => el("details", { class: "card", open: X.open === key, on: { toggle: (e) => { if (e.target.open) { X.open = key; load(key); } } } }, el("summary", { style: "cursor:pointer;font-weight:600" }, title), el("div", { id: "x-" + key }, X.open === key ? body() : null));
    const load = async (k) => { const n = document.getElementById("x-" + k); if (!n || n.dataset.done) return; n.dataset.done = "1"; try { if (k === "audit") await paintAudit(n); else await paintErase(n); } catch (e) { fail(e); } };
    return [el("h2", { style: "margin-top:24px" }, "More"), mk("audit", "The signed trail: who did what", () => null), mk("erase", "How your details are kept", () => null)];
  };
  async function paintAudit(n) {
    const a = await api("GET", `/api/lists/${S.sid}/audit`);
    const out = el("div"); const res = el("div");
    window.VL.fill(n, el("p", { class: "small muted" }, "Every change is written to a signed, linked log that cannot be edited. The latest entries are below."),
      el("div", { class: "row" }, el("button", { class: "btn small", type: "button", on: { click: async () => { window.VL.fill(res, "Checking…"); let from = 1, ok = true, count = 0; try { while (from) { const v = await api("GET", `/api/lists/${S.sid}/audit/verify?from=${from}&limit=100`); ok = ok && v.ok; count = v.to; from = v.next; } window.VL.fill(res, el("span", { class: "badge " + (ok ? "ok" : "bad") }, ok ? `All ${count} entries check out` : "A problem was found. Please contact support.")); } catch (e) { window.VL.fill(res, ""); fail(e); } } } }, "Check the whole trail"), el("a", { class: "btn ghost small", href: `/api/lists/${S.sid}/audit/export.json` }, "Download the trail"), res), out);
    window.VL.fill(out, window.VL.table(["#", "When", "What", "Who", "Reason given"], a.entries.slice().reverse().map((e) => { const p = a.people[e.entry.actor.pid]; return el("tr", {}, el("td", {}, String(e.entry.seq)), el("td", {}, window.VL.fmtDate(e.entry.ts)), el("td", {}, OR.words(e.entry.type)), el("td", {}, p ? `${p.who} (${p.role})` : e.entry.actor.role === "voter" ? "A voter" : e.entry.actor.role), el("td", {}, whyGiven(e.entry.payload))); })));
  }
  async function paintErase(n) {
    const s = await api("GET", `/api/lists/${S.sid}/erase`); const org = OR.isOrg();
    const typed = el("input", { type: "text", placeholder: "ERASE", autocomplete: "off", id: "er" }), err = window.VL.err();
    if (s.keptAlways) { window.VL.fill(n, el("p", { class: "small" }, "Voter details are kept safely with this list, for as long as your society keeps its voter records. If a voter asks for a change, open their record and correct it: every correction is written to the signed trail. The signed trail never shows a name, an e-mail ID or a number. A record that a voter withdraws by their own choice is cleared after 30 days.")); return; }
    window.VL.fill(n, el("p", { class: "small" }, `Personal details are kept for ${s.retentionDays} days after the final list is frozen, in case it is questioned. After that you can erase them: records, documents and personal details in the history. The signed trail and the list's fingerprint stay, so the meeting can still be proved without showing who was on the list.`),
      s.erased ? el("p", { class: "note ok" }, "The personal details of this list have been erased.") : s.allowedFrom && !s.allowedNow ? el("p", { class: "note" }, "Erasing becomes possible on " + window.VL.fmtDate(s.allowedFrom) + ".") : org ? [el("label", { for: "er" }, "Type ERASE to erase every voter's details from this list"), typed, err, el("div", { class: "row" }, el("button", { class: "btn danger", type: "button", on: { click: async () => { try { await api("POST", `/api/lists/${S.sid}/erase`, { confirm: typed.value }); toast("Erased."); await OR.reload(); } catch (e) { err.show(e.message); } } } }, "Erase now"))] : el("p", { class: "muted" }, "Only the Organizer can erase."));
  }
})();
