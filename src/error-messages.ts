// Every error or status message the attendance pages can show. One list, used by the server (src/attendance.ts) and by the Hindi test.
export const ERR = {
  notFound: "Not found.",
  erased: "This list has been closed and its details erased.",
  badTitle: "Please type a title of 2 to 80 letters.",
  badMode: "Please choose how people are checked: in person, online or offline.",
  badTime: "Please pick the date and time again.",
  closed: "This session is closed. Nobody can be marked now.",
  personNotOnList: "This person is not on the list for this session.",
  alreadyPresent: "This person is already marked present.",
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
/** Countries a roster may name, with minutes from UTC. */
export const COUNTRY_TZ: Record<string, number> = { India: 330, Bangladesh: 360, Bhutan: 360, Nepal: 345, "Sri Lanka": 330, Singapore: 480, "United Arab Emirates": 240, "United Kingdom": 0, "United States": -300 };
export const badCountry = (countries: string[]) => `Please choose a country from the list: ${countries.join(", ")}.`;

/** Messages from the shared sign-in and request code (auth, handler, store) that these pages also show. */
const SHARED = [
  "Too many tries. Please wait a little and try again.", "Please complete the small safety check first, then ask for the code.", "The safety box did not pass. Please try it once more.",
  "E-mail is not set up on this server yet.", "E-mail is taking a short rest. Please try again a little later, or tomorrow.", "The e-mail could not be sent. Please try again in a few minutes.",
  "Please type a proper e-mail ID.", "That code is not right, or it has expired. Please ask for a new one.", "This role cannot do this. Please ask the Organizer.",
  "Please sign in.", "This link is not valid.", "Please sign in with the code sent to the e-mail ID.", "That e-mail ID could not be read.",
  "This request was not made by the Voter List page.", "This request came from another site.", "That is too large.", "The request could not be read.",
];
/** Messages and toasts written in the page scripts themselves. */
const PAGE = [
  "This list has been closed. Nothing can be marked here.", "Marked present.", "Already marked present.", "Session created.", "Session closed.", "The list is ready.",
];
/** The country message as it appears with the real country list (the one template string). */
export const ERROR_MESSAGES: readonly string[] = [...Object.values(ERR), ...SHARED, ...PAGE, badCountry(Object.keys(COUNTRY_TZ))];
