import { invariant } from "ts-invariant";

import { createClient } from "graphql-ws";
import {
  Environment,
  Network,
  Observable,
  RecordSource,
  RequestParameters,
  Store,
  Variables,
} from "relay-runtime";

function fetchQuery(request: RequestParameters, variables: Variables) {
  return fetch(
    window.karafriends !== undefined
      ? `http://localhost:${
          window.karafriends.karafriendsConfig().remoconPort
        }/graphql`
      : "/graphql",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: request.text,
        variables,
      }),
    },
  ).then((response) => {
    return response.json();
  });
}

function getSubscriptionUrl(): string {
  if (window.karafriends !== undefined) {
    return `ws://localhost:${
      window.karafriends.karafriendsConfig().remoconPort
    }/graphql`;
  }

  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";

  return `${wsProtocol}://${window.location.hostname}:${window.location.port}/graphql`;
}

// Fired on window whenever the subscription websocket (re)connects, so
// synced-setting hooks can refetch values that changed while disconnected.
// Without this — and without infinite retries — a client left open across a
// server restart exhausted graphql-ws's default 5 retry attempts (~30s of
// backoff, less than a dev rebuild), permanently lost its subscriptions, and
// displayed stale state until a manual reload.
export const WS_RECONNECTED_EVENT = "karafriends:ws-reconnected";

const subscriptionClient = createClient({
  url: getSubscriptionUrl(),
  retryAttempts: Infinity,
  shouldRetry: () => true,
  // graphql-ws's default retry wait is uncapped exponential backoff, so a
  // server that takes a while to come up (kuromoji dictionary load at
  // launch, a dev rebuild) could strand clients in a minutes-long gap
  // between attempts — subscriptions (and the WS_RECONNECTED refetch that
  // rescues stale settings) stayed dead the whole time. Cap the wait so
  // clients reconnect within seconds of the server being ready.
  retryWait: async (retries) => {
    const delayMs = Math.min(1000 * 2 ** retries, 10000);
    await new Promise((resolve) =>
      setTimeout(resolve, delayMs + Math.random() * 500),
    );
  },
  on: {
    connected: () => window.dispatchEvent(new Event(WS_RECONNECTED_EVENT)),
  },
});

const subscribe = (operation: RequestParameters, variables: Variables) => {
  return Observable.create((sink) => {
    invariant(operation.text);

    return subscriptionClient.subscribe(
      {
        operationName: operation.name,
        query: operation.text,
        variables,
      },
      sink,
    );
  });
};

const environment = new Environment({
  // @ts-ignore: the relay type stubs are pitifully broken
  network: Network.create(fetchQuery, subscribe),
  store: new Store(new RecordSource()),
});

export default environment;
