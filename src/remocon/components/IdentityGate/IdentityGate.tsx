import React, { useEffect, useState } from "react";
import { graphql } from "react-relay";

import environment from "../../../common/graphqlEnvironment";
import fetchQueryWithRetry from "../../../common/hooks/fetchQueryWithRetry";
import {
  adoptPerson,
  ensureDeviceId,
  forgetPerson,
  getStoredPersonId,
  IDENTITY_CHANGED_EVENT,
} from "../../hooks/useUserIdentity";
import AccountPicker from "../AccountPicker";
import * as styles from "./IdentityGate.module.scss";
import { IdentityGatePersonByDeviceQuery } from "./__generated__/IdentityGatePersonByDeviceQuery.graphql";

const personByDeviceQuery = graphql`
  query IdentityGatePersonByDeviceQuery($deviceId: String!) {
    personByDevice(deviceId: $deviceId) {
      personId
      displayName
      profilePictureUrl
      profilePictureFrame
    }
  }
`;

// Blocks the whole remocon until this device is attached to a singer. An
// unclaimed device can't queue, because it can't reach anything that queues.
//
// This also replaces the old window.prompt() nickname flow, which threw in
// headless browsers and took the whole app down with it (see CLAUDE.md).
const IdentityGate = ({ children }: { children: React.ReactNode }) => {
  const [deviceId] = useState(ensureDeviceId);
  // null while we're still asking the server who this device is; rendering
  // the picker during that window would flash it at people who do have an
  // account.
  const [claimed, setClaimed] = useState<boolean | null>(null);

  useEffect(() => {
    const initialQuery = fetchQueryWithRetry<IdentityGatePersonByDeviceQuery>(
      environment,
      personByDeviceQuery,
      { deviceId },
      (response) => {
        if (response.personByDevice) {
          // The server is the authority: adopting here is what picks up a
          // rename or avatar change made from this person's other device.
          adoptPerson(response.personByDevice);
          setClaimed(true);
        } else {
          // Unknown device. Any locally cached nickname is from an identity
          // nobody is attached to anymore, so drop it rather than show a
          // stale name in the nav bar behind the gate.
          forgetPerson();
          setClaimed(false);
        }
      },
    );

    // "Not me" from the switch-account drawer clears the stored person; that
    // has to put the gate back up, and this is how it hears about it.
    const handleIdentityChanged = () => {
      if (!getStoredPersonId()) setClaimed(false);
    };
    window.addEventListener(IDENTITY_CHANGED_EVENT, handleIdentityChanged);

    return () => {
      initialQuery.unsubscribe();
      window.removeEventListener(IDENTITY_CHANGED_EVENT, handleIdentityChanged);
    };
  }, [deviceId]);

  if (claimed === null) return null;
  if (claimed) return <>{children}</>;

  return (
    <div className={styles.gate}>
      <AccountPicker
        deviceId={deviceId}
        heading="New phone, who this?"
        onClaimed={() => setClaimed(true)}
      />
    </div>
  );
};

export default IdentityGate;
