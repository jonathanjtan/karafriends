import { toDataURL } from "qrcode";
import React, { useEffect, useState } from "react";

import * as styles from "./JoinPage.module.scss";

// Hand the app to someone else's phone: show a QR of *this* phone's own
// address so they can scan it off the screen.
//
// Deliberately `window.location.origin` rather than the synced `hostname`
// setting: this page is served from an address the holder's phone is
// demonstrably able to reach, so it cannot be misconfigured the way reading
// an address off the TV can. (The TV's own QR does use the synced hostname,
// since it has no other way to know which of its interfaces to advertise.)
export default function JoinPage() {
  const joinUrl = window.location.origin;
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    toDataURL(joinUrl, { errorCorrectionLevel: "M", margin: 1, width: 512 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      // A failed render is not worth taking the page down for; the typed
      // address below still works.
      .catch((error) => console.error("Failed to render join QR:", error));
    return () => {
      cancelled = true;
    };
  }, [joinUrl]);

  return (
    <div className={styles.page}>
      <div className={styles.title}>Join karafriends</div>
      <div className={styles.blurb}>
        Have them point their camera at this code. It opens the same remocon on
        their phone.
      </div>
      <div className={styles.codePlate}>
        {dataUrl && <img className={styles.code} src={dataUrl} alt={joinUrl} />}
      </div>
      <div className={styles.url}>{joinUrl}</div>
      <button
        className={styles.copyButton}
        onClick={() => {
          navigator.clipboard
            .writeText(joinUrl)
            .then(() => setCopied(true))
            // Clipboard access can be denied (or absent on an insecure
            // origin, which this is); the address is on screen either way.
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy address"}
      </button>
    </div>
  );
}
