import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Result } from "effect";
import { agentJsonSchema, rawJsonSchema, strictJsonSchema, type Json } from "../src/jsonSchema.ts";
import * as S from "../src/schema.ts";
import * as legacy from "./fixtures/legacy-schemas.ts";

// The seven schemas that an agent call passes as its output schema.
// Decision Q1 of the decision-support task: questions_for_user is a list of structured questions; the legacy schemas stay frozen.
// S3 (issues #36, #59): with its context paragraph and the explanations of its terms. Issue #36 (30 Sep 2026): every text
// is pieces, the context blocks of pieces (a paragraph, a list with levels, a code block), and the explanations a list.
const pieces = { type: "array", items: { type: "object", properties: { text: { type: "string" }, ref: { type: "string" }, code: { type: "boolean" } } } };
const blocks = {
  type: "array",
  items: {
    anyOf: [
      { type: "object", properties: { kind: { type: "string", enum: ["paragraph"] }, pieces } },
      { type: "object", properties: { kind: { type: "string", enum: ["list"] }, items: { type: "array", items: { type: "object", properties: { level: { type: "integer" }, pieces } } } } },
      { type: "object", properties: { kind: { type: "string", enum: ["code"] }, text: { type: "string" } } },
    ],
  },
};
const explanations = { type: "array", items: { type: "object", properties: { id: { type: "string" }, term: { type: "string" }, explanation: { type: "string" } } } };
const options = { type: "array", items: { type: "object", properties: { label: pieces, description: pieces } } };
const userQuestions = {
  type: "array",
  items: {
    type: "object",
    properties: { context: blocks, question: pieces, explanations, options },
  },
};
/** The legacy question list with the context of each entry (S3), placed after its id, and its texts as pieces (issue #36). */
const withContext = <T extends { properties: { questions: { items: { properties: object } } } }>(schema: T): T => ({
  ...schema,
  properties: {
    ...schema.properties,
    questions: {
      ...schema.properties.questions,
      items: {
        ...schema.properties.questions.items,
        properties: (({ id, default_answer }) => ({ id, context: blocks, question: pieces, reason: blocks, proposed_answers: options, default_answer }))(schema.properties.questions.items.properties as { id: unknown; default_answer: unknown }),
      },
    },
  },
});
const withQuestions = <T extends { properties: object }>(schema: T): T => ({ ...schema, properties: { ...schema.properties, questions_for_user: userQuestions } });
const agentSchemas = {
  review: { effect: S.Review, legacy: legacy.reviewSchema },
  plannerResponse: { effect: S.PlannerResponse, legacy: withQuestions(legacy.plannerResponseSchema) },
  planWrite: { effect: S.PlanWriteResult, legacy: withQuestions(legacy.planWriteSchema) },
  execReport: { effect: S.ExecReport, legacy: legacy.execReportSchema },
  questionList: { effect: S.QuestionList, legacy: withContext(legacy.questionListSchema) },
  questionListResponse: { effect: S.QuestionListResponse, legacy: withContext(withQuestions(legacy.questionListResponseSchema)) },
  // Issue #21 (Q6 follow-up): the interview turn has asked_ids beyond the frozen legacy schema, which stays frozen.
  interviewTurn: {
    effect: S.InterviewTurn,
    legacy: {
      ...legacy.interviewTurnSchema,
      properties: (({ message_to_user, ...rest }) => ({
        message_to_user,
        // Issue #35 (Q5, Q6): the question the message asks now, its id and its text alone.
        // S3: with its context, explanations and options, as pieces (issue #36).
        current_question: { type: "object", properties: { id: { type: "string" }, context: blocks, text: pieces, explanations, options } },
        asked_ids: { type: "array", items: { type: "string" } },
        ...rest,
      }))(legacy.interviewTurnSchema.properties),
    },
  },
};

const proven = (name: string, variant: "raw" | "strict"): Json =>
  JSON.parse(fs.readFileSync(new URL(`../prototypes/proto-schema-output/${name}.${variant}.json`, import.meta.url), "utf8"));
const chosen = fs.readFileSync(new URL("../prototypes/proto-schema-output/CHOSEN", import.meta.url), "utf8").trim() as "raw" | "strict";
/** The strict variant, which every agent schema supports (finding 24: the transform is total and typed). */
const strict = (json: Json): Json => {
  const result = strictJsonSchema(json);
  assert.ok(Result.isSuccess(result), `the strict transform rejected the schema: ${JSON.stringify(Result.isFailure(result) ? result.failure : null)}`);
  return result.success;
};

test("the strict transform closes every object and requires every key", () => {
  const input: Json = {
    type: "object",
    properties: {
      open: { type: "object", properties: { a: { type: "string" } } },
      list: { type: "array", items: { $ref: "#/$defs/Entry" } },
    },
    required: ["open"],
    $defs: { Entry: { type: "object", properties: { b: { type: "number" } } } },
  };
  assert.deepEqual(strict(input), {
    type: "object",
    properties: {
      open: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
      list: { type: "array", items: { type: "object", properties: { b: { type: "number" } }, required: ["b"], additionalProperties: false } },
    },
    required: ["open", "list"],
    additionalProperties: false,
  });
});

test("the agent schemas have the shape of the legacy schemas", () => {
  for (const [name, { effect, legacy: old }] of Object.entries(agentSchemas)) {
    assert.deepEqual(strict(rawJsonSchema(effect)), strict(old as Json), `${name} differs from the legacy schema`);
  }
});

test("the production schemas generate exactly what the prototype proved", () => {
  for (const [name, { effect }] of Object.entries(agentSchemas)) {
    assert.deepEqual(rawJsonSchema(effect), proven(name, "raw"), `${name} raw`);
    assert.deepEqual(strict(rawJsonSchema(effect)), proven(name, "strict"), `${name} strict`);
  }
});

test("agents receive the variant proven in the prototype", () => {
  for (const [name, { effect }] of Object.entries(agentSchemas)) {
    assert.deepEqual(agentJsonSchema(effect), proven(name, chosen), `${name} is not the ${chosen} variant`);
  }
});

// Finding 24: a reference the transform cannot resolve is a typed rejection, not `undefined` or a stack overflow.
test("a missing $ref is a dangling_ref rejection naming the path, and a cyclic definition terminates with cyclic_ref", () => {
  const dangling = strictJsonSchema({ type: "object", properties: { a: { $ref: "#/$defs/Missing" } }, $defs: {} });
  assert.ok(Result.isFailure(dangling));
  assert.deepEqual(dangling.failure, { reason: "dangling_ref", at: "properties.a" });
  const cyclic = strictJsonSchema({ type: "object", properties: { a: { $ref: "#/$defs/Node" } }, $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } } });
  assert.ok(Result.isFailure(cyclic));
  assert.equal(cyclic.failure.reason, "cyclic_ref");
  const siblings = strictJsonSchema({ type: "object", properties: { a: { $ref: "#/$defs/E", description: "d" } }, $defs: { E: { type: "string" } } });
  assert.ok(Result.isFailure(siblings));
  assert.equal(siblings.failure.reason, "ref_with_siblings");
});

// Decision support, plan step 1.2: the recursive representation, as prototypes/proto-recursive-schema.ts proved it.
test("the decision analysis generates an object root, a $defs cycle, and closed objects with complete required lists", () => {
  for (const schema of [S.DecisionAnalysis, S.DecisionResponse, S.DecisionApplied]) {
    const json = agentJsonSchema(schema);
    assert.equal(json.type, "object", "the root is an object, never a bare $ref (the Agent SDK rejects one)");
    assert.equal(json.$ref, undefined);
    const defs = json.$defs as Record<string, Json>;
    assert.ok(defs !== undefined && Object.keys(defs).length > 0, "the recursion is a $defs definition");
    assert.ok(Object.values(defs).some((d) => JSON.stringify(d).includes("#/$defs/")), "a definition refers to a definition: a cycle");
    const objects: Json[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      const n = node as Json;
      if (n.type === "object") objects.push(n);
      Object.values(n).forEach(walk);
    };
    walk(json);
    for (const o of objects) {
      assert.equal(o.additionalProperties, false);
      assert.deepEqual([...(o.required as string[])].sort(), Object.keys(o.properties as Json).sort());
    }
    // Recorded, not worked around: the strict transform inlines every $ref and cannot inline a cycle.
    const strictResult = strictJsonSchema(json);
    assert.ok(Result.isFailure(strictResult));
    assert.equal(strictResult.failure.reason, "cyclic_ref");
  }
});

// Decision support, plan step 6.2: the files the prototype sends for the recursive schemas are what src/schema.ts generates.
test("the decision schemas' raw files in prototypes/proto-schema-output/ are what the program sends", () => {
  for (const [name, schema] of [["decisionAnalysis", S.DecisionAnalysis], ["decisionResponse", S.DecisionResponse], ["decisionApplied", S.DecisionApplied]] as const) {
    assert.deepEqual(agentJsonSchema(schema), proven(name, "raw"), name);
  }
});

// Issue #35 (Q8): a column is argued or unclear, a union the agents receive as anyOf of two closed objects.
test("a decision column is an anyOf of an argued column and an unclear column, each tagged by kind", () => {
  const json = agentJsonSchema(S.DecisionAnalysis);
  const found: Json[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const n = node as Json;
    if (Array.isArray(n.anyOf)) found.push(n);
    Object.values(n).forEach(walk);
  };
  walk(json);
  const columns = found.find((n) => (n.anyOf as Json[]).every((m) => (m.properties as Json | undefined)?.kind !== undefined));
  assert.ok(columns !== undefined, JSON.stringify(json).slice(0, 400));
  assert.deepEqual((columns.anyOf as Json[]).map((m) => Object.keys(m.properties as Json).sort()), [["advantages", "disadvantages", "kind", "option"], ["kind", "option", "unclear"]]);
});

// P1-R1-2: the prototype defines its own copies of the schemas; they must be what the program sends, or the proof proves
// another shape.
test("the prototype's schemas generate what the program sends", async () => {
  const { protoSchemas, protoRaw } = await import("../prototypes/protoSchemas.ts");
  for (const [name, schema] of [["interviewTurn", S.InterviewTurn], ["decisionAnalysis", S.DecisionAnalysis], ["decisionResponse", S.DecisionResponse], ["decisionApplied", S.DecisionApplied], ["review", S.Review], ["plannerResponse", S.PlannerResponse], ["planWrite", S.PlanWriteResult], ["execReport", S.ExecReport], ["questionList", S.QuestionList], ["questionListResponse", S.QuestionListResponse], ["planReply", S.PlanWrite], ["planResponse", S.PlanResponse], ["questionContext", S.QuestionContext], ["termsWrite", S.TermsWrite], ["termsResponse", S.TermsResponse]] as const) {
    assert.ok(protoSchemas[name] !== undefined, `the prototype does not send ${name}`);
    assert.deepEqual(protoRaw(protoSchemas[name]), rawJsonSchema(schema), name);
  }
});

// Issue #6 (Q1): the plan's reply schemas generate a closed object root; the plan write's is not recursive, so its
// strict variant exists too.
test("the plan's agent schemas are total and closed", () => {
  for (const schema of [S.PlanWrite, S.PlanResponse]) {
    const json = agentJsonSchema(schema);
    assert.equal(json.type, "object");
    assert.equal(json.additionalProperties, false);
    strict(rawJsonSchema(schema));
  }
});

// Issue #6 (Q1): the files of the plan's schemas in prototypes/proto-schema-output/ are what the program sends; they
// are unproven until the developer's run of prototypes/proto-schema.ts (CLAUDE.md, "Not yet known").
test("the plan's schema files in prototypes/proto-schema-output/ are what the program sends", () => {
  for (const [name, schema] of [["planReply", S.PlanWrite], ["planResponse", S.PlanResponse], ["questionContext", S.QuestionContext], ["termsWrite", S.TermsWrite], ["termsResponse", S.TermsResponse]] as const) {
    assert.deepEqual(rawJsonSchema(schema), proven(name, "raw"), `${name} raw`);
    assert.deepEqual(strict(rawJsonSchema(schema)), proven(name, "strict"), `${name} strict`);
  }
});
