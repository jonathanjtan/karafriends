import React, { Suspense } from "react";
// tslint:disable-next-line:no-submodule-imports
import { BiLoaderAlt } from "react-icons/bi";

import * as styles from "./Loader.module.scss";
import QueryErrorBoundary from "./QueryErrorBoundary";

const Loader = () => (
  <div className={styles.loader}>
    <BiLoaderAlt />
  </div>
);

// Primitive prop values double as the error boundary's reset keys: when a
// wrapped component's search term (or similar scalar prop) changes, a stuck
// error clears and the query is retried. Non-primitive props (functions,
// objects) are ignored, since they'd change identity every render.
const primitivePropValues = (props: object): unknown[] =>
  Object.values(props).filter(
    (value) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
  );

export const withLoader = <P extends object>(
  WrappedComponent: React.ComponentType<P>,
) =>
  class WithLoader extends React.Component<P> {
    render() {
      return (
        <QueryErrorBoundary resetKeys={primitivePropValues(this.props)}>
          <Suspense fallback={<Loader />}>
            <WrappedComponent {...(this.props as P)} />
          </Suspense>
        </QueryErrorBoundary>
      );
    }
  };

export default Loader;
