// Build the exact fields allowed in the uploaded demo-results object.
// Keep all request text and subprocess output outside this data boundary.
export type CheckResult = {
  name: string;
  status: "pass" | "fail";
  tenantId: string | null;
  httpStatus: number | null;
  documentId: string | null;
};

const marker = "SANITIZED_DEMO_RESULT=";
const knownNames = new Set([
  "voltframe_exact_question",
  "driftwood_cross_tenant_question",
  "unauthorized_caller",
  "client_supplied_tenant_rejected",
]);

// Accept only bounded status and known document IDs from smoke-client output.
// Other output, including error bodies, never becomes evidence metadata.
export function observedResult(output: string): { httpStatus: number; documentId: string | null } | null {
  const line = output.split(/\r?\n/).find((part) => part.startsWith(marker));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(marker.length));
    if (!parsed || typeof parsed !== "object" || !("httpStatus" in parsed) ||
      !Number.isInteger(parsed.httpStatus) || Number(parsed.httpStatus) < 100 ||
      Number(parsed.httpStatus) > 599 || !("documentId" in parsed)) return null;
    const documentId = parsed.documentId === "voltframe-returns-v1" ||
      parsed.documentId === "driftwood-returns-v1" ? parsed.documentId : null;
    return { httpStatus: Number(parsed.httpStatus), documentId };
  } catch {
    return null;
  }
}

// Copy each field explicitly, even if a future caller attaches raw output.
// These checks verify transport and citation metadata, not the answer's policy wording.
export function makeDemoResults(results: CheckResult[], recordedAt: string) {
  if (results.some((result) => !knownNames.has(result.name))) {
    throw new Error("Unknown demo check name");
  }
  return {
    schemaVersion: 1,
    recordedAt,
    scope: "four live smoke checks; answer wording not graded",
    checks: results.map((result) => ({
      name: result.name,
      status: result.status,
      tenantId: result.tenantId === "voltframe" ||
        result.tenantId === "driftwood-daughters" ? result.tenantId : null,
      httpStatus: result.httpStatus !== null && Number.isInteger(result.httpStatus) &&
        result.httpStatus >= 100 && result.httpStatus <= 599 ? result.httpStatus : null,
      documentId: result.documentId === "voltframe-returns-v1" ||
        result.documentId === "driftwood-returns-v1" ? result.documentId : null,
    })),
  };
}
