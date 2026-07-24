# Singer identity — spec

Design for replacing the current device-scoped identity with a durable
**person registry**, so a singer is the same singer across devices, browser
cache clears, and nights. Phase 1 is implemented; phases 2 and 3 are not.

## Why

Identity today is a `uuidv4` in `localStorage` plus a `window.prompt()`
nickname ([useUserIdentity.ts](../src/remocon/hooks/useUserIdentity.ts)). Every
mutation carries a `UserIdentityInput` and the server records whatever the
client sends — there is no server-side notion of a person at all.
`latestIdentityByDevice` ([graphql.ts:1599](../src/main/graphql.ts:1599)) is the
closest thing, and it's an in-memory `Map` that dies with the process.

Four failure modes fall out of that:

1. **Cleared storage / different browser → a stranger.** Both the nickname and
   the deviceId live in `localStorage`, so there is nothing left to recognize.
2. **One person, two devices → two people.** Phone and laptop never merge, and
   each independently gets the full `paxSongQueueLimit`.
3. **Nicknames drift and collide.** Renaming rewrites the queue but not
   history; two people can both be "Jun" with no way to tell them apart.
4. **A handed-around phone attributes everything to its owner.** The common
   party case has no answer at all right now.

Scoring makes this urgent rather than cosmetic. Personal bests, leaderboards,
and the end-of-night recap all need an attribution key that survives a cache
clear, and `deviceId` is not that key.

## Model

A **Person** is the unit of attribution. Devices are attached to a person and
are otherwise uninteresting.

```ts
type Person = {
  personId: string; // uuidv4, generated server-side
  displayName: string;
  profilePictureUrl: string | null; // host-relative /portraits/... as today
  profilePictureFrame: "male" | "female" | null;
  deviceIds: string[]; // every device that has claimed this person
  createdAt: number; // epoch ms
  lastSeenAt: number; // epoch ms; drives roster ordering
};
```

`UserIdentity` stays on the wire exactly as it is, gaining one **nullable**
field:

```graphql
type UserIdentity {
  nickname: String!
  deviceId: String!
  profilePictureUrl: String
  profilePictureFrame: String
  personId: String # null from pre-registry clients
}
```

Nullable and additive on purpose. `queue.json` and `songHistory` persist
embedded `UserIdentity` snapshots; making `personId` required would invalidate
every existing entry and every phone running a cached bundle.

### Where it's stored

**`<userData>/people.json`**, _not_ `queue.json`.

`queue.json` lives in `karafriends_tmp/` under the OS temp dir, which gets
swept — fine for a queue, fatal for the registry, whose entire value is
durability. This follows the precedent already set for score cards and probe
logs (commit `4ff2992f`), which moved to `userData` for the same reason.

```json
{
  "version": 1,
  "people": [
    /* Person[] */
  ]
}
```

Debounce-saved on mutation (same shape as `reading-cache.json`), loaded once at
startup.

### Bootstrap migration

On first load with no `people.json`, synthesize the registry from
`db.songHistory`: group entries by `userIdentity.deviceId`, take the most
recent nickname/avatar per device, emit one person each. The room's existing
history keeps its attribution instead of everyone starting as a stranger.

## GraphQL surface

```graphql
type Person {
  personId: String!
  displayName: String!
  profilePictureUrl: String
  profilePictureFrame: String
  lastSeenAt: Float!
}

type Query {
  # Roster, most recently seen first.
  people: [Person!]!
  # The person this device last claimed, or null if unclaimed.
  personByDevice(deviceId: String!): Person
}

type Mutation {
  createPerson(input: CreatePersonInput!): Person!
  # Attach deviceId to an existing person (the "that's me" tap).
  claimPerson(personId: String!, deviceId: String!): Person!
  # Admin cleanup. Their devices fall back to the gate; history keeps the
  # snapshots it already recorded.
  deletePerson(personId: String!): Boolean!
  # Phase 2. Fold source into target: move deviceIds, rewrite queue + history.
  mergePeople(sourcePersonId: String!, targetPersonId: String!): Boolean!
}

type Subscription {
  peopleChanged: [Person!]!
}
```

There is deliberately **no `updatePerson`**: the profile page already fires
`updateUserIdentity` on every edit, so that mutation writes through to the
registry instead of adding a second endpoint the client would never call.

`updateUserIdentity` stays, unchanged in signature. Internally it now also
updates the person the device is attached to, so an old client renaming itself
still lands in the registry.

The subscription is what keeps the "who's singing?" grid live — someone joining
on another phone appears in your picker without a reload, same pattern as every
other synced setting.

## Client flow

### Boot resolution (`useUserIdentity`)

1. Read `deviceId` from `localStorage`; generate if absent.
2. Query `personByDevice(deviceId)`.
   - **Hit** → adopt it. The server is the authority, so a rename done on
     another device shows up here automatically.
   - **Miss** → render the identity gate (below). Nothing else in the app
     mounts until it resolves.
3. Cache `personId` + the display fields in `localStorage` for offline-ish
   reads, but always reconcile against the server answer on boot.

**Be honest about the limit**: `deviceId` also lives in `localStorage`, so
clearing storage loses the device key too. `personByDevice` cannot heal that
case — the claim screen is what heals it, by letting the new deviceId attach to
the existing person in one tap. This is the mechanism, not a workaround.

### The identity gate

A full-screen picker shown when a device is unclaimed. **An unclaimed device
cannot queue** — the gate is a hard block, not a nudge, and nothing else in the
app mounts behind it.

> **New phone, who this?**
> [portrait grid: name + PMD avatar, most recently seen first]
> **＋ New account**

- Tapping a face → `claimPerson` → straight into the app.
- **＋ New account** → the existing ProfilePage flow (name + `PmdPortraitPicker`)
  → `createPerson`.
- People not seen in the last 12 hours collapse behind a "show everyone"
  expander, so the grid stays tonight-sized as the registry grows.
- Duplicate display names are allowed; the avatar disambiguates.
- No explanatory subtitle. A grid of faces above a "new account" button reads
  without instructions.

The block needs no server-side enforcement to hold. A registry-aware client
can't reach a queue button before the gate resolves, and a legacy client
sending no `personId` self-claims through the auto-create path below — so
"unclaimed device queues a song" is not a reachable state either way.

This **replaces the `window.prompt()`** in `useUserIdentity`, which is a bonus:
that prompt is the documented cause of the blank-page-in-headless-browser
gotcha in CLAUDE.md, and it goes away entirely.

The existing first-time-device redirect to `#/profile`
([App.tsx:41](../src/remocon/App.tsx:41)) is superseded — the gate handles new
devices, and `createPerson` already collects name and avatar.

### Switch account

The NavBar avatar opens a **Switch account** drawer over the same grid. This is
the direct answer to the handed-around phone: tap your face, queue your song,
hand it back. Also the escape hatch when someone claims the wrong person, and
where "Edit profile" now lives.

There is no "unclaim this device" action. A phone is always somebody — the way
to stop being you is to become someone else, and an admin deleting an account
covers the rest.

### Editing accounts (admin)

Admins get an **Edit accounts** toggle in that drawer. While editing, each card
carries a remove badge on its corner, card taps are inert (so a mis-tap can't
switch you mid-cleanup), and removing asks for confirmation by name. This is
the cleanup path for duplicates and one-time guests.

Admin is the same client-side check the queue already uses in
[SongQueueItem](../src/remocon/components/SongQueue/SongQueueItem.tsx) —
`adminNicks` / `adminDeviceIds` from `config`. It hides the controls rather
than enforcing anything: the whole GraphQL API is unauthenticated on the LAN,
so a server-side check on a client-asserted identity would be decoration. The
toggle only appears where someone is signed in, so an unclaimed device at the
gate can never see it.

## Server-side behavior changes

- **`pushSongToQueue`** stamps the person's current snapshot onto the queue
  item. `latestIdentityByDevice` is replaced by a registry lookup, which also
  makes it survive restarts (it doesn't today).
- **`hasMaxSongsInQueue` counts per person, not per device**
  ([graphql.ts:1561](../src/main/graphql.ts:1561)). Today one person with two
  devices gets double the limit while two people sharing a phone split one.
  Both are wrong in the same way and both fix here.
- **Admin gating** resolves through the person: admin if any linked deviceId is
  in `adminDeviceIds`, or the display name is in `adminNicks`. No config change
  and no migration — the existing lists keep working.
- **`mergePeople`** rewrites `personId` and the identity snapshot on matching
  entries in `db.songQueue`, `db.currentSong`, and `db.songHistory`, then moves
  the deviceIds over. This is the cleanup tool for the dupes that will happen
  regardless of how good the gate is.

## Backwards compatibility

- A phone on a cached bundle sends no `personId`. The server resolves by
  `deviceId`; if that device is unknown, it auto-creates a person from the
  nickname it sent. The old flow keeps working untouched.
- `personId` is nullable on `UserIdentity` and in every input, so existing
  `queue.json` and `songHistory` entries load without migration.
- The renderer reads identity from the queue item's embedded snapshot, as it
  does now — no renderer change is required for phase 1.

## What this unlocks

`personId` is the key the scoring features have been waiting for. Once it
exists, `reportSongScore(personId, songId, score, band)` writing a
`db.scores` keyed by person gives leaderboard, personal bests, per-singer
stats, and the recap card off one foundation. Nothing in this spec should make
`personId` optional in _history_ — only on the wire for old clients.

### Local-only, deliberately

No accounts, no external identity provider, no network dependency. The registry
is a JSON file on the machine running the app, and every flow below works with
the WAN unplugged — which matters, because the room's phones already depend on
nothing but the LAN to reach :8080.

The thing an account system would buy is impersonation resistance and identity
that follows someone to a different host's party. Neither is a problem in a
living room, and both cost a real domain, certs, and a sign-in wall between a
guest and the queue button.

## Phasing

**Phase 1 — built.** Registry + `people.json` + bootstrap migration, `people` /
`personByDevice`, `createPerson` / `claimPerson` / `deletePerson`,
`peopleChanged`, the identity gate, switch account, admin account editing,
per-person queue limit.

**Phase 2 — cleanup and visibility.** `mergePeople`, a tonight's-singers roster
on the renderer, per-person filter on
[HistoryPage](../src/remocon/pages/HistoryPage.tsx).

**Phase 3 — scores keyed by person.** Out of scope here; this is what phase 1
exists to enable.

## Verification plan

- curl the new query/mutations against :8080 (POST-only, `--data-binary @file`
  for UTF-8 names).
- Inspect `<userData>/people.json` across an app restart — the registry must
  survive, unlike `latestIdentityByDevice` today.
- Drive the real remocon through the TCP-proxy preview entry
  (`karafriends-remocon-via-app`): claim as a new person, clear
  `localStorage`, reload, confirm the gate appears and one tap restores
  attribution.
- Two browser profiles claiming the same person → confirm the queue limit
  counts them as one.
- Relay-compile after the schema change; typecheck must stay at 0 errors.

## Open questions

1. **Roster scope.** Is the people list per-room-forever, or should it decay
   (hide people not seen in N weeks)? Currently forever, with a last-12-hours
   filter on the picker only.

Settled:

- **Gate strictness** — an unclaimed device is blocked from queuing outright,
  no anonymous-with-a-nudge path.
- **Guests** — no ephemeral guest account. Admin "Edit accounts" cleanup
  covers the one-time visitor after the fact.
