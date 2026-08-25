import { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";

// Fired on window whenever the stored identity changes so that every mounted
// useUserIdentity instance (NavBar avatar, queue buttons, ...) picks up edits
// made on the profile page without a reload.
export const IDENTITY_CHANGED_EVENT = "userIdentityChanged";

const NICKNAME_STORAGE_KEY = "nickname";
const PROFILE_PICTURE_STORAGE_KEY = "profilePictureUrl";
const PROFILE_PICTURE_FRAME_STORAGE_KEY = "profilePictureFrame";
const PERSON_ID_STORAGE_KEY = "personId";
const DEVICE_ID_STORAGE_KEY = "deviceId";

export type ProfilePictureFrame = "male" | "female";

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

export function setProfilePictureFrame(frame: ProfilePictureFrame) {
  localStorage.setItem(PROFILE_PICTURE_FRAME_STORAGE_KEY, frame);
  notifyIdentityChanged();
}

// The deviceId is generated here rather than in the hook's effect because the
// identity gate needs it before anything renders. It's the key it asks the
// server about.
export function ensureDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const deviceId = uuidv4();
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
  return deviceId;
}

export function getStoredPersonId(): string | null {
  return localStorage.getItem(PERSON_ID_STORAGE_KEY);
}

// Mirror a claimed person into localStorage. The server is the authority on
// who this device is; this is the local cache every queue mutation reads.
export function adoptPerson(person: {
  personId: string;
  displayName: string;
  profilePictureUrl?: string | null;
  profilePictureFrame?: string | null;
}) {
  localStorage.setItem(PERSON_ID_STORAGE_KEY, person.personId);
  localStorage.setItem(NICKNAME_STORAGE_KEY, person.displayName);
  if (person.profilePictureUrl) {
    localStorage.setItem(PROFILE_PICTURE_STORAGE_KEY, person.profilePictureUrl);
  } else {
    localStorage.removeItem(PROFILE_PICTURE_STORAGE_KEY);
  }
  localStorage.setItem(
    PROFILE_PICTURE_FRAME_STORAGE_KEY,
    person.profilePictureFrame === "female" ? "female" : "male",
  );
  notifyIdentityChanged();
}

// "Not me": forget who this device was acting as. The deviceId is kept. It
// still identifies the browser, it just isn't attached to anyone until the
// gate resolves again.
export function forgetPerson() {
  localStorage.removeItem(PERSON_ID_STORAGE_KEY);
  localStorage.removeItem(NICKNAME_STORAGE_KEY);
  localStorage.removeItem(PROFILE_PICTURE_STORAGE_KEY);
  localStorage.removeItem(PROFILE_PICTURE_FRAME_STORAGE_KEY);
  notifyIdentityChanged();
}

const useUserIdentity = () => {
  const [identity, setIdentity] = useState<{
    deviceId: string;
    nickname: string;
    profilePictureUrl: string | null;
    profilePictureFrame: ProfilePictureFrame;
    personId: string | null;
  }>({
    deviceId: "Unknown",
    nickname: "Unknown",
    profilePictureUrl: null,
    profilePictureFrame: "male",
    personId: null,
  });

  useEffect(() => {
    ensureDeviceId();

    const readIdentity = () =>
      setIdentity({
        deviceId: localStorage.getItem(DEVICE_ID_STORAGE_KEY) || "Unknown",
        nickname: localStorage.getItem(NICKNAME_STORAGE_KEY) || "Unknown",
        profilePictureUrl: localStorage.getItem(PROFILE_PICTURE_STORAGE_KEY),
        profilePictureFrame:
          localStorage.getItem(PROFILE_PICTURE_FRAME_STORAGE_KEY) === "female"
            ? "female"
            : "male",
        personId: localStorage.getItem(PERSON_ID_STORAGE_KEY),
      });

    readIdentity();
    window.addEventListener(IDENTITY_CHANGED_EVENT, readIdentity);
    return () =>
      window.removeEventListener(IDENTITY_CHANGED_EVENT, readIdentity);
  }, []);

  return identity;
};

export default useUserIdentity;
