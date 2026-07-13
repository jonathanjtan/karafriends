import React, { useState } from "react";

import { cyrb53 } from "../../common/hash";
import Button from "../components/Button";
import PmdPortraitPicker from "../components/PmdPortraitPicker";
import useUserIdentity, {
  setNickname,
  setProfilePictureUrl,
} from "../hooks/useUserIdentity";
import * as styles from "./ProfilePage.module.scss";

const ProfilePage = () => {
  const identity = useUserIdentity();
  // null = untouched; the input shows the stored nickname until edited.
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);

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
        <div className={styles.badge} style={{ backgroundColor: badgeBgColor }}>
          {identity.profilePictureUrl ? (
            <img src={identity.profilePictureUrl} alt="" />
          ) : (
            identity.nickname.slice(0, 1)
          )}
        </div>
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
      <blockquote>
        Songs already in the queue keep the nickname they were queued with.
      </blockquote>

      <h3>Profile Picture</h3>
      {identity.profilePictureUrl && (
        <Button onClick={() => setProfilePictureUrl(null)}>
          Remove picture
        </Button>
      )}
      <h4 className={styles.collectionName}>Pokémon Mystery Dungeon</h4>
      <PmdPortraitPicker
        selectedUrl={identity.profilePictureUrl}
        onSelect={(url) => setProfilePictureUrl(url)}
      />
    </div>
  );
};

export default ProfilePage;
