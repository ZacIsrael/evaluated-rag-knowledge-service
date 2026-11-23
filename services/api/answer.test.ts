// Run fast policy checks without contacting AWS, Docker, or SPIRE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion, type Passage } from "./answer.js";
import { tenantForCaller, spiffeIdFromSan } from "./identity.js";

// A representative authorized result lets tests inspect the context boundary.
const voltframe: Passage = {
  tenantId: "voltframe",
  documentId: "voltframe-returns-v1",
  source: "voltframe-returns.md — Order and return policy",
  text: "Ordinary sales are final.",
};

// Positive IDs map to tenants; service and malformed identities must not.
test("only exact registered client SPIFFE IDs map to tenants", () => {
  assert.equal(
    tenantForCaller("URI:spiffe://evaluated-rag.local/tenant/voltframe/client"),
    "voltframe"
  );
  assert.equal(
    tenantForCaller("URI:spiffe://evaluated-rag.local/tenant/driftwood-daughters/client"),
    "driftwood-daughters"
  );
  assert.equal(tenantForCaller("URI:spiffe://evaluated-rag.local/service/retriever"), null);
  assert.equal(tenantForCaller("URI:spiffe://untrusted.local/tenant/voltframe/client"), null);
  assert.equal(spiffeIdFromSan("URI:spiffe://evaluated-rag.local/tenant/voltframe/client, DNS:evil"), null);
  assert.equal(tenantForCaller(undefined), null);
});

// Prove an empty retrieval result does not trigger any model call.
test("no match abstains without invoking generation", async () => {
  let generated = false;
  const answer = await answerQuestion(
    "unknown question",
    "voltframe",
    async (_question, tenant) => {
      assert.equal(tenant, "voltframe");
      return null;
    },
    async () => {
      generated = true;
      return "invented answer";
    }
  );
  assert.equal(answer.abstained, true);
  assert.equal(answer.citation, null);
  assert.equal(generated, false);
});

// Defense in depth: reject a mislabeled retriever result before generation.
test("cross-tenant retriever result fails before generation", async () => {
  let generated = false;
  await assert.rejects(
    answerQuestion(
      "Voltframe policy?",
      "driftwood-daughters",
      async () => voltframe,
      async () => {
        generated = true;
        return "forbidden";
      }
    ),
    /tenant mismatch/
  );
  assert.equal(generated, false);
});

// The model sees only this passage; citation metadata comes from the index.
test("authorized result passes only one passage and uses indexed citation", async () => {
  const answer = await answerQuestion(
    "Voltframe policy?",
    "voltframe",
    async () => voltframe,
    async (question, passage) => {
      assert.equal(question, "Voltframe policy?");
      assert.deepEqual(passage, voltframe);
      return "Ordinary sales are final.";
    }
  );
  assert.deepEqual(answer, {
    abstained: false,
    answer: "Ordinary sales are final.",
    citation: { documentId: voltframe.documentId, source: voltframe.source },
  });
});

// A model decline should not pretend that the source supported an answer.
test("model abstention has no citation", async () => {
  const answer = await answerQuestion(
    "unsupported",
    "voltframe",
    async () => voltframe,
    async () => null
  );
  assert.equal(answer.abstained, true);
  assert.equal(answer.citation, null);
});
