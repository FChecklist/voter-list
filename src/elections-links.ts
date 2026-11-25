// The only place where Elections reads anything that belongs to Attendance. Read only: nothing here writes to an Attendance table.
// An election may name an attendance session; a paper ballot is then given only to a person who is marked present in that session.
import type { Env } from "./db";

/** True when the attendance session exists in this list. */
export async function attendanceSessionExists(env: Env, societyId: string, sessionId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM att_sessions WHERE society_id = ? AND id = ?").bind(societyId, sessionId).first());
}

/** True when a person of this flat or house (same e-mail ID) is marked present in the session. */
export async function presentInSession(env: Env, societyId: string, sessionId: string, unitKey: string, email: string): Promise<boolean> {
  return !!(await env.DB.prepare(
    "SELECT 1 AS x FROM att_marks m JOIN voters v ON v.society_id = m.society_id AND v.id = m.voter_id WHERE m.session_id = ? AND m.society_id = ? AND v.unit_key = ? AND lower(v.email) = ? LIMIT 1",
  ).bind(sessionId, societyId, unitKey, email.trim().toLowerCase()).first());
}
