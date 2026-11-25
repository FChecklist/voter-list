// Every error or status message the attendance pages can show, and every other text the server builds for them (the session modes, the reasons a
// sheet row is left out, the country names). One list, used by the server (src/attendance.ts) and by the Hindi and wording tests.
// A text built here is shown on pages that have a language button, so each one has a Hindi line in public/assets/lang/hi.js (a test checks it).
// No Hindi line is written for a consent notice (the owner's rule), and none of these texts is one.
export const ERR = {
  notFound: "Not found.",
  erased: "This list has been closed and its details erased.",
  badTitle: "Please type a title of 2 to 80 letters.",
  badMode: "Please choose how people are checked: in person, online or offline.",
  badTime: "Please pick the date and time again.",
  closed: "This session is closed. Nobody can be marked now.",
  personNotOnList: "This person is not on the list for this session.",
  alreadyPresent: "This person is already marked present.",
  onePerEmail: "This e-mail ID has already marked one person present in this session. An e-mail ID counts as one person, even on more than one flat. To mark someone else, please ask the Organizer or a co-organizer.", // at most 200 letters: a guard keeps no more
  closedMeanwhile: "This session was closed at the same moment.",
  alreadyClosed: "This session is already closed.",
  notOnline: "This session is not online. Please ask the Organizer or a co-organizer to mark you present.",
  tooEarly: "This session has not started yet. Please try again 15 minutes before it starts.",
  tooLate: "This session ended more than 12 hours ago. Please ask the Organizer or a co-organizer to mark you present.",
  emailNotOnList: "This e-mail ID is not on the list for this session.",
  whichOne: "This e-mail ID is on the list more than once. Please say which one.",
  notOrganizer: "New lists are started by Organizers that Townhall Records has set up. Please ask us to add the e-mail ID, and you can begin right away.",
  badFormat: "Choose an Excel file, a CSV file or paste the list.",
  badListName: "Please type a name for this list, 2 to 80 letters.",
  badFile: "That file could not be read.",
  nothingNew: "There is nothing to bring in: every row had a problem.",
  tooMany: "A list can hold up to 6000 people.",
  tooManyLists: "One person can organise up to 10 lists here.",
} as const;

/** How a session is checked, as the server words it (`modeText` in every session view). */
export const MODE_WORDS = { in_person: "In person", online: "Online", offline: "Offline" } as const;

/** Why a row of an uploaded sheet is left out, as the server words it (`why` in the preview). */
export const ROSTER_WHY = {
  noEmail: "No e-mail ID, or the e-mail ID is not valid. The e-mail ID is how a person is verified.",
  noUnit: "No Flat / House / Member ID.",
  badUnit: "The Flat / House / Member ID looks wrong (for example a phone number or an e-mail ID).",
  noName: "No name, or the name is too long.",
  duplicate: "The same ID and e-mail ID appear earlier.",
} as const;

/** Countries a roster may name, with minutes from UTC. */
export const COUNTRY_TZ: Record<string, number> = { India: 330, Bangladesh: 360, Bhutan: 360, Nepal: 345, "Sri Lanka": 330, Singapore: 480, "United Arab Emirates": 240, "United Kingdom": 0, "United States": -300 };
export const badCountry = (countries: string[]) => `Please choose a country from the list: ${countries.join(", ")}.`;

/** The messages of the sheet reader (src/importer.ts, src/xlsx.ts, src/csv.ts) that reach the upload form. */
export const UPLOAD_ERRORS: readonly string[] = [
  "We could not find the heading row. The first column should be called 'Flat / House / Member ID' (or 'ID'). Please use the template.",
  "The Excel file is empty.", "There is nothing to read. Please choose a file or paste the list.", "The heading row was found but there are no people below it.",
  "More than 6000 rows. Please split the list.",
  "This does not look like an Excel (.xlsx) file.", "This Excel file has too many parts.", "The Excel file is damaged.", "This Excel file expands to an unreasonable size.",
  "This Excel file uses a compression this reader does not know.", "This Excel file is larger than 8 MB. Please split the list.", "The first sheet of the Excel file could not be found.",
  "This file is larger than 3 MB. Please split the list.", "A quotation mark was opened and never closed. Please check the file.",
];
/** The message src/lists.ts builds when a title, a place or a list name holds a phone number or an e-mail ID (`noContactDetails`), for the three words the attendance code gives it. */
export const NO_CONTACT: readonly string[] = ["the title", "the place", "the name"].map((what) => `Please do not write phone numbers or e-mail IDs in ${what}.`);

/** Messages from the shared sign-in and request code (auth, handler, store, audit) that these pages also show. The handler builds the last two itself (a failure on our side, and a fixed record). */
const SHARED = [
  "Too many tries. Please wait a little and try again.", "Please complete the small safety check first, then ask for the code.", "The safety box did not pass. Please try it once more.",
  "E-mail is not set up on this server yet.", "E-mail is taking a short rest. Please try again a little later, or tomorrow.", "The e-mail could not be sent. Please try again in a few minutes.",
  "Please type a proper e-mail ID.", "That code is not right, or it has expired. Please ask for a new one.", "This role cannot do this. Please ask the Organizer.",
  "Please sign in.", "This link is not valid.", "Please sign in with the code sent to the e-mail ID.", "That e-mail ID could not be read.",
  "This request was not made by the Voter List page.", "This request came from another site.", "That is too large.", "The request could not be read.",
  "Several codes were sent to this e-mail ID already. Please check the inbox (and the spam folder), or try again in an hour.", "This e-mail ID has had all its codes for today. Please try again tomorrow.",
  "Someone else changed this at the same moment. Please look again and try once more.", "Many people are saving at the same moment. Nothing was lost; please try again in a few seconds.",
  "Something went wrong on our side. Nothing was lost; please try again.", "That record is fixed and cannot be changed.",
];
/** Messages and toasts written in the page scripts themselves. */
const PAGE = [
  "This list has been closed. Nothing can be marked here.", "Marked present.", "Already marked present.", "Session created.", "Session closed.", "The list is ready.",
  "This page could not be opened just now. Nothing was changed. Please try again.",
];
/** The country message as it appears with the real country list (the one template string). */
export const ERROR_MESSAGES: readonly string[] = [...Object.values(ERR), ...SHARED, ...PAGE, ...UPLOAD_ERRORS, ...NO_CONTACT, badCountry(Object.keys(COUNTRY_TZ))];

/** Everything the server words for these pages: the messages above, the session modes, the reasons a sheet row is left out and the country names. Each has a Hindi line. */
export const SERVER_TEXTS: readonly string[] = [...new Set([...ERROR_MESSAGES, ...Object.values(MODE_WORDS), ...Object.values(ROSTER_WHY), ...Object.keys(COUNTRY_TZ)])];
