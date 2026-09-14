/*
 * Exports:
 * - default ThreadCheckpointCommitItem: render a standalone proposal controller or its relocatable transcript anchor.
 */
"use client";

import ThreadCheckpointCommitController, {
  type ThreadCheckpointCommitControllerProps,
} from "./ThreadCheckpointCommitController";
import { ThreadCheckpointCommitSourceAnchor } from "./ThreadCheckpointCommitPortalLayer";

export default function ThreadCheckpointCommitItem({
  relocatable = false,
  ...props
}: ThreadCheckpointCommitControllerProps & {
  relocatable?: boolean;
}) {
  if (relocatable && props.proposalId) {
    return <ThreadCheckpointCommitSourceAnchor proposalId={props.proposalId} />;
  }
  return <ThreadCheckpointCommitController {...props} />;
}
