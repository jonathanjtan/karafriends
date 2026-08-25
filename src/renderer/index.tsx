import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

import React from "react";
import { createRoot } from "react-dom/client"; // tslint:disable-line:no-submodule-imports
import { RelayEnvironmentProvider } from "react-relay";

import environment from "../common/graphqlEnvironment";
import { KuroshiroSingleton } from "../common/joysoundParser";
import App from "./App";
import "./index.css";
import QrPanel from "./QrPanel";
import SettingsPanel from "./SettingsPanel";
import { panelKind } from "./settingsPanelBus";
import KarafriendsAudio from "./webAudio";

// This bundle is loaded by three windows: the big screen and the two
// popped-out panels (settings, join QR). Only the big screen gets an audio
// graph and a kuromoji dictionary. The panels have no player, and a second
// AudioContext / dictionary load would just cost memory.
function root() {
  switch (panelKind()) {
    case "settings":
      return <SettingsPanel />;
    case "qr":
      return <QrPanel />;
  }

  const kuroshiro = new Kuroshiro();
  const kuromojiAnalyzer = new KuromojiAnalyzer({ dictPath: "./dict" });
  const kuromojiPromise = kuroshiro.init(kuromojiAnalyzer);

  const kuroshiroSingleton: KuroshiroSingleton = {
    kuroshiro,
    analyzer: kuromojiAnalyzer,
    analyzerInitPromise: kuromojiPromise,
  };

  return <App kuroshiro={kuroshiroSingleton} audio={new KarafriendsAudio()} />;
}

const container = document.getElementById("root");
createRoot(container!).render(
  <React.StrictMode>
    <RelayEnvironmentProvider environment={environment}>
      {root()}
    </RelayEnvironmentProvider>
  </React.StrictMode>,
);
