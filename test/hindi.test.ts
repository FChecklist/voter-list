// Strings added or changed by the voter-list wording pull request must keep a Hindi entry (exact English key, or a matching pattern).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const win: any = {}; new Function("window", readFileSync("public/assets/lang/hi.js", "utf8"))(win);
const hi = win.VL_LANGS.hi;
const has = (s: string) => Object.prototype.hasOwnProperty.call(hi.words, s.trim()) || hi.patterns.some(([re]: [RegExp]) => re.test(s.trim()));

const STRINGS = [
  "Organizer", "Co-organizer", "Co-organizers", "A co-organizer was added", "A co-organizer was removed",
  "Build, check, publish and freeze the voter list for a meeting or election. For Organizers and Co-organizers.",
  "Step 1. Set up the list", "Step 3. Team", "Let us set up the voter list", "Lists",
  "Create the list and get the link", "Registration number / ID",
  "Please type the registration number / ID of the society or association.",
  "Remove this co-organizer?", "Add this co-organizer", "Add a co-organizer by e-mail ID",
  "Co-organizer added. They were told by e-mail.",
  "This is the team. The Organizer adds and removes co-organizers. Townhall Records keeps one standing co-organizer to help.",
  "Nothing changed: a reviewer cannot decide on their own record, or it changed meanwhile.",
  "Flats that need a choice", "How the details are kept",
  "Test mode: the code is 123456",
  "a@b.example becomes the Organizer, and you become a Co-organizer. Only the Organizer can publish.",
  "2 of 10 co-organizer seats used (the Townhall Records co-organizer is extra).",
  "2 of 10 co-organizers",
  "3 approved. 1 skipped because they changed meanwhile or are the reviewer's own.",
  "The list has not been published yet. When the list team publishes it, you will find it here with the name masked as ",
];

test("every string handled in this pull request has a Hindi entry", () => {
  expect(STRINGS.filter((s) => !has(s))).toEqual([]);
});
test("the Hindi value is not the English text", () => {
  for (const s of STRINGS.filter((x) => Object.prototype.hasOwnProperty.call(hi.words, x.trim()))) expect(hi.words[s.trim()]).not.toBe(s.trim());
});
