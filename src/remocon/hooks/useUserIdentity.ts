import { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";

// Fired on window whenever the stored identity changes so that every mounted
// useUserIdentity instance (NavBar avatar, queue buttons, ...) picks up edits
// made on the profile page without a reload.
const IDENTITY_CHANGED_EVENT = "userIdentityChanged";

const NICKNAME_STORAGE_KEY = "nickname";
const PROFILE_PICTURE_STORAGE_KEY = "profilePictureUrl";

function notifyIdentityChanged() {
  window.dispatchEvent(new Event(IDENTITY_CHANGED_EVENT));
}

export function setNickname(nickname: string) {
  localStorage.setItem(NICKNAME_STORAGE_KEY, nickname);
  notifyIdentityChanged();
}

export function setProfilePictureUrl(url: string | null) {
  if (url) {
    localStorage.setItem(PROFILE_PICTURE_STORAGE_KEY, url);
  } else {
    localStorage.removeItem(PROFILE_PICTURE_STORAGE_KEY);
  }
  notifyIdentityChanged();
}

const useUserIdentity = (shouldPrompt?: boolean) => {
  const [identity, setIdentity] = useState<{
    deviceId: string;
    nickname: string;
    profilePictureUrl: string | null;
  }>({ deviceId: "Unknown", nickname: "Unknown", profilePictureUrl: null });

  useEffect(() => {
    if (!localStorage.getItem("deviceId")) {
      localStorage.setItem("deviceId", uuidv4());
    }

    if (shouldPrompt) {
      while ((localStorage.getItem(NICKNAME_STORAGE_KEY) || "").length === 0) {
        localStorage.setItem(
          NICKNAME_STORAGE_KEY,
          prompt("Please set your nickname:") || "",
        );
      }
    }

    const readIdentity = () =>
      setIdentity({
        deviceId: localStorage.getItem("deviceId") || "Unknown",
        nickname: localStorage.getItem(NICKNAME_STORAGE_KEY) || "Unknown",
        profilePictureUrl: localStorage.getItem(PROFILE_PICTURE_STORAGE_KEY),
      });

    readIdentity();
    window.addEventListener(IDENTITY_CHANGED_EVENT, readIdentity);
    return () =>
      window.removeEventListener(IDENTITY_CHANGED_EVENT, readIdentity);
  }, []);

  return identity;
};

export default useUserIdentity;
