import React, { useState } from "react";
// tslint:disable-next-line:no-submodule-imports
import { FaTimes } from "react-icons/fa";
import { graphql, useMutation } from "react-relay";

import { cyrb53 } from "../../../common/hash";
import useConfig from "../../hooks/useConfig";
import usePeople, { PersonSummary } from "../../hooks/usePeople";
import useUserIdentity, {
  adoptPerson,
  forgetPerson,
} from "../../hooks/useUserIdentity";
import Button from "../Button";
import PmdPortraitPicker from "../PmdPortraitPicker";
import * as styles from "./AccountPicker.module.scss";
import { AccountPickerClaimPersonMutation } from "./__generated__/AccountPickerClaimPersonMutation.graphql";
import { AccountPickerCreatePersonMutation } from "./__generated__/AccountPickerCreatePersonMutation.graphql";
import { AccountPickerDeletePersonMutation } from "./__generated__/AccountPickerDeletePersonMutation.graphql";

// People seen more recently than this are "tonight"; everyone else hides
// behind the show-everyone toggle so the grid stays party-sized as the
// registry accumulates across nights.
const RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;

const claimPersonMutation = graphql`
  mutation AccountPickerClaimPersonMutation(
    $personId: String!
    $deviceId: String!
  ) {
    claimPerson(personId: $personId, deviceId: $deviceId) {
      personId
      displayName
      profilePictureUrl
      profilePictureFrame
    }
  }
`;

const createPersonMutation = graphql`
  mutation AccountPickerCreatePersonMutation($input: CreatePersonInput!) {
    createPerson(input: $input) {
      personId
      displayName
      profilePictureUrl
      profilePictureFrame
    }
  }
`;

const deletePersonMutation = graphql`
  mutation AccountPickerDeletePersonMutation($personId: String!) {
    deletePerson(personId: $personId)
  }
`;

interface Props {
  deviceId: string;
  heading: string;
  // Marked as current in the grid; set when switching, unset at the gate.
  currentPersonId?: string | null;
  // Called once this device is attached to somebody.
  onClaimed: () => void;
}

const Avatar = ({
  name,
  profilePictureUrl,
  profilePictureFrame,
}: {
  name: string;
  profilePictureUrl: string | null | undefined;
  profilePictureFrame: string | null | undefined;
}) => {
  if (profilePictureUrl) {
    return (
      <img
        className={`${styles.framedAvatar}${
          profilePictureFrame === "female"
            ? ` ${styles.framedAvatarFemale}`
            : ""
        }`}
        src={profilePictureUrl}
        alt=""
      />
    );
  }
  return (
    <div
      className={styles.badge}
      style={{
        backgroundColor: `hsl(${(cyrb53(name) % 180) + 180}, 50%, 50%)`,
      }}
    >
      {name.slice(0, 1)}
    </div>
  );
};

function lastSeenLabel(lastSeenAt: number): string {
  const minutes = Math.floor((Date.now() - lastSeenAt) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const AccountPicker = ({
  deviceId,
  heading,
  currentPersonId,
  onClaimed,
}: Props) => {
  const people = usePeople();
  const config = useConfig();
  const identity = useUserIdentity();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PersonSummary | null>(
    null,
  );
  const [showAll, setShowAll] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [profilePictureUrl, setProfilePictureUrl] = useState<string | null>(
    null,
  );

  const [commitClaim, claimInFlight] =
    useMutation<AccountPickerClaimPersonMutation>(claimPersonMutation);
  const [commitCreate, createInFlight] =
    useMutation<AccountPickerCreatePersonMutation>(createPersonMutation);
  const [commitDelete] =
    useMutation<AccountPickerDeletePersonMutation>(deletePersonMutation);

  // Same client-side admin check the queue uses (SongQueueItem). The app has
  // no auth at all on the LAN, so this hides the controls rather than
  // enforcing anything. Only offered where someone is actually signed in, so
  // an unclaimed device at the gate never sees it.
  const isAdmin =
    !!currentPersonId &&
    config !== undefined &&
    (config.adminNicks.includes(identity.nickname) ||
      config.adminDeviceIds.includes(identity.deviceId));

  const claim = (person: PersonSummary) => {
    if (claimInFlight) return;
    commitClaim({
      variables: { personId: person.personId, deviceId },
      onCompleted: (response) => {
        adoptPerson(response.claimPerson);
        onClaimed();
      },
    });
  };

  const create = () => {
    const trimmed = displayName.trim();
    if (!trimmed || createInFlight) return;
    commitCreate({
      variables: {
        input: {
          displayName: trimmed,
          deviceId,
          profilePictureUrl,
          profilePictureFrame: "male",
        },
      },
      onCompleted: (response) => {
        adoptPerson(response.createPerson);
        onClaimed();
      },
    });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const deletedPersonId = pendingDelete.personId;
    commitDelete({
      variables: { personId: deletedPersonId },
      onCompleted: () => {
        setPendingDelete(null);
        // Deleting the account this phone is signed in as leaves it attached
        // to nobody, so drop the local cache and let the gate ask again.
        if (deletedPersonId === identity.personId) forgetPerson();
      },
    });
  };

  if (creating) {
    return (
      <div className={styles.picker}>
        <div className={styles.createHeader}>
          <Avatar
            name={displayName || "?"}
            profilePictureUrl={profilePictureUrl}
            profilePictureFrame="male"
          />
          <span>{displayName || "New account"}</span>
        </div>
        <p className={styles.label}>Name</p>
        <form
          className={styles.nicknameForm}
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoFocus={true}
          />
          <Button
            type="submit"
            disabled={!displayName.trim() || createInFlight}
          >
            Start singing
          </Button>
        </form>
        <p className={styles.label}>Avatar</p>
        <PmdPortraitPicker
          selectedUrl={profilePictureUrl}
          onSelect={(url) => setProfilePictureUrl(url)}
        />
      </div>
    );
  }

  // Null while the registry is still loading, so render the heading alone
  // rather than flashing an empty grid and a "new account" button at someone
  // who does have an account.
  if (people === null) {
    return (
      <div className={styles.picker}>
        <h2 className={styles.heading}>{heading}</h2>
      </div>
    );
  }

  const recent = people.filter(
    (person) => Date.now() - person.lastSeenAt < RECENT_WINDOW_MS,
  );
  // Falling back to everyone keeps the first launch of a new night from
  // showing an empty grid when nobody has sung in the last 12 hours.
  const shown = showAll || recent.length === 0 ? people : recent;
  const hidden = people.length - shown.length;

  return (
    <div className={styles.picker}>
      <h2 className={styles.heading}>{heading}</h2>
      <div className={styles.grid}>
        {shown.map((person) => (
          <div className={styles.personSlot} key={person.personId}>
            <button
              className={`${styles.person}${
                person.personId === currentPersonId
                  ? ` ${styles.personCurrent}`
                  : ""
              }`}
              // While editing, the card itself does nothing. The only
              // action is the remove badge, so a mis-tap can't switch you
              // to someone else mid-cleanup.
              onClick={() => (editing ? undefined : claim(person))}
              disabled={claimInFlight || editing}
            >
              <Avatar
                name={person.displayName}
                profilePictureUrl={person.profilePictureUrl}
                profilePictureFrame={person.profilePictureFrame}
              />
              <span className={styles.name}>{person.displayName}</span>
              <span className={styles.lastSeen}>
                {lastSeenLabel(person.lastSeenAt)}
              </span>
            </button>
            {editing && (
              <button
                className={styles.removeBadge}
                onClick={() => setPendingDelete(person)}
                aria-label={`Remove ${person.displayName}`}
              >
                <FaTimes />
              </button>
            )}
          </div>
        ))}
      </div>
      {pendingDelete && (
        <div className={styles.confirmRow}>
          <span>Remove {pendingDelete.displayName}?</span>
          <Button onClick={confirmDelete}>Remove</Button>
          <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
        </div>
      )}
      {hidden > 0 && (
        <button className={styles.showAll} onClick={() => setShowAll(true)}>
          Show everyone ({people.length})
        </button>
      )}
      {!editing && (
        <div className={styles.newAccountRow}>
          <Button full={true} onClick={() => setCreating(true)}>
            + New account
          </Button>
        </div>
      )}
      {isAdmin && (
        <button
          className={styles.showAll}
          onClick={() => {
            setEditing(!editing);
            setPendingDelete(null);
          }}
        >
          {editing ? "Done" : "Edit accounts"}
        </button>
      )}
    </div>
  );
};

export default AccountPicker;
