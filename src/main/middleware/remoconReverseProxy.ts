import path from "path";

import isDev from "electron-is-dev";
import express, { Request, Response } from "express";

function remoconReverseProxy(devPort: number) {
  if (isDev) {
    // In dev, non-GraphQL requests are proxied to the remocon dev server.
    return (req: Request, res: Response, next: () => void) => {
      if (req.path === "/graphql") {
        next();
        return;
      }
      // Requests that aren't already under a target directory get routed to
      // the remocon target. The trailing slashes matter: the remocon bundle
      // is named `remocon.<hash>.js`, so a bare `startsWith("/remocon")` also
      // matches that *filename* and wrongly skips the prefix, fetching
      // `:devPort/remocon.<hash>.js` (parcel's SPA fallback HTML) instead of
      // `:devPort/remocon/remocon.<hash>.js` (the actual bundle), which
      // whitescreens the remocon.
      fetch(
        `http://127.0.0.1:${devPort}/${
          !req.path.startsWith("/remocon/") &&
          !req.path.startsWith("/renderer/")
            ? "remocon"
            : ""
        }${req.originalUrl}`,
        {
          method: req.method,
          headers: Object.keys(req.headers).map((header): [string, string] => [
            header,
            req.headers[header] as string,
          ]),
        },
      )
        .then((proxiedRes) => {
          res.status(proxiedRes.status);
          proxiedRes.headers.forEach((value, name) => res.set(name, value));
          return proxiedRes.arrayBuffer();
        })
        .then((buf) => {
          res.send(Buffer.from(buf));
        })
        .catch((err) => {
          console.error("remocon reverse proxy request failed:", err);
          if (!res.headersSent) res.sendStatus(502);
        });
    };
  } else {
    // In production, serve the built remocon bundle directly.
    return express.static(
      path.join(__dirname, "..", "..", "..", "build", "prod", "remocon"),
    );
  }
}

export default remoconReverseProxy;
