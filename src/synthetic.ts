// Synthetic voters only. Names, mobiles (9000000xxx style, not allocated to real subscribers in this form) and e-mails (@sample.example,
// a reserved example domain) are invented. Used by the seed script, the tests and the dev server. Never put real people here.
import { toCsv } from "./csv";

const FIRST = ["Asha", "Bharat", "Chitra", "Dev", "Esha", "Farid", "Gita", "Harsh", "Isha", "Jai", "Kiran", "Lata", "Manoj", "Nila", "Om", "Pooja", "Qadir", "Rekha", "Sunil", "Tara", "Uday", "Vani", "Wasim", "Yash", "Zoya"];
function prng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; }; }

export interface SynthOpts { units?: number; seed?: number; defects?: boolean; weights?: boolean; blocks?: string[] }
export const SYNTH_HEADERS = ["ID", "Name", "Capacity", "Mobile", "E-mail", "Voter", "Weight"];

/** Rows of a clean sample society (about 1.25 people per unit: some flats have a co-owner). defects:true adds the usual real-world mess. */
export function synthRows(o: SynthOpts = {}): string[][] {
  const n = o.units ?? 40, rnd = prng(o.seed ?? 7), blocks = o.blocks ?? ["A", "B", "C", "D"];
  const rows: string[][] = [SYNTH_HEADERS];
  let mob = 9000000100;
  for (let i = 0; i < n; i++) {
    const unit = `${blocks[i % blocks.length]}-${101 + Math.floor(i / blocks.length)}`;
    const first = FIRST[Math.floor(rnd() * FIRST.length)]!;
    const w = o.weights ? String(1 + Math.floor(rnd() * 3)) : "";
    const m1 = String(mob++), e1 = `${first.toLowerCase()}${i}@sample.example`;
    const co = rnd() < 0.25;
    rows.push([unit, `SampleOwner ${first}`, "Owner", m1, e1, co ? "Yes" : "", w]);
    if (co) rows.push([unit, `SampleOwner ${FIRST[Math.floor(rnd() * FIRST.length)]!} Jr`, "Co-owner", String(mob++), `co${i}@sample.example`, "", w]);
  }
  if (o.defects) {
    rows.push(["", "SampleOwner NoUnit", "Owner", "9000000999", "nounit@sample.example", "", ""]);                       // empty unit
    rows.push(["A 101", "SAMPLEOWNER SHOUTING", "owner", "+91 90000 00998", "Shout@Sample.Example", "", ""]);            // unit written another way + capitals + formats
    rows.push([rows[1]![0]!, rows[1]![1]!, rows[1]![2]!, rows[1]![3]!, rows[1]![4]!, "", ""]);                           // exact duplicate row
    rows.push(["E-101", "SampleOwner NoMobile", "Owner", "", "nomobile@sample.example", "", ""]);                          // missing mobile
    rows.push(["E-102", "SampleOwner BadMail", "Owner", "9000000997", "not-an-email", "", ""]);                           // bad e-mail
    rows.push(["E-103", "SampleOwner Twin", "Owner", "9000000996", "twin@sample.example", "Yes", ""]);                    // two people authorized in one unit (allowed)
    rows.push(["E-103", "SampleOwner Twin Two", "Co-owner", "9000000995", "twin2@sample.example", "Yes", ""]);
    rows.push(["E-104", "SampleOwner Pair", "Owner", "9000000994", "pair@sample.example", "", ""]);                       // two people, nobody authorized yet (a warning)
    rows.push(["E-104", "SampleOwner Pair Two", "Co-owner", "9000000993", "pair2@sample.example", "", ""]);
    rows.push(["E-105", "SampleOwner Sharer", "Owner", rows[1]![3]!, "sharer@sample.example", "", ""]);                    // same mobile as another unit's voter
  }
  return rows;
}
export const synthCsv = (o: SynthOpts = {}) => toCsv(synthRows(o));
