import * as Sentry from "@sentry/browser";
import React from "react";
import { createRoot } from "react-dom/client"; // tslint:disable-line:no-submodule-imports
import { RelayEnvironmentProvider } from "react-relay";

import environment from "../common/graphqlEnvironment";
import App from "./App";
import "./index.module.scss";
// Defines the var(--…) tokens every other stylesheet consumes. Import order
// doesn't matter (tslint sorts these alphabetically anyway) — custom properties
// resolve where they're used, not where they're parsed, and these are all
// declared on :root, so nothing here competes on specificity.
import "./theme.scss";

Sentry.init({
  dsn: "https://80cbda8ca4af42d9b95c60eb1f00566f@sentry.io/6728669",
  debug: true,
});

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <RelayEnvironmentProvider environment={environment}>
      <App />
    </RelayEnvironmentProvider>
  </React.StrictMode>,
);
