import type { Declaration } from "./declare";
import {
  creates,
  destroys,
  noUndo,
  nothingToUndo,
  reads,
  required,
  rerun,
  resource,
  undoWith,
  writes,
} from "./declare";

const issuer = resource("secrets.issuer");
export const credential = resource("secrets.credential");
const consumer = resource("secrets.consumer");

export const secrets: ReadonlyArray<Declaration> = [
  {
    id: "secrets.createCredential",
    version: 1,
    title: "Create a new credential",
    kind: "Action",
    inputs: { issuer: required(issuer) },
    outputs: { credential },
    effects: [reads("issuer"), creates("credential", "Durable")],
    undo: undoWith("secrets.revokeCredential", 1),
    rerun,
  },
  {
    id: "secrets.deployCredential",
    version: 1,
    title: "Deploy a credential to a consumer",
    kind: "Action",
    inputs: {
      consumer: required(consumer),
      credential: required(credential),
      previous: required(credential),
    },
    outputs: {},
    effects: [writes("consumer"), reads("credential"), reads("previous")],
    undo: undoWith("secrets.restoreCredential", 1),
    rerun,
  },
  {
    id: "secrets.restoreCredential",
    version: 1,
    title: "Put a consumer back on its previous credential",
    kind: "Action",
    inputs: { consumer: required(consumer), previous: required(credential) },
    outputs: {},
    effects: [writes("consumer"), reads("previous")],
    undo: noUndo(
      "Restoring is the way back. Undoing it would redeploy the credential being withdrawn.",
    ),
    rerun,
  },
  {
    id: "secrets.checkConsumer",
    version: 1,
    title: "Check that a consumer works with a credential",
    kind: "Check",
    inputs: { consumer: required(consumer), credential: required(credential) },
    outputs: {},
    effects: [reads("consumer"), reads("credential")],
    undo: nothingToUndo,
    rerun,
  },
  {
    id: "secrets.revokeCredential",
    version: 1,
    title: "Revoke a credential",
    kind: "Action",
    inputs: { credential: required(credential) },
    outputs: {},
    effects: [destroys("credential")],
    undo: noUndo("A revoked credential cannot be made valid again."),
    rerun,
  },
];
