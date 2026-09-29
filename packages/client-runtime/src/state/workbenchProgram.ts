import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createWorkbenchProgramEnvironmentAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    workbenchProgramStartCommand: createEnvironmentRpcCommand(runtime, { label: "workbench:program:start", tag: WS_METHODS.workbenchProgramStart }),
    workbenchProgramCancelCommand: createEnvironmentRpcCommand(runtime, { label: "workbench:program:cancel", tag: WS_METHODS.workbenchProgramCancel }),
    workbenchProgramReadCommand: createEnvironmentRpcCommand(runtime, { label: "workbench:program:read", tag: WS_METHODS.workbenchProgramRead }),
    workbenchProgramCompleteCommand: createEnvironmentRpcCommand(runtime, { label: "workbench:program:complete", tag: WS_METHODS.workbenchProgramComplete }),
  };
}
