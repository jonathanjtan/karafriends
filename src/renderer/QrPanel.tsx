import React from "react";

import useHostname from "../common/hooks/useHostname";
import QRCode from "./QRCode";
import "./QrPanel.css";

// Root of the popped-out join-QR window (?panel=qr): the QR and the address
// it encodes, and nothing else. Meant to be dragged onto a second display —
// a laptop beside the TV — and left there, so people can scan in while the
// big screen stays on the song.
//
// It needs no bus to the big screen: hostname is a synced setting, so this
// window reads it from the main process like any other client.
export default function QrPanel() {
  const { hostname } = useHostname();

  return (
    <div className="qrPanel">
      <div className="qrPanelTitle">Scan to join</div>
      <div className="qrPanelCode">
        <QRCode hostname={hostname} />
      </div>
      {/* Someone whose camera won't cooperate can always type it. */}
      <div className="qrPanelUrl">
        {hostname === "" ? "…" : `http://${hostname}`}
      </div>
    </div>
  );
}
