import assert from "node:assert/strict";
import test from "node:test";
import { makeDemoResults, observedResult } from "./metadata.js";

test("S3 evidence cannot include extra subprocess output or answer text", () => {
  const result = {
    name: "voltframe_exact_question", status: "pass" as const,
    tenantId: "voltframe", httpStatus: 200,
    documentId: "voltframe-returns-v1",
    question: "PRIVATE QUESTION", answer: "PRIVATE ANSWER", rawOutput: "PRIVATE PASSAGE",
  };
  const json = JSON.stringify(makeDemoResults([result], "2026-11-25T12:00:00.000Z"));
  for (const secret of ["PRIVATE QUESTION", "PRIVATE ANSWER", "PRIVATE PASSAGE"]) {
    assert.equal(json.includes(secret), false);
  }
  assert.equal(JSON.parse(json).checks[0].documentId, "voltframe-returns-v1");
});

test("smoke-output parser ignores raw text and rejects arbitrary document IDs", () => {
  const output = 'Sensitive answer text\nSANITIZED_DEMO_RESULT={"httpStatus":200,"documentId":"INJECTED TEXT","answer":"PRIVATE ANSWER"}\n';
  assert.deepEqual(observedResult(output), { httpStatus: 200, documentId: null });
  assert.equal(observedResult("Sensitive answer text only"), null);
});
