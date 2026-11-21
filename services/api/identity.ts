// Map only registered caller identities to the labels used by the index.
export const tenantByCallerId: Readonly<Record<string, string>> = {
  "spiffe://evaluated-rag.local/tenant/voltframe/client": "voltframe",
  "spiffe://evaluated-rag.local/tenant/driftwood-daughters/client":
    "driftwood-daughters",
};

export const apiId = "spiffe://evaluated-rag.local/service/api";
export const retrieverId = "spiffe://evaluated-rag.local/service/retriever";

// Require one exact URI SAN, rather than accepting a substring or a claimed header.
export function spiffeIdFromSan(san: string | undefined): string | null {
  if (!san || !san.startsWith("URI:spiffe://") || san.includes(",")) return null;
  return san.slice(4);
}

export function tenantForCaller(san: string | undefined): string | null {
  const id = spiffeIdFromSan(san);
  return id ? tenantByCallerId[id] ?? null : null;
}
