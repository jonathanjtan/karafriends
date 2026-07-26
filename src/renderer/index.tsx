import * as Sentry from "@sentry/browser";
import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

import React from "react";
import { createRoot } from "react-dom/client"; // tslint:disable-line:no-submodule-imports
import { RelayEnvironmentProvider } from "react-relay";

import environment from "../common/graphqlEnvironment";
import { KuroshiroSingleton } from "../common/joysoundParser";
import App from "./App";
import "./index.css";
import SettingsPanel from "./SettingsPanel";
import { isSettingsPanelWindow } from "./settingsPanelBus";
import KarafriendsAudio from "./webAudio";

Sentry.init({
  dsn: "https://80cbda8ca4af42d9b95c60eb1f00566f@sentry.io/6728669",
  debug: true,
});

// This bundle is loaded by two windows: the big screen and the popped-out
// settings window. Only the big screen gets an audio graph and a kuromoji
// dictionary — the panel window has no player, and a second AudioContext /
// dictionary load would just cost memory.
function root() {
  if (isSettingsPanelWindow()) return <SettingsPanel />;

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
