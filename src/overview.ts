// Everything the organizer page needs to draw its step bar in one call.
import { checksView, listPublications } from "./publish";
import { listTeam, viewList, MAX_HOSTS } from "./lists";
import { RULES } from "./model";
import { counts } from "./review";
import { seesFull, type StaffCtx } from "./store";

export async function overview(ctx: StaffCtx) {
  const { env, society } = ctx;
  const [c, ch, team, pubs] = await Promise.all([counts(ctx), checksView(ctx), listTeam(ctx), listPublications(ctx)]);
  const list = viewList(society);
  const draft = pubs.publications.find((p) => p.kind === "draft");
  const frozen = pubs.publications.find((p) => p.kind === "frozen");
  const total = c.invited! + c.draft! + c.submitted! + c.approved! + c.sent_back!;
  const done = {
    setup: true,
    share: !!society.link_shared_at || total > 0,
    team: society.hosts_skipped === 1 || team.hostsUsed > 0,
    review: total > 0 && c.submitted === 0 && c.approved! > 0,
    checks: ch.canFreeze && ch.errors === 0,
    draft: !!draft && (!frozen || draft.publishedAt > frozen.publishedAt) || society.phase === "frozen" && !!frozen,
    frozen: society.phase === "frozen",
  };
  const order = ["setup", "share", "team", "review", "checks", "draft", "frozen"] as const;
  const current = society.phase === "frozen" ? "frozen" : order.find((s) => !done[s]) ?? "frozen";
  return {
    role: ctx.role, you: ctx.email, permanentHost: ctx.permanent, masked: !seesFull(ctx), list,
    rules: RULES.map((r) => ({ code: r.code, name: r.name, blurb: r.blurb, proxy: r.proxy, capacities: r.capacities })),
    counts: c, checks: { errors: ch.errors, warnings: ch.warnings, summary: ch.summary, canFreeze: ch.canFreeze, onList: ch.onList, notIncluded: ch.notIncluded },
    team: { hostsUsed: team.hostsUsed, max: MAX_HOSTS }, publications: pubs.publications.slice(0, 20),
    steps: { done, current }, now: ctx.now,
    price: env.PRICE_INR ? { inr: Number(env.PRICE_INR), live: false } : null,
  };
}
