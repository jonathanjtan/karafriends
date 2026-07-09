// tsc with the classic `moduleResolution: "node"` setting doesn't understand
// graphql-ws's package.json "exports" subpath map, so `graphql-ws/use/ws`
// fails to resolve even though its declarations exist at
// `graphql-ws/dist/use/ws`. Parcel resolves the subpath fine at build time;
// this shim just points tsc at the real declarations for the type checker.
declare module "graphql-ws/use/ws" {
  export * from "graphql-ws/dist/use/ws";
}
