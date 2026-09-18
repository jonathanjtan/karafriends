import { useEffect, useState } from "react";
import { graphql } from "react-relay";

import environment from "../../common/graphqlEnvironment";
import fetchQueryWithRetry from "../../common/hooks/fetchQueryWithRetry";
import { useConfigQuery } from "./__generated__/useConfigQuery.graphql";

const configQuery = graphql`
  query useConfigQuery {
    config {
      adminNicks
      adminDeviceIds
      supervisedMode
    }
  }
`;

type ConfigType = useConfigQuery["response"]["config"];

export default function useConfig() {
  const [config, setConfig] = useState<ConfigType | undefined>(undefined);

  useEffect(() => {
    const initialQuery = fetchQueryWithRetry<useConfigQuery>(
      environment,
      configQuery,
      {},
      (response) => setConfig(response.config),
    );

    return () => {
      initialQuery.unsubscribe();
    };
  }, []);

  return config;
}
