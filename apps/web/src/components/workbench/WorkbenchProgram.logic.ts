import { EnvironmentId, ProjectId, WorkbenchProgramRun, WorkbenchProgramLoopPolicy } from "@t3tools/contracts";
import { WORK_PURPOSES } from "@project-workbench/ui/dispatch";
import * as Schema from "effect/Schema";
import { QABasis } from "./WorkbenchDispatch.logic";

export const PROGRAM_STORAGE_KEY = "workbench.pending-program.v1";
const qaEquivalent = Schema.toEquivalence(QABasis);
const loopEquivalent = Schema.toEquivalence(WorkbenchProgramLoopPolicy);
export const ProgramCommand = Schema.Struct({
  executable: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: Schema.NonEmptyString,
  environmentId: EnvironmentId,
  nativeProjectId: ProjectId,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  workPurpose: Schema.Literals(WORK_PURPOSES),
  qaBasis: Schema.optionalKey(QABasis),
  completeOnSuccess: Schema.optionalKey(Schema.Boolean),
  loop: Schema.optionalKey(WorkbenchProgramLoopPolicy),
});
export type ProgramCommand = typeof ProgramCommand.Type;
const PendingProgram = Schema.Struct({
  project: Schema.NonEmptyString, taskSlug: Schema.NonEmptyString, key: Schema.NonEmptyString,
  command: ProgramCommand, runId: Schema.optionalKey(Schema.NonEmptyString), packageId: Schema.optionalKey(Schema.NonEmptyString),
  rejected: Schema.optionalKey(Schema.Literal(true)),
});
export type PendingProgram = typeof PendingProgram.Type;
const decodePendingProgram = Schema.decodeUnknownSync(PendingProgram);
const decodeArgs = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const decodeRun = Schema.decodeUnknownSync(WorkbenchProgramRun);
export const decodeProgramCommand = Schema.decodeUnknownSync(ProgramCommand);

export function readPendingProgram(storage: Pick<Storage, "getItem">): PendingProgram | null {
  const raw = storage.getItem(PROGRAM_STORAGE_KEY);
  return raw === null ? null : decodePendingProgram(JSON.parse(raw));
}

export function programCanComplete(purpose: string): boolean {
  return WORK_PURPOSES.includes(purpose as typeof WORK_PURPOSES[number]) && !["requirements", "design", "implementation"].includes(purpose);
}

export function parseProgramArgs(raw: string): readonly string[] {
  return decodeArgs(JSON.parse(raw));
}

export function readProgramReceipt(value: unknown, expected: { runId?: string; taskSlug: string; environmentId: string; nativeProjectId: string; authorizedByUserId?: string | undefined; hostConsumerUserId?: string | undefined }, command?: ProgramCommand) {
  const run = decodeRun(value);
  const target = decodeProgramCommand(run.context.body.program_target);
  if ((expected.runId && run.context.runId !== expected.runId) || run.context.taskSlug !== expected.taskSlug ||
    target.environmentId !== expected.environmentId || target.nativeProjectId !== expected.nativeProjectId) throw new Error("Program run scope mismatch");
  const qa = [target.qaBasis, command?.qaBasis].map((basis) => basis && ({ ...basis,
    designSources: basis.designSources.map((source) => { if (source.kind !== "git" || source.entry) return source; const { entry: _entry, ...fixed } = source; return fixed; }),
    testPlanSources: basis.testPlanSources.map((source) => { if (source.kind !== "git" || source.entry) return source; const { entry: _entry, ...fixed } = source; return fixed; }),
  }));
  const qaMatches = qa[0] === undefined || qa[1] === undefined ? qa[0] === qa[1] : qaEquivalent(qa[0], qa[1]);
  const loopMatches = target.loop === undefined || command?.loop === undefined ? target.loop === command?.loop : loopEquivalent(target.loop, command.loop);
  if (command && (target.executable !== command.executable || target.cwd !== command.cwd || target.timeoutMs !== command.timeoutMs ||
    target.workPurpose !== command.workPurpose || !!target.completeOnSuccess !== !!command.completeOnSuccess ||
    JSON.stringify(target.args) !== JSON.stringify(command.args) || !qaMatches || !loopMatches)) throw new Error("Recorded program command differs from the original request");
  const authorization = run.context.body.program_target as Record<string, unknown>;
  if (["authorizedByUserId", "hostConsumerUserId"].some((field) => typeof authorization[field] !== "string" || !authorization[field])) throw new Error("Program authorization is missing");
  if ((expected.authorizedByUserId !== undefined && authorization.authorizedByUserId !== expected.authorizedByUserId) ||
    (expected.hostConsumerUserId !== undefined && authorization.hostConsumerUserId !== expected.hostConsumerUserId)) throw new Error("Program authorization differs from the original authorizer or host consumer");
  return { run, target };
}
