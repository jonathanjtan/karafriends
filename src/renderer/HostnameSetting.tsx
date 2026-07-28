import M from "materialize-css";
import React, { useEffect, useMemo, useRef } from "react";

import { HOSTNAME } from "../common/constants";
import useHostname from "../common/hooks/useHostname";
import "./global";

// The addresses this machine can be reached on. Renderer-side because the
// list comes from the preload's `ipAddresses()` — the *selected* value is a
// synced setting (see useHostname), but which interfaces exist is a property
// of whichever machine is running the big screen.
function hostnameOptions(): Map<string, string> {
  const { remoconPort } = window.karafriends.karafriendsConfig();
  return new Map([
    ["offkai.karafriends.party", "offkai.karafriends.party"],
    [HOSTNAME, `${HOSTNAME}:${remoconPort}`],
    ...window.karafriends
      .ipAddresses()
      .map((address): [string, string] => [
        address,
        `${address}:${remoconPort}`,
      ]),
  ]);
}

export default function HostnameSetting() {
  const { hostname, setHostname } = useHostname();
  const selectRef = useRef<HTMLSelectElement>(null);
  const options = useMemo(hostnameOptions, []);

  // Whatever the server says is current always has to be selectable, even if
  // it isn't one of this machine's addresses right now (a value saved on a
  // network we're no longer on, say) — otherwise the <select> would show a
  // different address than the QR codes actually encode.
  const entries = Array.from(options);
  if (hostname !== "" && !entries.some(([, value]) => value === hostname)) {
    entries.unshift([hostname, hostname]);
  }

  // The synced hostname arrives after the first render, and materialize's
  // FormSelect copies the native <select> into its own DOM at init time — so
  // it has to be re-initialised whenever the value changes, or the dropdown
  // keeps displaying whatever was selected before the fetch landed.
  useEffect(() => {
    if (!selectRef.current) return;
    const instance = M.FormSelect.init(selectRef.current);
    return () => instance.destroy();
  }, [hostname, options]);

  return (
    <div className="input-field">
      <select
        ref={selectRef}
        value={hostname}
        onChange={(e) => setHostname(e.target.value)}
      >
        {entries.map(([key, value]) => (
          <option key={value} value={value}>
            {key}
          </option>
        ))}
      </select>
      <label>Hostname</label>
    </div>
  );
}
