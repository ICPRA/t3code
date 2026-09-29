import { createWorkbenchProgramEnvironmentAtoms } from "@t3tools/client-runtime/state/workbench-program";
import { connectionAtomRuntime } from "../connection/runtime";

export const workbenchProgramEnvironment = createWorkbenchProgramEnvironmentAtoms(connectionAtomRuntime);
