import { graphql, useMutation } from "react-relay";

import { useClearQueueMutation } from "./__generated__/useClearQueueMutation.graphql";

const clearQueueMutation = graphql`
  mutation useClearQueueMutation {
    clearQueue
  }
`;

// Shared by the docked sidebar (App.tsx) and the popped-out settings window
// (SettingsPanel.tsx): confirms with the room before clearing the queue
// (which also skips the current song), then commits the mutation.
export default function useClearQueue() {
  const [commit, isClearingQueue] =
    useMutation<useClearQueueMutation>(clearQueueMutation);

  const clearQueue = () => {
    if (window.confirm("Clear the queue and skip the current song?")) {
      commit({ variables: {} });
    }
  };

  return { clearQueue, isClearingQueue };
}
