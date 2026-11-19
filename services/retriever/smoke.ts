import assert from "node:assert/strict";
import { retrieve } from "./retrieve.js";

// A Voltframe question should retrieve its labeled passage and source.
const voltframe = await retrieve(
  "What is Voltframe's return policy?",
  "voltframe"
);
assert.equal(voltframe?.tenantId, "voltframe");
assert.equal(voltframe?.documentId, "voltframe-returns-v1");
assert.ok(voltframe.source.includes("Order and return policy"));

// Confirm Driftwood tenant can retrieve its own passage.
const driftwood = await retrieve(
  "What is Driftwood Daughters' return policy?",
  "driftwood-daughters"
);
assert.equal(driftwood?.tenantId, "driftwood-daughters");
assert.equal(driftwood?.documentId, "driftwood-returns-v1");

// A different question about the same policy should still find Voltframe's passage.
const damagedOrder = await retrieve(
  "What happens if my Voltframe order arrives damaged?",
  "voltframe"
);
assert.equal(damagedOrder?.tenantId, "voltframe");

// A tenant with no indexed passages has nothing it can retrieve.
const noTenant = await retrieve(
  "What is Voltframe's return policy?",
  "unknown-tenant"
);
assert.equal(noTenant, null);

// Asking about Voltframe while scoped to Driftwood must never return
// Voltframe's passage. A Driftwood passage or no match is acceptable here.
const crossTenant = await retrieve(
  "What is Voltframe's return policy?",
  "driftwood-daughters"
);
assert.ok(
  crossTenant === null || crossTenant.tenantId === "driftwood-daughters"
);

// Unrelated questions should fall below the current similarity threshold.
assert.equal(
  await retrieve("How do I reset my Wi-Fi router?", "voltframe"),
  null
);
assert.equal(
  await retrieve("What is the weather tomorrow?", "voltframe"),
  null
);

console.log("Retriever smoke checks passed");
