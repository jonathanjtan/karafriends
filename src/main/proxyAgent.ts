import tunnel from "tunnel";

import karafriendsConfig from "../common/config";

// Both services geo-restrict, in different ways: win10.clubdam.com and
// sound-cafe.jp answer 403 to a non-JP address, and DAM's CDN additionally
// rejects addresses with an anonymizer reputation (which is what took out
// every NordVPN Japan exit, since the whole JP pool is proxy-flagged).
//
// The RESTDataSource instances in graphql.ts already route through
// `fetch: fetcher`, which carries an equivalent agent. This exists for the
// static `login` paths in damApi/joysoundApi, which call out directly and
// would otherwise escape the proxy and hit the geo-block. The failure is
// invisible from the app's side because every *other* call still succeeds.
const proxyAgent = karafriendsConfig.proxyEnable
  ? tunnel.httpsOverHttp({
      proxy: {
        host: karafriendsConfig.proxyHost,
        port: karafriendsConfig.proxyPort,
        proxyAuth: `${karafriendsConfig.proxyUser}:${karafriendsConfig.proxyPass}`,
      },
    })
  : undefined;

export default proxyAgent;
