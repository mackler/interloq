// The Store service on the platform services: the files in <project>/plan-review/ and the
// comparison of the project state (decoded and compared by src/snapshot.ts).
// API names: docs/effect-v4-api.md.

import { Cause, Clock, Effect, Exit, FileSystem, Layer, Option, Path, type PlatformError, Ref, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash } from "node:crypto";
import { type Artifact, guardedRecord, LOG_SUBJECTS, pathOf, RECORDS_DIR, reviewedFile, RUNS_DIR, type RunRoot, recordPath, type SubjectId, suffixedRoot } from "./artifacts.ts";
import { FileSystemError, GitError } from "./errors.ts";
import { type LogEntry, PlanFile, type RecordedPlan, type UsageRecord } from "./schema.ts";
import { renderPlanMarkdown } from "./plan.ts";
import type { Platform } from "./platform.ts";
import { AnalysisFile, Baseline, TermsFile, type CheckpointPoint, questionsFile, readLog, readQuestions, readUsage, VERSION } from "./records.ts";
import { renderDecision, renderFeedback, subjectHeading } from "./render.ts";
import { type ProjectPath, type RecordPath, Store, type StoreError, type StoreShape } from "./services.ts";
import { decodeStatusV2, excluded, excludedIndexPaths, type OwnWrite, type RecordsSnapshot, type Snapshot, type WorkingTreeEntry } from "./snapshot.ts";
import { decodeText } from "./state.ts";
import type { LimitWait, UsageLine } from "./usage.ts";

/**
 * The store of one run of one project (issue #120): its records are under <project>/plan-review/<root>/, a root that
 * allocateRunRoot created. `ignorePaths` are the paths the change detection ignores (config).
 */
export const makeStore = (projectDir: string, root: RunRoot, ignorePaths: readonly string[]): Effect.Effect<StoreShape, never, Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const project = path.resolve(projectDir) as ProjectPath;
    const dir = path.join(project, RECORDS_DIR, root) as RecordPath;
    const at = (artifact: Artifact): string => path.join(dir, pathOf(artifact));
    const plan = at({ kind: "plan" }) as RecordPath;
    const questions = at({ kind: "questions" }) as RecordPath;
    const requirements = at({ kind: "requirements" }) as RecordPath;
    const decisionsFile = at({ kind: "decisions" });
    const feedbackFile = at({ kind: "feedback" });
    const conversationFile = at({ kind: "conversation" });
    const usageFile = at({ kind: "usage" });

    /** Every file-system call goes through here, so no PlatformError escapes. */
    const io = <A>(operation: string, file: string, effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, FileSystemError> =>
      Effect.mapError(effect, (e) => new FileSystemError({ operation, path: file, message: e.message }));
    const exists = (file: string) => io("read", file, fs.exists(file));
    const readText = (file: string) => io("read", file, fs.readFileString(file));

    /**
     * The journal of the program's own writes to guarded records, each with its preimage (issue #26): the records guard of
     * a read-only call replays it, so that the program's writes during a retry's wait are accepted and an external change
     * before or after one of them is not. Every write helper below goes through `journaled`.
     */
    const journal = yield* Ref.make<readonly OwnWrite[]>([]);
    /** The path of a file relative to plan-review/ with "/" separators, when it is a guarded record; null otherwise. */
    const guardedPath = (file: string): string | null => {
      const relative = path.relative(dir, file).split(path.sep).join("/");
      return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || !guardedRecord(relative) ? null : relative;
    };
    /** A guarded path's entry as recordsSnapshot gives it; null when it is absent. */
    const entryOf = (relative: string): Effect.Effect<string | null, FileSystemError> =>
      inspect(path.relative(project, path.join(dir, relative))).pipe(
        Effect.map((entry) => (entry.type === "missing" ? null : entry.type === "file" ? `file:${entry.hash}` : entry.type === "link" ? `link:${entry.target}` : entry.type)),
      );
    /** Runs a write of `files`, and journals each guarded one it changed, with its entry before and after. */
    const journaled = <A, E>(files: readonly string[], write: Effect.Effect<A, E>): Effect.Effect<A, E | FileSystemError> =>
      Effect.gen(function* () {
        const guarded = files.flatMap((file) => {
          const relative = guardedPath(file);
          return relative === null ? [] : [relative];
        });
        const before: (string | null)[] = [];
        for (const relative of guarded) before.push(yield* entryOf(relative));
        const result = yield* write;
        for (const [i, relative] of guarded.entries()) {
          const after = yield* entryOf(relative);
          if (after !== before[i]) yield* Ref.update(journal, (writes) => [...writes, { path: relative, before: before[i] ?? null, after }]);
        }
        return result;
      });
    /** The directory and its ancestors below the run's records directory, outermost first: what a recursive creation may create. */
    const ancestors = (d: string): readonly string[] => (guardedPath(d) === null ? [] : [...ancestors(path.dirname(d)), d]);
    const writeText = (file: string, text: string) => journaled([file], io("write", file, fs.writeFileString(file, text)));
    const append = (file: string, text: string) => journaled([file], io("append to", file, fs.writeFileString(file, text, { flag: "a" })));
    const mkdir = (d: string) => journaled(ancestors(d), io("create directory", d, fs.makeDirectory(d, { recursive: true })));
    /** Renames a temporary file into place. */
    const renameInto = (temporary: string, file: string) => journaled([temporary, file], io("rename", file, fs.rename(temporary, file)));
    const list = (d: string) => io("list", d, fs.readDirectory(d));
    /** The current time of the Clock service (finding 22), as an ISO string. */
    const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
    /** True when the platform error says the path already exists. */
    const alreadyExists = (e: PlatformError.PlatformError): boolean => e.reason._tag === "AlreadyExists";
    /** JSON text of a value, inside the effect: a value that cannot be serialized is a FileSystemError ("serialize"). */
    const serialize = (file: string, value: unknown, indent?: number): Effect.Effect<string, FileSystemError> =>
      Effect.try({
        try: () => JSON.stringify(value, null, indent),
        catch: (e: unknown) => new FileSystemError({ operation: "serialize", path: file, message: e instanceof Error ? e.message : String(e) }),
      });
    /**
     * Writes one JSON record, creating its directory: the text goes to `<file>.tmp-<pid>` and is renamed into
     * place, so a reader sees the previous record or the new one, never a partial one (finding 16; Q6).
     */
    const writeJson = (file: string, value: unknown) =>
      Effect.gen(function* () {
        const text = yield* serialize(file, value, 2);
        yield* mkdir(path.dirname(file));
        const temporary = `${file}.tmp-${process.pid}`;
        yield* writeText(temporary, text + "\n");
        yield* renameInto(temporary, file);
      });
    /** plan-review/checkpoint.json: the last committed transition, replaced atomically. */
    const checkpoint = (point: CheckpointPoint) => now.pipe(Effect.flatMap((time) => writeJson(at({ kind: "checkpoint" }), { version: VERSION, ...point, time })));
    /** One record of the catalog, as JSON. */
    const saveRecord = (artifact: Artifact, value: unknown) => writeJson(at(artifact), value);
    /** The entries of a log file; none when it does not exist. */
    const readLogFile = (subject: SubjectId): Effect.Effect<readonly LogEntry[], StoreError> => {
      const file = at({ kind: "log", subject });
      return exists(file).pipe(Effect.flatMap((present) => (present ? readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(readLog(file, text)))) : Effect.succeed([]))));
    };
    /** Decision k's entries in decision-log.json are those whose id carries its number (D6 of the decision-support plan). */
    const ofDecision = (k: number) => (entry: LogEntry): boolean => entry.id.startsWith(`D${k}-`);
    const decisionOf = (subject: SubjectId): number | null => (typeof subject === "object" && "decision" in subject ? subject.decision : null);
    /** A decision's save keeps the other decisions' entries as they are on disk, so that nested decisions lose none. */
    const saveLog = (subject: SubjectId, log: readonly LogEntry[]) =>
      Effect.gen(function* () {
        const k = decisionOf(subject);
        const others = k === null ? [] : (yield* readLogFile(subject)).filter((e) => !ofDecision(k)(e));
        yield* saveRecord({ kind: "log", subject }, { version: VERSION, entries: [...others, ...log] });
      });
    const converse = (markdown: string) => append(conversationFile, markdown);
    /** The hash of the bytes of a subject's reviewed artifact; "" when it does not exist. */
    const recordHash = (subject: SubjectId): Effect.Effect<string, FileSystemError> =>
      Effect.gen(function* () {
        const file = at(reviewedFile(subject));
        if (!(yield* exists(file))) return "";
        return createHash("sha256").update(yield* io("read", file, fs.readFile(file))).digest("hex");
      });

    /**
     * What is at a working-tree path: a link is the link itself (readLink, which also works for a dangling
     * link), a regular file its content hash, a directory or a missing path as such. stat follows links,
     * so readLink is asked first.
     */
    const inspect = (relative: string): Effect.Effect<WorkingTreeEntry, FileSystemError> =>
      Effect.gen(function* () {
        const file = path.join(project, relative);
        const link = yield* fs.readLink(file).pipe(Effect.map(Option.some), Effect.catch(() => Effect.succeed(Option.none<string>())));
        if (Option.isSome(link)) return { type: "link" as const, target: link.value };
        const stat = yield* Effect.exit(fs.stat(file));
        if (Exit.isFailure(stat)) {
          const error = Cause.findErrorOption(stat.cause);
          if (Option.isSome(error) && error.value.reason._tag === "NotFound") return { type: "missing" as const };
          return yield* Effect.fail(new FileSystemError({ operation: "stat", path: file, message: Option.isSome(error) ? error.value.message : String(Cause.squash(stat.cause)) }));
        }
        if (stat.value.type === "Directory") return { type: "directory" as const };
        const bytes = yield* io("read", file, fs.readFile(file));
        return { type: "file" as const, hash: createHash("sha256").update(bytes).digest("hex") };
      });

    /** One git command in the project, with extra environment variables. A non-zero exit or a spawn failure is a GitError. */
    const git = (args: string[], env: Readonly<Record<string, string>> = {}): Effect.Effect<string, GitError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const options = Object.keys(env).length === 0 ? undefined : { env: { ...env }, extendEnv: true };
          const handle = yield* spawner.spawn(ChildProcess.make("git", ["-C", project, ...args], options));
          const [out, err] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))], { concurrency: "unbounded" });
          const code = yield* handle.exitCode;
          if (code !== 0) return yield* Effect.fail(new GitError({ args, message: err.trim() !== "" ? err.trim() : `exit code ${code}` }));
          return out;
        }),
      ).pipe(Effect.catchTag("PlatformError", (e) => Effect.fail(new GitError({ args, message: e.message }))));

    /** A path that git names relative to the project (`rev-parse --git-path`), made absolute. */
    const gitPath = (name: string) => git(["rev-parse", "--git-path", name]).pipe(Effect.map((out) => path.resolve(project, out.trim())));
    /**
     * The tree of the working tree as the work review sees it (decision Q7): a temporary index in the git
     * directory (outside the working tree, so it can never be staged itself; P1-R2-1), started as a copy of
     * the repository's index so that tracked files matching .gitignore stay in it (P1-R1-5), then
     * `git add -A`, then the removal of exactly the paths `excluded` selects, as literal pathspecs (P4-R1-1),
     * then `git write-tree`. The temporary files are removed on every exit.
     *
     * The hazard of two runs (issue #120): the temporary index is in the git directory, which every run in the project
     * shares, and `git add -A` there reads the whole working tree. Two runs building a tree at once could collide. With one
     * run per mode only the implementation run builds one (a refinement run writes no baseline and has no work review),
     * so it cannot arise now; it would as soon as a second implementation run in one project is allowed.
     */
    const workingTree = (): Effect.Effect<string, StoreError> =>
      Effect.gen(function* () {
        const stamp = `${(yield* Clock.currentTimeMillis)}-${process.pid}`;
        const index = yield* gitPath("index");
        const temporary = yield* gitPath(`plan-review-index-${stamp}`);
        const pathspecs = yield* gitPath(`plan-review-pathspecs-${stamp}`);
        const cleanup = Effect.all([fs.remove(temporary, { force: true }), fs.remove(pathspecs, { force: true })]).pipe(Effect.ignore);
        const build = Effect.gen(function* () {
          if (yield* exists(index)) yield* io("copy", index, fs.copyFile(index, temporary));
          const env = { GIT_INDEX_FILE: temporary };
          yield* git(["add", "-A", "--", "."], env);
          const listed = (yield* git(["ls-files", "-z"], env)).split("\0").filter((p) => p !== "");
          const removed = excludedIndexPaths(listed, ignorePaths);
          if (removed.length > 0) {
            yield* writeText(pathspecs, removed.map((p) => p + "\0").join(""));
            yield* git(["rm", "--cached", "-q", `--pathspec-from-file=${pathspecs}`, "--pathspec-file-nul"], { ...env, GIT_LITERAL_PATHSPECS: "1" });
          }
          return (yield* git(["write-tree"], env)).trim();
        });
        return yield* build.pipe(Effect.ensuring(cleanup));
      });
    const baselineFile = at({ kind: "baseline" });
    /** The text of the diff from the baseline tree to the current one; null before init wrote the baseline. */
    const diffText = (): Effect.Effect<string | null, StoreError> =>
      Effect.gen(function* () {
        if (!(yield* exists(baselineFile))) return null;
        const baseline = yield* Effect.fromResult(decodeText(baselineFile, Baseline, yield* readText(baselineFile)));
        return yield* git(["diff", "--no-color", "--no-ext-diff", baseline.tree, yield* workingTree()]);
      });

    return {
      project,
      root,
      dir,
      plan,
      questions,
      requirements,

      /**
       * Starts the run in its own records directory (issue #120): nothing of another run is moved or read, so archiving
       * has no work left; the archives and loose files of runs before that change stay where they are.
       */
      init: (task) =>
        Effect.gen(function* () {
          yield* mkdir(dir);
          for (const subject of LOG_SUBJECTS) yield* saveLog(subject, []);
          yield* writeText(decisionsFile, "");
          yield* writeText(feedbackFile, "");
          yield* writeText(conversationFile, `# Conversation record\n\nTask: ${task}\n\n`);
          yield* checkpoint({ subject: "run", phase: 0, round: 0, stage: "started" });
        }),
      writeBaseline: () =>
        Effect.gen(function* () {
          yield* writeJson(baselineFile, { version: VERSION, tree: yield* workingTree(), time: yield* now });
        }),
      saveReview: (subject, round, review) => saveRecord({ kind: "review", subject, round }, review),
      saveResponse: (subject, round, response) => saveRecord({ kind: "response", subject, round }, response),
      saveCorrection: (subject, round, attempt, reply) => saveRecord({ kind: "correction", subject, round, attempt }, reply),
      saveRound: (subject, record) => saveRecord({ kind: "round", subject, round: record.round }, { version: VERSION, ...record }),
      savePlanWrite: (phase, result) => saveRecord({ kind: "planWrite", phase }, result),
      saveExecution: (phase, outcome) => saveRecord({ kind: "execution", phase }, outcome),
      saveQuestions: (task, list) => saveRecord({ kind: "questions" }, questionsFile(task, list)),
      // The readers accept the version-1 files of earlier runs as well (Q5's follow-up).
      loadQuestions: () => readText(questions).pipe(Effect.flatMap((text) => Effect.fromResult(readQuestions(questions, text)))),
      writeRequirements: (text) => writeText(requirements, text),
      loadLog: (subject) => {
        const k = decisionOf(subject);
        if (k !== null) return readLogFile(subject).pipe(Effect.map((entries) => entries.filter(ofDecision(k))));
        const file = at({ kind: "log", subject });
        return readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(readLog(file, text))));
      },
      saveLog,
      /** One decision event gives both the record line and the transcript line (finding 15). */
      appendDecision: (event) => {
        const lines = renderDecision(event);
        return append(decisionsFile, lines.record).pipe(Effect.andThen(converse(lines.conversation)));
      },
      recordFeedback: (subject, round, text) => append(feedbackFile, renderFeedback(subjectHeading(subject), round, text)),
      converse,
      /**
       * Appends one line to usage.jsonl: the usage an agent reported for one call, as a version-2 record
       * (Q5). The time is read when the effect runs, and it is the store's.
       */
      recordUsage: (line) =>
        Effect.gen(function* () {
          const time = yield* now;
          const record: UsageRecord =
            line.agent === "claude"
              ? { version: VERSION, agent: "claude", time, session: line.session, num_turns: line.turns, total_cost_usd: line.totalCostUsd }
              : { version: VERSION, agent: "codex", time, thread: line.thread, input_tokens: line.inputTokens, output_tokens: line.outputTokens };
          yield* append(usageFile, (yield* serialize(usageFile, record)) + "\n");
        }),
      /** The usage lines of either version in their per-agent shape (src/usage.ts folds them); no file gives none. */
      usageLines: () =>
        Effect.gen(function* () {
          if (!(yield* exists(usageFile))) return { calls: [], waits: [] };
          const records = yield* Effect.fromResult(readUsage(usageFile, yield* readText(usageFile)));
          const waits = records.flatMap((r): LimitWait[] =>
            "kind" in r ? [{ agent: r.agent, limitType: r.limit_type, fromMs: Date.parse(r.from), untilMs: Date.parse(r.until), endedMs: Date.parse(r.ended), outcome: r.outcome }] : [],
          );
          const calls = records.flatMap((r): UsageLine[] =>
            "kind" in r
              ? []
              : r.agent === "claude"
                ? [{ agent: "claude", session: r.session, turns: r.num_turns, totalCostUsd: r.total_cost_usd }]
                : [{ agent: "codex", thread: r.thread, inputTokens: r.input_tokens, outputTokens: r.output_tokens }],
          );
          return { calls, waits };
        }),
      /** A wait for a usage limit, as actually spent (issue #68): its scheduled end apart from its actual one. */
      recordLimitWait: (wait) =>
        Effect.gen(function* () {
          const iso = (ms: number) => new Date(ms).toISOString();
          const record: UsageRecord = { version: VERSION, kind: "usage_limit_wait", agent: wait.agent, time: yield* now, limit_type: wait.limitType, from: iso(wait.fromMs), until: iso(wait.untilMs), ended: iso(wait.endedMs), outcome: wait.outcome };
          yield* append(usageFile, (yield* serialize(usageFile, record)) + "\n");
        }),
      fileHash: (subject) =>
        typeof subject === "object" && "work" in subject
          ? diffText().pipe(Effect.map((text) => (text === null ? "" : createHash("sha256").update(text).digest("hex"))))
          : recordHash(subject),
      observeFile: (subject) =>
        typeof subject === "object" && "work" in subject
          ? diffText().pipe(Effect.map((text) => ({ hash: text === null ? "" : createHash("sha256").update(text).digest("hex"), text: "" })))
          : Effect.gen(function* () {
              const file = at(reviewedFile(subject));
              if (!(yield* exists(file))) return { hash: "", text: "" };
              const bytes = yield* io("read", file, fs.readFile(file));
              return { hash: createHash("sha256").update(bytes).digest("hex"), text: new TextDecoder().decode(bytes) };
            }),
      recordHash,
      /** Written to a temporary name and renamed into place, like the JSON records. */
      readChangeRecord: (phase) =>
        Effect.gen(function* () {
          const file = at({ kind: "changes", phase });
          return (yield* exists(file)) ? yield* readText(file) : "";
        }),
      changeRecord: (phase) =>
        Effect.gen(function* () {
          const file = at({ kind: "changes", phase });
          const text = (yield* diffText()) ?? "";
          yield* mkdir(path.dirname(file));
          const temporary = `${file}.tmp-${process.pid}`;
          yield* writeText(temporary, text);
          yield* renameInto(temporary, file);
        }),
      /**
       * Keeps a reply that did not match its schema, as plan-review/invalid-replies/<agent>-<n>.json, and returns
       * that relative path. The file is created exclusively (`wx`) and the number is retried while the name is
       * taken (finding 23): a gap in the sequence never leads to an overwrite.
       */
      saveInvalidReply: (agent, content) =>
        Effect.gen(function* () {
          const d = path.dirname(at({ kind: "invalidReply", agent, n: 1 }));
          yield* mkdir(d);
          let n = (yield* list(d)).filter((name) => name.startsWith(`${agent}-`)).length + 1;
          for (;;) {
            const artifact: Artifact = { kind: "invalidReply", agent, n };
            const file = at(artifact);
            const created = yield* fs.writeFileString(file, content, { flag: "wx" }).pipe(
              Effect.map(() => true),
              Effect.catch((e) => (alreadyExists(e) ? Effect.succeed(false) : Effect.fail(new FileSystemError({ operation: "create", path: file, message: e.message })))),
            );
            if (created) return recordPath(root, artifact);
            n++;
          }
        }),
      /**
       * The project outside plan-review/ (decision Q1): every path git lists as changed, staged, renamed,
       * unmerged or untracked, with its porcelain v2 record and what is in the working tree at it.
       * Gitignored files are unobserved; the excluded paths (plan-review/, ignorePaths) are dropped.
       */
      checkpoint,
      /** The creation of decision-<k>/ is the allocation: the lowest k whose directory does not exist yet, created exclusively. */
      openDecision: (question) =>
        Effect.gen(function* () {
          yield* mkdir(dir);
          for (let k = 1; ; k++) {
            const d = path.dirname(at({ kind: "decisionQuestion", decision: k }));
            const created = yield* journaled(
              [d],
              fs.makeDirectory(d).pipe(
                Effect.map(() => true),
                Effect.catch((e) => (alreadyExists(e) ? Effect.succeed(false) : Effect.fail(new FileSystemError({ operation: "create directory", path: d, message: e.message })))),
              ),
            );
            if (!created) continue;
            yield* saveRecord({ kind: "decisionQuestion", decision: k }, { version: VERSION, decision: k, phase: question.phase, label: question.label, question: question.question, options: question.options });
            return k;
          }
        }),
      savePlan: (recorded: RecordedPlan) =>
        Effect.gen(function* () {
          yield* saveRecord({ kind: "planFile" }, { version: VERSION, plan: recorded });
          // plan.md follows plan.json; a reader of plan.md never sees a plan that plan.json does not hold (F2).
          const temporary = `${plan}.tmp-${process.pid}`;
          yield* writeText(temporary, renderPlanMarkdown(recorded));
          yield* renameInto(temporary, plan);
        }),
      loadPlan: () => {
        const file = at({ kind: "planFile" });
        return exists(file).pipe(
          Effect.flatMap((present) =>
            present ? readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(decodeText(file, PlanFile, text))), Effect.map((f) => Option.some(f.plan))) : Effect.succeed(Option.none<RecordedPlan>()),
          ),
        );
      },
      saveAnalysisWrite: (decision, output) => saveRecord({ kind: "analysisWrite", decision }, output),
      saveAnalysis: (decision, analysis) => saveRecord({ kind: "analysis", decision }, { version: VERSION, analysis }),
      saveTerms: (entries) => saveRecord({ kind: "terms" }, { version: VERSION, entries }),
      loadTerms: () => {
        const file = at({ kind: "terms" });
        return exists(file).pipe(
          Effect.flatMap((present) => (present ? readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(decodeText(file, TermsFile, text))), Effect.map((f) => f.entries)) : Effect.succeed([]))),
        );
      },
      loadAnalysis: (decision) => {
        const file = at({ kind: "analysis", decision });
        return readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(decodeText(file, AnalysisFile, text))), Effect.map((f) => f.analysis));
      },
      saveChoice: (decision, choice) => saveRecord({ kind: "chosen", decision }, { version: VERSION, decision, answer: choice.answer, option: choice.option }),
      readContext: () =>
        Effect.gen(function* () {
          const read = (file: string) => exists(file).pipe(Effect.flatMap((present) => (present ? readText(file) : Effect.succeed(null))));
          return { requirements: yield* read(requirements), plan: yield* read(plan) };
        }),
      projectSnapshot: (): Effect.Effect<Snapshot, StoreError> =>
        Effect.gen(function* () {
          // --no-optional-locks (issue #120): a plain status may refresh .git/index under index.lock, and while it holds the lock
          // a commit by Claude Code in the other run fails; a snapshot never writes to the git directory.
          const records = decodeStatusV2(yield* git(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"])).filter((r) => !excluded(r.path, ignorePaths));
          const entries = new Map<string, { record: (typeof records)[number]; content: WorkingTreeEntry }>();
          for (const record of records) entries.set(record.path, { record, content: yield* inspect(record.path) });
          return { entries };
        }),
      journalMark: Ref.get(journal).pipe(Effect.map((writes) => writes.length)),
      ownWritesSince: (mark) => Ref.get(journal).pipe(Effect.map((writes) => writes.slice(mark))),
      /**
       * Every guarded path of the run's own records directory with what is there; the relative paths use "/"
       * (guardedRecord). Another run's records are not listed, so that its writes never halt this run (issue #120).
       */
      recordsSnapshot: (): Effect.Effect<RecordsSnapshot, StoreError> =>
        Effect.gen(function* () {
          if (!(yield* exists(dir))) return new Map();
          const listed = (yield* io("list", dir, fs.readDirectory(dir, { recursive: true }))).map((p) => p.split(path.sep).join("/")).filter(guardedRecord);
          const entries = new Map<string, string>();
          for (const relative of listed.sort()) {
            const entry = yield* inspect(path.relative(project, path.join(dir, relative)));
            entries.set(relative, entry.type === "file" ? `file:${entry.hash}` : entry.type === "link" ? `link:${entry.target}` : entry.type);
          }
          return entries;
        }),
    };
  });

export const storeLayer = (project: string, root: RunRoot, ignorePaths: readonly string[]): Layer.Layer<Store, never, Platform> => Layer.effect(Store, makeStore(project, root, ignorePaths));

/**
 * Creates the records directory of a run, <project>/plan-review/<root>, exclusively: `-2`, `-3`, … while the name
 * exists (as openDecision allocates decision-<k>). Returns the root as created.
 */
export const allocateRunRoot = (projectDir: string, root: RunRoot): Effect.Effect<RunRoot, FileSystemError, Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const records = path.join(path.resolve(projectDir), RECORDS_DIR);
    const runs = path.join(records, RUNS_DIR);
    yield* fs.makeDirectory(runs, { recursive: true }).pipe(Effect.mapError((e) => new FileSystemError({ operation: "create directory", path: runs, message: e.message })));
    for (let k = 1; ; k++) {
      const candidate = suffixedRoot(root, k);
      const d = path.join(records, candidate);
      const created = yield* fs.makeDirectory(d).pipe(
        Effect.map(() => true),
        Effect.catch((e) => (e.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(new FileSystemError({ operation: "create directory", path: d, message: e.message })))),
      );
      if (created) return candidate;
    }
  });
