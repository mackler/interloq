import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import { codexArgs, codexEnv } from "../src/codexArgs.ts";

// Issue #158: Interloq starts the Codex CLI itself; its arguments and environment are the SDK's.

const START: ThreadOptions = { workingDirectory: "/proj", sandboxMode: "danger-full-access", approvalPolicy: "never" };

test("codexArgs: a first turn with the options startPhase passes, with and without a model", () => {
  assert.deepEqual(codexArgs({ options: START, threadId: null, outputSchemaFile: "/tmp/s/schema.json" }), [
    "exec", "--experimental-json", "--sandbox", "danger-full-access", "--cd", "/proj",
    "--output-schema", "/tmp/s/schema.json", "--config", 'approval_policy="never"',
  ]);
  assert.deepEqual(codexArgs({ options: { ...START, model: "gpt-x" }, threadId: null, outputSchemaFile: null }), [
    "exec", "--experimental-json", "--model", "gpt-x", "--sandbox", "danger-full-access", "--cd", "/proj",
    "--config", 'approval_policy="never"',
  ]);
});

test("codexArgs: a resumed turn ends with resume and the thread's id", () => {
  assert.deepEqual(codexArgs({ options: START, threadId: "th-1", outputSchemaFile: "/s.json" }), [
    "exec", "--experimental-json", "--sandbox", "danger-full-access", "--cd", "/proj",
    "--output-schema", "/s.json", "--config", 'approval_policy="never"', "resume", "th-1",
  ]);
});

test("codexEnv: the defined inherited variables, the originator, the executable's directories first on PATH", () => {
  const env = codexEnv({ A: "1", B: undefined, PATH: "/usr/bin:/x:/bin" }, ["/x", "/y"]);
  assert.deepEqual(env, { A: "1", PATH: "/x:/y:/usr/bin:/bin", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_sdk_ts" });
  assert.equal(codexEnv({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "mine" }, []).CODEX_INTERNAL_ORIGINATOR_OVERRIDE, "mine");
  assert.equal(codexEnv({}, []).PATH, undefined);
});

const options: fc.Arbitrary<ThreadOptions> = fc.record(
  {
    model: fc.string({ minLength: 1 }),
    threadSource: fc.string(),
    sandboxMode: fc.constantFrom("read-only", "workspace-write", "danger-full-access"),
    workingDirectory: fc.string({ minLength: 1 }),
    skipGitRepoCheck: fc.boolean(),
    modelReasoningEffort: fc.constantFrom("minimal", "low", "medium", "high"),
    networkAccessEnabled: fc.boolean(),
    webSearchMode: fc.constantFrom("disabled", "cached", "live"),
    webSearchEnabled: fc.boolean(),
    approvalPolicy: fc.constantFrom("never", "on-request", "on-failure", "untrusted"),
    additionalDirectories: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
  },
  { requiredKeys: [] },
) as fc.Arbitrary<ThreadOptions>;

test("property: codexArgs begins with exec --experimental-json, resumes iff a thread id is given, and carries each option", () => {
  fc.assert(
    fc.property(options, fc.option(fc.string({ minLength: 1 }), { nil: null }), (o, threadId) => {
      const args = codexArgs({ options: o, threadId, outputSchemaFile: null });
      assert.deepEqual(args.slice(0, 2), ["exec", "--experimental-json"]);
      const at = args.indexOf("resume");
      assert.equal(threadId !== null, at >= 0 && args[at + 1] === threadId);
      if (o.model) assert.ok(args.includes("--model") && args.includes(o.model));
      if (o.sandboxMode) assert.ok(args.includes("--sandbox"));
      if (o.workingDirectory) assert.equal(args[args.indexOf("--cd") + 1], o.workingDirectory);
      if (o.skipGitRepoCheck) assert.ok(args.includes("--skip-git-repo-check"));
      for (const d of o.additionalDirectories ?? []) assert.ok(args.includes(d));
      if (o.approvalPolicy) assert.ok(args.includes(`approval_policy="${o.approvalPolicy}"`));
    }),
  );
});

/** A fake CLI that records its argv and stdin, then prints a converging turn. */
const recordingCli = (dir: string): { path: string; record: string } => {
  const record = path.join(dir, "record.json");
  const file = path.join(dir, "codex");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input }));
  const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
  out({ type: "thread.started", thread_id: "th-9" });
  out({ type: "item.completed", item: { id: "m", type: "agent_message", text: "{}" } });
  out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
});
`,
    { mode: 0o755 },
  );
  return { path: file, record };
};

const drain = async (events: AsyncGenerator<unknown>): Promise<void> => {
  for await (const _ of events) void _;
};

/** The schema file's position compared, its path not: each turn writes a fresh one. */
const withoutSchemaPath = (args: readonly string[]): string[] => args.map((a, i) => (i > 0 && args[i - 1] === "--output-schema" ? "<schema>" : a));

const SEAM_OPTIONS: readonly ThreadOptions[] = [START, { ...START, model: "gpt-x" }, { model: "m", skipGitRepoCheck: true, modelReasoningEffort: "high", networkAccessEnabled: false, webSearchMode: "live", additionalDirectories: ["/a", "/b"], threadSource: "src" }];

test("the seam: the SDK's exec and codexArgs give the CLI the same arguments, first and resumed turns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-args-"));
  try {
    const cli = recordingCli(dir);
    for (const o of SEAM_OPTIONS) {
      const codex = new Codex({ codexPathOverride: cli.path });
      const first = codex.startThread(o);
      await drain((await first.runStreamed("prompt", { outputSchema: { type: "object" } })).events);
      const sdkFirst = JSON.parse(fs.readFileSync(cli.record, "utf8")).argv as string[];
      assert.deepEqual(withoutSchemaPath(sdkFirst), withoutSchemaPath(codexArgs({ options: o, threadId: null, outputSchemaFile: "x" })));
      const resumed = codex.resumeThread("th-9", o);
      await drain((await resumed.runStreamed("again")).events);
      const sdkResumed = JSON.parse(fs.readFileSync(cli.record, "utf8")).argv as string[];
      assert.deepEqual(sdkResumed, [...codexArgs({ options: o, threadId: "th-9", outputSchemaFile: null })]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
