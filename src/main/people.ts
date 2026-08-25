import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// A singer. This, not deviceId, is what songs, and eventually scores, are
// attributed to. Devices attach to a person (a phone handed around during a
// party belongs to whoever last claimed it), so a cleared localStorage or a
// second device is one tap away from being the same singer again.
export interface Person {
  personId: string;
  displayName: string;
  profilePictureUrl: string | null;
  profilePictureFrame: string | null;
  deviceIds: string[];
  createdAt: number;
  lastSeenAt: number;
}

// What a device sends about itself before it has a personId: the shape both
// the bootstrap migration (from songHistory) and the legacy auto-claim path
// (a remocon on a cached bundle) work from.
export interface PersonSeed {
  deviceId: string;
  nickname: string;
  profilePictureUrl?: string | null;
  profilePictureFrame?: string | null;
  lastSeenAt?: number;
}

// userData, not the temp dir where queue.json lives: the registry's whole
// point is surviving, and an OS temp sweep would wipe the room's identities.
// Same reasoning as the score cards and probe logs in main/index.ts.
const PEOPLE_PATH = path.join(app.getPath("userData"), "people.json");
const FILE_VERSION = 1;

let people: Person[] = [];
let touchSaveTimer: ReturnType<typeof setTimeout> | null = null;

function writePeopleToDisk(): void {
  try {
    fs.writeFileSync(
      PEOPLE_PATH,
      JSON.stringify({ version: FILE_VERSION, people }),
      "utf-8",
    );
  } catch (e) {
    console.error("[people] failed to save registry", e);
  }
}

// lastSeenAt bumps happen on every queue; coalesce those rather than writing
// the whole registry per song. Structural changes (create/claim/release) save
// synchronously instead, since losing one of those loses an identity.
function scheduleTouchSave(): void {
  if (touchSaveTimer) return;
  touchSaveTimer = setTimeout(() => {
    touchSaveTimer = null;
    writePeopleToDisk();
  }, 2000);
}

export function flushPeople(): void {
  if (touchSaveTimer) {
    clearTimeout(touchSaveTimer);
    touchSaveTimer = null;
  }
  writePeopleToDisk();
}

function isPerson(value: any): value is Person {
  return (
    value &&
    typeof value.personId === "string" &&
    typeof value.displayName === "string" &&
    Array.isArray(value.deviceIds)
  );
}

// `bootstrap` runs only when there's no registry on disk yet, synthesizing
// one person per deviceId seen in the existing song history so the first
// launch after this feature doesn't turn the whole room into strangers.
export function loadPeople(bootstrap: () => PersonSeed[]): void {
  try {
    if (fs.existsSync(PEOPLE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(PEOPLE_PATH, "utf-8"));
      people = (parsed?.people ?? []).filter(isPerson);
      console.log(`[people] loaded ${people.length} people`);
      return;
    }
  } catch (e) {
    console.error("[people] failed to load registry, starting empty", e);
    people = [];
    return;
  }

  const seeds = bootstrap();
  const byDevice = new Map<string, PersonSeed>();
  // Seeds arrive newest-first (songHistory is unshifted), so the first seed
  // for a device is its latest nickname/avatar; later ones are stale.
  for (const seed of seeds) {
    if (!seed.deviceId || byDevice.has(seed.deviceId)) continue;
    byDevice.set(seed.deviceId, seed);
  }

  const now = Date.now();
  people = [...byDevice.values()].map((seed) => ({
    personId: uuidv4(),
    displayName: seed.nickname,
    profilePictureUrl: seed.profilePictureUrl ?? null,
    profilePictureFrame: seed.profilePictureFrame ?? null,
    deviceIds: [seed.deviceId],
    createdAt: seed.lastSeenAt ?? now,
    lastSeenAt: seed.lastSeenAt ?? now,
  }));
  console.log(`[people] bootstrapped ${people.length} people from history`);
  writePeopleToDisk();
}

export function listPeople(): Person[] {
  return [...people].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function personById(personId: string): Person | null {
  return people.find((person) => person.personId === personId) ?? null;
}

export function personByDevice(deviceId: string): Person | null {
  return people.find((person) => person.deviceIds.includes(deviceId)) ?? null;
}

export function createPerson(seed: PersonSeed): Person {
  const now = Date.now();
  const person: Person = {
    personId: uuidv4(),
    displayName: seed.nickname,
    profilePictureUrl: seed.profilePictureUrl ?? null,
    profilePictureFrame: seed.profilePictureFrame ?? null,
    deviceIds: seed.deviceId ? [seed.deviceId] : [],
    createdAt: now,
    lastSeenAt: now,
  };
  // A device belongs to exactly one person, so creating from a device that
  // already belongs to someone moves it rather than duplicating it.
  if (seed.deviceId) detachDevice(seed.deviceId);
  people.push(person);
  writePeopleToDisk();
  return person;
}

function detachDevice(deviceId: string): boolean {
  let changed = false;
  for (const person of people) {
    const idx = person.deviceIds.indexOf(deviceId);
    if (idx !== -1) {
      person.deviceIds.splice(idx, 1);
      changed = true;
    }
  }
  return changed;
}

export function claimPerson(personId: string, deviceId: string): Person | null {
  const person = personById(personId);
  if (!person) return null;
  detachDevice(deviceId);
  person.deviceIds.push(deviceId);
  person.lastSeenAt = Date.now();
  writePeopleToDisk();
  return person;
}

// Admin cleanup for duplicates and one-time guests. Their devices are left
// unclaimed, so those phones get the identity gate on next load; song history
// keeps the identity snapshot it recorded at queue time, so past songs still
// show a name and avatar.
export function deletePerson(personId: string): boolean {
  const idx = people.findIndex((person) => person.personId === personId);
  if (idx === -1) return false;
  people.splice(idx, 1);
  writePeopleToDisk();
  return true;
}

export function updatePersonProfile(
  personId: string,
  update: {
    displayName?: string;
    profilePictureUrl?: string | null;
    profilePictureFrame?: string | null;
  },
): Person | null {
  const person = personById(personId);
  if (!person) return null;

  let changed = false;
  if (update.displayName && update.displayName !== person.displayName) {
    person.displayName = update.displayName;
    changed = true;
  }
  if (
    update.profilePictureUrl !== undefined &&
    update.profilePictureUrl !== person.profilePictureUrl
  ) {
    person.profilePictureUrl = update.profilePictureUrl;
    changed = true;
  }
  if (
    update.profilePictureFrame !== undefined &&
    update.profilePictureFrame !== person.profilePictureFrame
  ) {
    person.profilePictureFrame = update.profilePictureFrame;
    changed = true;
  }

  if (changed) writePeopleToDisk();
  return person;
}

export function touchPerson(personId: string): void {
  const person = personById(personId);
  if (!person) return;
  person.lastSeenAt = Date.now();
  scheduleTouchSave();
}

// Resolves whatever a client sent to a person, creating one if the device is
// unknown. Registry-aware clients can't get here unclaimed (the gate blocks
// them), so this is the legacy path: a remocon on a cached bundle sends only
// a deviceId + nickname, and self-claims by queuing.
export function resolvePerson(identity: {
  personId?: string | null;
  deviceId: string;
  nickname: string;
  profilePictureUrl?: string | null;
  profilePictureFrame?: string | null;
}): Person {
  if (identity.personId) {
    const claimed = personById(identity.personId);
    if (claimed) return claimed;
  }

  const byDevice = personByDevice(identity.deviceId);
  if (byDevice) return byDevice;

  console.log(
    `[people] auto-creating person for unknown device ${identity.deviceId} (${identity.nickname})`,
  );
  return createPerson({
    deviceId: identity.deviceId,
    nickname: identity.nickname,
    profilePictureUrl: identity.profilePictureUrl,
    profilePictureFrame: identity.profilePictureFrame,
  });
}
