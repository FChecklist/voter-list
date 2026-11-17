// Retention and erasure (DPDP Act 2023: personal data is kept only while the purpose lasts). After the retention period the Organizer can erase every
// person's details, documents and the record histories of a list. What stays: the signed audit trail (pseudonyms and counts only) and each
// publication's fingerprint, so the fact that a list existed and was frozen at a time can still be shown, but not who was on it.
import { HttpError } from "./auth";
import { commit, guardChanged, staffActor } from "./audit";
import { need, type StaffCtx } from "./store";

/** The owner's rule (13 Nov): voter records are kept always. Erasing is therefore off unless RETENTION_DAYS is set (a whole number of days, at least 30) after a legal review. */
export const retentionDays = (ctx: StaffCtx): number | null => { const n = Number(ctx.env.RETENTION_DAYS); return ctx.env.RETENTION_DAYS && Number.isInteger(n) && n >= 30 ? n : null; };

export async function eraseStatus(ctx: StaffCtx) {
  const f = await ctx.env.DB.prepare("SELECT published_at FROM publications WHERE society_id = ? AND kind = 'frozen' ORDER BY published_at DESC LIMIT 1").bind(ctx.society.id).first<{ published_at: number }>();
  const days = retentionDays(ctx);
  if (days === null) return { erased: !!ctx.society.erased_at, keptAlways: true, retentionDays: null as number | null, allowedFrom: null as number | null, allowedNow: false };
  const allowedFrom = f ? f.published_at + days * 86_400_000 : null;
  return { erased: !!ctx.society.erased_at, keptAlways: false, retentionDays: days as number | null, allowedFrom, allowedNow: !ctx.society.erased_at && (allowedFrom === null || ctx.now >= allowedFrom) };
}

export async function eraseList(ctx: StaffCtx, input: { confirm?: string }) {
  need(ctx, "reopen");
  const st = await eraseStatus(ctx);
  if (st.erased) throw new HttpError(409, "This list has already been erased.", "erased");
  if (st.keptAlways) throw new HttpError(409, "Voter records are kept safely with the list, as long as the society keeps its voter records. To correct a detail, please edit the record.", "kept");
  if (!st.allowedNow) throw new HttpError(409, `The final list is kept for ${st.retentionDays} days after it was frozen, in case it is questioned. Erasing becomes possible after that.`, "retention");
  if (String(input.confirm ?? "").trim().toUpperCase() !== "ERASE") throw new HttpError(400, "Please type ERASE to confirm. This cannot be undone.", "confirm");
  const db = ctx.env.DB, sid = ctx.society.id;
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM voters WHERE society_id = ?").bind(sid).first<{ n: number }>())?.n ?? 0;
  await commit(ctx.env, sid, [
    db.prepare("UPDATE societies SET erased_at = ?, phase = 'frozen' WHERE id = ? AND erased_at IS NULL").bind(ctx.now, sid), guardChanged(ctx.env, "This list was already erased."),
    db.prepare("DELETE FROM voter_docs WHERE society_id = ?").bind(sid),
    db.prepare("UPDATE voter_events SET before_json = NULL, after_json = NULL, actor_email = '(erased)' WHERE society_id = ?").bind(sid),
    db.prepare("DELETE FROM mail_outbox WHERE to_addr IN (SELECT email FROM voters WHERE society_id = ?)").bind(sid), // notes mailed to voters carry their reason text
    db.prepare("DELETE FROM voters WHERE society_id = ?").bind(sid),
    db.prepare("DELETE FROM publication_rows WHERE society_id = ?").bind(sid),
    db.prepare("DELETE FROM sessions WHERE society_id = ?").bind(sid),
    db.prepare("DELETE FROM otp_codes WHERE society_id = ?").bind(sid),
  ], "list.erased", await staffActor(ctx.env, ctx.email, ctx.role), { records: n }, ctx.now);
  return { erased: true, records: n };
}
