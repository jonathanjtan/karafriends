import React, { useEffect, useState } from "react";
import { graphql, useMutation } from "react-relay";

import { cyrb53 } from "../../common/hash";
import Button from "../components/Button";
import PmdPortraitPicker from "../components/PmdPortraitPicker";
import useUserIdentity, {
  setNickname,
  setProfilePictureFrame,
  setProfilePictureUrl,
} from "../hooks/useUserIdentity";
import * as styles from "./ProfilePage.module.scss";
import { ProfilePageUpdateUserIdentityMutation } from "./__generated__/ProfilePageUpdateUserIdentityMutation.graphql";

// Rewrites the identity on this device's already-queued songs so profile
// edits show up in the queue immediately instead of only on future queues.
const updateUserIdentityMutation = graphql`
  mutation ProfilePageUpdateUserIdentityMutation(
    $identity: UserIdentityInput!
  ) {
    updateUserIdentity(identity: $identity)
  }
`;

const ProfilePage = () => {
  const identity = useUserIdentity();
  // null = untouched; the input shows the stored nickname until edited.
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);
  const [commitIdentityUpdate] =
    useMutation<ProfilePageUpdateUserIdentityMutation>(
      updateUserIdentityMutation,
    );

  // Push every identity change (and the current identity on mount, which
  // heals queue items from before this page was opened) to the server so
  // already-queued songs pick it up.
  useEffect(() => {
    if (identity.deviceId === "Unknown") return;
    commitIdentityUpdate({
      variables: {
        identity: {
          deviceId: identity.deviceId,
          nickname: identity.nickname,
          profilePictureUrl: identity.profilePictureUrl,
          profilePictureFrame: identity.profilePictureFrame,
        },
      },
    });
  }, [identity]);

  const displayedNickname = nicknameDraft ?? identity.nickname;
  const trimmedDraft = (nicknameDraft ?? "").trim();
  const canSaveNickname =
    nicknameDraft !== null &&
    trimmedDraft.length > 0 &&
    trimmedDraft !== identity.nickname;

  const saveNickname = () => {
    if (!canSaveNickname) return;
    setNickname(trimmedDraft);
    setNicknameDraft(null);
  };

  const nicknameHash = cyrb53(identity.nickname);
  const badgeBgColor = `hsl(${(nicknameHash % 180) + 180}, 50%, 50%)`;

  return (
    <div className={styles.profilePage}>
      <h2>Profile</h2>
      <div className={styles.currentProfile}>
        {identity.profilePictureUrl ? (
          <img
            className={`${styles.framedAvatar}${
              identity.profilePictureFrame === "female"
                ? ` ${styles.framedAvatarFemale}`
                : ""
            }`}
            src={identity.profilePictureUrl}
            alt=""
          />
        ) : (
          <div
            className={styles.badge}
            style={{ backgroundColor: badgeBgColor }}
          >
            {identity.nickname.slice(0, 1)}
          </div>
        )}
        <span>{identity.nickname}</span>
      </div>

      <h3>Nickname</h3>
      <form
        className={styles.nicknameForm}
        onSubmit={(e) => {
          e.preventDefault();
          saveNickname();
        }}
      >
        <input
          value={displayedNickname}
          onChange={(e) => setNicknameDraft(e.target.value)}
        />
        <Button type="submit" disabled={!canSaveNickname}>
          Save
        </Button>
      </form>

      <h3>Avatar</h3>
      {identity.profilePictureUrl && (
        <Button onClick={() => setProfilePictureUrl(null)}>
          Remove avatar
        </Button>
      )}
      <h4 className={styles.collectionName}>Pokémon Mystery Dungeon</h4>
      <PmdPortraitPicker
        selectedUrl={identity.profilePictureUrl}
        onSelect={(url) => setProfilePictureUrl(url)}
      />
      {identity.profilePictureUrl && (
        <>
          <h4 className={styles.collectionName}>Frame Color</h4>
          <div className={styles.frameChoices}>
            {(["male", "female"] as const).map((frame) => (
              <div
                key={frame}
                className={`${styles.frameChoice}${
                  identity.profilePictureFrame === frame
                    ? ` ${styles.frameChoiceSelected}`
                    : ""
                }`}
                onClick={() => setProfilePictureFrame(frame)}
              >
                <img
                  className={`${styles.framedAvatar}${
                    frame === "female" ? ` ${styles.framedAvatarFemale}` : ""
                  }`}
                  src={identity.profilePictureUrl ?? undefined}
                  alt=""
                />
                <span>{frame === "male" ? "Blue" : "Pink"}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default ProfilePage;
