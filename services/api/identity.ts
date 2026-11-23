// These are SPIFFE IDs from verified client certificates, not user-supplied names.
// Their values must match the tenantId labels written into the ingestion index.
export const tenantByCallerId: Readonly<Record<string, string>> = {
  "spiffe://evaluated-rag.local/tenant/voltframe/client": "voltframe",
  "spiffe://evaluated-rag.local/tenant/driftwood-daughters/client":
    "driftwood-daughters",
};

// The API presents its own SVID to the retriever; clients verify the API ID.
export const apiId = "spiffe://evaluated-rag.local/service/api";
// The API accepts only this retriever identity on its outbound mTLS connection.
export const retrieverId = "spiffe://evaluated-rag.local/service/retriever";

// Node reports SANs as text such as "URI:spiffe://...".
// Reject additional SAN entries instead of searching for a matching substring.
export function spiffeIdFromSan(san: string | undefined): string | null {
  if (!san || !san.startsWith("URI:spiffe://") || san.includes(",")) return null;
  // Remove Node's "URI:" prefix while preserving the full SPIFFE ID.
  return san.slice(4);
}

// Unknown or missing identities never map to a tenant.
export function tenantForCaller(san: string | undefined): string | null {
  const id = spiffeIdFromSan(san);
  // A question or JSON field has no role in this authorization decision.
  return id ? tenantByCallerId[id] ?? null : null;
}
