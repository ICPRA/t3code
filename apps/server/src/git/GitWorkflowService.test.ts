import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { GitCommandError, VcsCompareCommitsInput, VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("compares fixed commit trees with bounded paging and explicit failures", () => {
    const baseCommit = "a".repeat(40);
    const headCommit = "b".repeat(40);
    const authoredAt = "2026-09-23T10:00:00+08:00";
    const patch = "diff --git a/file b/file\n--- a/file\n+++ b/file\n";
    const input = { cwd: "/fixed-worktree", baseCommit, headCommit, offset: 7, limit: 1 };
    expect(Schema.is(VcsCompareCommitsInput)({ ...input, headCommit: "HEAD" })).toBe(false);
    expect(Schema.is(VcsCompareCommitsInput)({ ...input, headCommit: "f".repeat(64) })).toBe(true);
    const calls: GitVcsDriver.ExecuteGitInput[] = [];
    const revisions: string[] = [];
    let mode = "normal";
    const failure = new GitCommandError({ operation: "fixture", command: "git", cwd: input.cwd, detail: "Native Git failure" });
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: ({ cwd }) => Effect.succeed({
          kind: "git",
          repository: {
            kind: "git", rootPath: cwd, metadataPath: `${cwd}/.git`,
            freshness: { source: "live-local", observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"), expiresAt: Option.none() },
          },
          driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
        }),
      })),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({
        resolveCommit: ({ cwd, revision }) => {
          expect(cwd).toBe(input.cwd);
          expect([baseCommit, headCommit]).toContain(revision);
          revisions.push(revision);
          return mode === "resolve-error" ? Effect.fail(failure) : Effect.succeed({ commitSha: revision });
        },
        execute: (request) => {
          calls.push(request);
          expect(request.cwd).toBe(input.cwd);
          const command = request.args[0];
          if (command === "diff" && mode === "diff-error") return Effect.fail(failure);
          const log = mode === "empty-log" ? "" : mode === "malformed-log" ? `${headCommit}\0broken\0`
            : [headCommit, authoredAt, "Selected subject", "c".repeat(40), authoredAt, "Next subject", ""].join("\0");
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(command === "merge-base" ? mode === "ancestry-error" ? 128 : 1 : 0),
            stdout: command === "log" ? log : command === "diff" ? patch : "", stderr: "",
            stdoutTruncated: (command === "log" && mode === "truncated-log") || (command === "diff" && mode === "truncated-diff"),
            stderrTruncated: false,
          });
        },
      })),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      expect(yield* workflow.compareCommits(input)).toEqual({
        baseCommit, headCommit, baseIsAncestor: false,
        commits: [{ commitSha: headCommit, authoredAt, subject: "Selected subject" }],
        nextOffset: 8, diff: patch, diffTruncated: false,
      });
      expect(revisions).toEqual([baseCommit, headCommit]);
      expect(calls.map((call) => call.args)).toEqual([
        ["merge-base", "--is-ancestor", baseCommit, headCommit],
        ["log", "--no-show-signature", "-z", "--format=%H%x00%aI%x00%s", "--max-count=2", "--skip=7", `${baseCommit}..${headCommit}`, "--"],
        ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--ignore-submodules=none", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/", baseCommit, headCommit, "--"],
      ]);
      expect(calls[1]).toMatchObject({ maxOutputBytes: 1024 * 1024, appendTruncationMarker: false });
      expect(calls[2]).toMatchObject({ maxOutputBytes: 2 * 1024 * 1024, appendTruncationMarker: true });
      mode = "truncated-diff";
      expect(yield* workflow.compareCommits(input)).toMatchObject({ diff: patch, diffTruncated: true });
      mode = "empty-log";
      expect(yield* workflow.compareCommits(input)).toMatchObject({ commits: [], nextOffset: null, diff: patch });
      for (mode of ["ancestry-error", "malformed-log", "truncated-log", "resolve-error", "diff-error"]) {
        expect(yield* workflow.compareCommits(input).pipe(Effect.flip)).toMatchObject({ _tag: "GitCommandError" });
      }
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("reads the HEAD baseline without treating command errors as missing commits", () => {
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const calls: string[] = [];
    const commandError = new GitCommandError({ operation: "fixture", command: "git", cwd: "/call-error", detail: "Process failed" });
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: ({ cwd }) => cwd === "/not-a-repo" ? Effect.succeed(null)
          : cwd === "/detect-error" ? Effect.fail(new VcsRepositoryDetectionError({ operation: "detect", cwd, detail: "Detection failed" }))
          : Effect.succeed({
            kind: "git",
            repository: {
              kind: "git", rootPath: cwd, metadataPath: `${cwd}/.git`,
              freshness: { source: "live-local", observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"), expiresAt: Option.none() },
            },
            driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
          }),
      })),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: (input) => {
          calls.push(input.cwd);
          expect(input.args).toEqual(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
          expect(input.allowNonZeroExit).toBe(true);
          if (input.cwd === "/call-error") return Effect.fail(commandError);
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(input.cwd === "/unresolved" ? 1 : input.cwd === "/fatal" ? 128 : 0),
            stdout: `${commitSha}\n`, stderr: "", stdoutTruncated: false, stderrTruncated: false,
          });
        },
      })),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      expect(yield* workflow.readHead({ cwd: "/not-a-repo" })).toEqual({ isRepo: false, commitSha: null });
      expect(calls).toEqual([]);
      expect(yield* workflow.readHead({ cwd: "/unresolved" })).toEqual({ isRepo: true, commitSha: null });
      expect(yield* workflow.readHead({ cwd: "/repo" })).toEqual({ isRepo: true, commitSha });
      expect(yield* workflow.readHead({ cwd: "/fatal" }).pipe(Effect.flip)).toMatchObject({ _tag: "GitCommandError", exitCode: 128 });
      expect(yield* workflow.readHead({ cwd: "/call-error" }).pipe(Effect.flip)).toBe(commandError);
      expect(yield* workflow.readHead({ cwd: "/detect-error" }).pipe(Effect.flip)).toMatchObject({ _tag: "GitManagerError" });
      expect(calls).toEqual(["/unresolved", "/repo", "/fatal", "/call-error"]);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("reports a non-Git VCS repository as not a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });
});
