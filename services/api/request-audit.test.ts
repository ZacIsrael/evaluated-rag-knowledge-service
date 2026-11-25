// Test the metadata boundary without contacting CloudWatch or requiring AWS credentials.
// These checks ensure audit records contain no request text or other unexpected fields.
import assert from "node:assert/strict";
import test from "node:test";
import { makeRequestAuditEvent } from "./request-audit.js";

test("request audit emits only approved fields and the matching tenant document", () => {
  // Simulate a successful answer grounded in Voltframe's approved document.
  const event = makeRequestAuditEvent({
    tenantId: "voltframe",
    httpStatus: 200,
    abstained: false,
    documentId: "voltframe-returns-v1",
    durationMs: 12.7,
  });

  // Explicitly check the complete list of keys: a later code change must not
  // accidentally add a question, passage, model answer, or request body.
  assert.deepEqual(Object.keys(event), [
    "eventType",
    "timestamp",
    "tenantId",
    "outcome",
    "httpStatus",
    "documentId",
    "durationMs",
  ]);
  // The status, cited ID, and rounded timing must describe this actual outcome.
  assert.equal(event.outcome, "answered");
  assert.equal(event.documentId, "voltframe-returns-v1");
  assert.equal(event.durationMs, 13);
});

test("abstentions and denied requests have no document ID", () => {
  // Supply IDs deliberately, even though neither outcome may cite a source.
  // This checks that the audit builder discards misleading document metadata.
  const abstained = makeRequestAuditEvent({
    tenantId: "voltframe",
    httpStatus: 200,
    abstained: true,
    documentId: "voltframe-returns-v1",
    durationMs: 3,
  });
  const denied = makeRequestAuditEvent({
    tenantId: null,
    httpStatus: 403,
    abstained: false,
    documentId: "driftwood-returns-v1",
    durationMs: 4,
  });

  // Abstention has an authenticated tenant but no citation; a denied caller
  // has neither an authorized tenant nor a cited document.
  assert.equal(abstained.outcome, "abstained");
  assert.equal(abstained.documentId, null);
  assert.equal(denied.outcome, "unauthorized");
  assert.equal(denied.tenantId, null);
  assert.equal(denied.documentId, null);
});

test("untrusted or cross-tenant document IDs never enter audit output", () => {
  // A Driftwood document must not be attributed to a Voltframe request.
  const event = makeRequestAuditEvent({
    tenantId: "voltframe",
    httpStatus: 200,
    abstained: false,
    documentId: "driftwood-returns-v1",
    durationMs: 1,
  });
  assert.equal(event.documentId, null);

  // Unexpected strings are never treated as a verified tenant or known ID.
  const unexpected = makeRequestAuditEvent({
    tenantId: "attacker text",
    httpStatus: 400,
    abstained: false,
    documentId: "arbitrary text",
    durationMs: 1,
  });
  assert.equal(unexpected.tenantId, null);
  assert.equal(unexpected.documentId, null);
});
