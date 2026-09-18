import { useEffect } from "react";

import formatDuration from "format-duration";
import useQueue from "../../common/hooks/useQueue";

async function registerServiceWorker() {
  return navigator.serviceWorker.register(
    new URL("../notificationServiceWorker.ts", import.meta.url),
    { scope: "/" },
  );
}

function notificationsGranted(): boolean {
  return "Notification" in window && Notification.permission === "granted";
}

// Both showNotification paths reject (or throw) without a granted
// permission, so callers must check first; the rejection is otherwise an
// uncaught promise error on every queue update.
async function showNotification(
  ...args: ConstructorParameters<typeof Notification>
) {
  if (!notificationsGranted()) return;
  if ("serviceWorker" in navigator) {
    const registration = await registerServiceWorker();
    await registration.showNotification(...args);
  } else {
    new Notification(...args); // tslint:disable-line:no-unused-expression
  }
}

export default function useQueueNotifications(myDeviceId: string) {
  const queue = useQueue();

  // Register once so the first notification does not wait on it.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    registerServiceWorker().catch((e) =>
      console.warn("Service worker registration failed", e),
    );
  }, []);

  useEffect(() => {
    for (const [item, eta] of queue) {
      if (
        item.userIdentity &&
        item.userIdentity.deviceId === myDeviceId &&
        eta <= 10 * 60
      ) {
        showNotification("karafriends", {
          body: `Your song ${
            item.name
          } is coming up soon! Estimated wait: T-${formatDuration(eta * 1000)}`,
        }).catch((e) => console.warn("Queue notification failed", e));
      }
    }
  }, [queue]);
}
