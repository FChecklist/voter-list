// Shared types and the five "who may vote" rules.
import type { Capacity } from "./text";

export interface Settings {
  ruleCode: 1 | 2 | 3 | 4 | 5;
  weightMode: "equal" | "unequal";
  duesEnabled: boolean;
  duesCutoff: string | null;
  country: string;
  /** what the public list may show of a "not allowed" reason: nothing, the reasons that follow from the role (default), or all */
  reasonPublic?: "none" | "role" | "all";
}

/** One line of a list as it is stored (a working draft or a published version). weight null = not given (counts as 1). */
export interface ListRow {
  id: number;
  rowNo: number;
  unit: string;
  unitKey: string;
  name: string;
  capacity: Capacity | null;
  mobile: string;
  email: string;
  isVoter: boolean | null;
  weightMilli: number | null;
  canAttend: boolean;
  canVote: boolean;
  duesPaidOn: string | null;
  sourceRow?: number | null;
  /** why this person is marked "not allowed" (a code from reasons.ts) and their own words */
  noVoteReason?: string | null;
  noVoteNote?: string | null;
}

export type NewRow = Omit<ListRow, "id">;

export interface Rule { code: 1 | 2 | 3 | 4 | 5; name: string; capacities: Capacity[]; proxy: boolean; blurb: string }
export const RULES: Rule[] = [
  { code: 1, name: "Owner only", capacities: ["Owner", "Co-owner"], proxy: false, blurb: "Only the registered owner may vote." },
  { code: 2, name: "Owner or tenant", capacities: ["Owner", "Co-owner", "Tenant"], proxy: false, blurb: "The owner, or the tenant living in the unit, may vote." },
  { code: 3, name: "Owner or authorised proxy", capacities: ["Owner", "Co-owner", "Proxy"], proxy: true, blurb: "The owner, or a proxy the owner has authorised." },
  { code: 4, name: "Owner, tenant or authorised proxy", capacities: ["Owner", "Co-owner", "Tenant", "Proxy"], proxy: true, blurb: "The owner, the tenant, or an authorised proxy." },
  { code: 5, name: "Member only", capacities: ["Member"], proxy: false, blurb: "Only a member of the society may vote." },
];
export const ruleOf = (code: number): Rule => RULES.find((r) => r.code === code) ?? RULES[0]!;

export const EQUAL_WEIGHT = 1000;
export const rowFields = ["unit", "name", "capacity", "mobile", "email", "isVoter", "weightMilli", "canAttend", "canVote", "duesPaidOn"] as const;
export type RowField = (typeof rowFields)[number];

/** The only fields a person can ask to have corrected through the verification link. */
export const CLAIM_FIELDS = ["name", "mobile", "email", "capacity"] as const;
