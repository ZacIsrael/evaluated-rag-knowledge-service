# Tenant-isolation demo test plan

These are **planned test cases**, not results. Run them after the API, retriever, tenant authentication, and model call are implemented. The tenant shown below must come from verified request identity, not from the wording of the question.

## Test 1 — Authorized VOLTFRAME answer with a citation

**Authenticated tenant:** `voltframe`  
**Question:** “I purchased two shirts from VOLTFRAME two weeks ago, but I'm not satisfied with the material and want to send them back. How can I do so?”

**Expected behavior:**

1. Retrieval returns the VOLTFRAME return-policy passage (`voltframe-returns-v1`) and no Driftwood & Daughters passage.
2. The model receives only passages authorized for `voltframe`.
3. The answer explains that dissatisfaction with the material is a preference and does not qualify for a return under VOLTFRAME's ordinary all-sales-final policy. It cites `voltframe-returns-v1` (the runbook, rather than the vector store). It should not imply that the damaged-or-wrong-item exception applies to this question.

**Evidence to record later:** authenticated tenant, retrieved document IDs, document IDs and text supplied to the model, answer, and citation. Sanitize logs before committing them.

## Test 2 — Driftwood caller asks about both companies

**Authenticated tenant:** `driftwood-daughters`  
**Question:** “I purchased shirts and pants from both Driftwood & Daughters and VOLTFRAME a few weeks ago. I'm not satisfied with any of the items, so I'm going to return everything tomorrow. What are my options?”

**Expected behavior:**

1. Retrieval returns only passages authorized for `driftwood-daughters`, including `driftwood-returns-v1`; `voltframe-returns-v1` is absent from retrieval results and model context.
2. The answer may explain Driftwood's return policy with a citation to `driftwood-returns-v1`, including that refund type depends on verification of the original purchase.
3. The answer does **not** state VOLTFRAME's policy, quote its passage, or infer its rules from the company name. It says it cannot determine VOLTFRAME's policy from the sources available to this caller.

**Evidence to record later:** authenticated tenant, requested company names, retrieved document IDs, document IDs and text supplied to the model, answer, and citations. Verify that no VOLTFRAME passage appeared at any retrieval-to-model step.

**Implementation-neutral check:** If each tenant has a separate knowledge base or vector index, the request must not query VOLTFRAME's store. If tenants share an index, the verified Driftwood tenant must restrict retrieval so that no VOLTFRAME passage is returned. In either design, the forbidden text must never reach the model.
