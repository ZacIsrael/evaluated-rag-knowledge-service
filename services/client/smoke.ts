// Exercise the real API boundary from a SPIRE-registered demo workload.
// Fail if the status or citation does not match the caller's expected tenant.
import { request as httpsRequest } from "node:https";
import { SpiffeClient } from "@jeengbe/spiffe";
import { spiffeIdFromSan, apiId } from "../api/identity.js";
import { watchX509TlsMaterial } from "../shared/spiffe-x509.js";

// Compose sets the identity expected from this container's workload label.
const expectedId = process.env.EXPECTED_CALLER_ID;
if (!expectedId) throw new Error("EXPECTED_CALLER_ID is required");
// Never proceed if SPIRE attested this container as a different workload.
const spiffe = new SpiffeClient();
if ((await spiffe.getSpiffeId()) !== expectedId) {
  throw new Error("Demo caller received an unexpected SPIFFE identity");
}
// Obtain a certificate, private key, and trust bundle for this one request.
const updates = watchX509TlsMaterial(spiffe, expectedId);
const current = await updates.next();
if (current.done) throw new Error("Demo caller has no X.509-SVID");
// This client makes one request, so stop watching for certificate rotations.
// Close the SPIFFE transport after copying the issued TLS material.
const tlsMaterial = current.value;
await updates.return(undefined);
await spiffe.close();

// Normally send only a question; SPOOF_TENANT_ID deliberately tests rejection.
const body = JSON.stringify({
  question: process.env.QUESTION ?? "What is the return policy?",
  ...(process.env.SPOOF_TENANT_ID
    ? { tenantId: process.env.SPOOF_TENANT_ID }
    : {}),
});

// Make a real network call instead of importing the API handler in-process.
const result = await new Promise<{ status: number; body: string }>(
  (resolve, reject) => {
    const request = httpsRequest(
      "https://api:8080/ask",
      {
        method: "POST",
        // Present the caller SVID and verify the server against SPIRE's CA.
        ...tlsMaterial,
        rejectUnauthorized: true,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        // The Compose DNS name is not the identity; require the API URI SAN.
        checkServerIdentity: (_host, certificate) =>
          spiffeIdFromSan(certificate.subjectaltname) === apiId
            ? undefined
            : new Error("Unexpected API SPIFFE identity"),
      },
      async (response) => {
        try {
          // Collect the response so the checks below can inspect its metadata.
          const chunks: Buffer[] = [];
          for await (const chunk of response) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        } catch (error) {
          reject(error);
        }
      }
    );
    // A hung API is a failed smoke check rather than an indefinite command.
    request.setTimeout(30_000, () =>
      request.destroy(new Error("API timed out"))
    );
    request.on("error", reject);
    request.end(body);
  }
);

if (process.env.SANITIZED_OUTPUT === "1") {
  // Emit status and a known citation before assertions so a failing check can
  // still report its observed HTTP status without saving a raw response.
  let documentId: string | null = null;
  try {
    const parsed: unknown = result.status === 200 ? JSON.parse(result.body) : null;
    const citation = parsed && typeof parsed === "object" && "citation" in parsed
      ? parsed.citation : null;
    if (citation && typeof citation === "object" && "documentId" in citation &&
      (citation.documentId === "voltframe-returns-v1" ||
        citation.documentId === "driftwood-returns-v1")) {
      documentId = citation.documentId;
    }
  } catch {
    // An invalid body is still handled by the normal smoke assertions below.
  }
  console.log(`SANITIZED_DEMO_RESULT=${JSON.stringify({
    httpStatus: result.status,
    documentId,
  })}`);
}

// Authorized callers expect 200; an unauthorized workload expects 403.
const expectedStatus = Number(process.env.EXPECTED_STATUS ?? 200);
if (result.status !== expectedStatus) {
  throw new Error(
    `Expected HTTP ${expectedStatus}, received ${result.status}: ${result.body}`
  );
}
if (result.status === 200) {
  // A successful transport status alone does not prove the answer is valid.
  const parsed: unknown = JSON.parse(result.body);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("citation" in parsed) ||
    !("abstained" in parsed)
  ) {
    throw new Error("API returned an invalid answer");
  }
  if (process.env.EXPECTED_DOCUMENT_ID) {
    // The positive case must cite this caller's indexed runbook, not abstain.
    const citation = parsed.citation;
    if (
      parsed.abstained !== false ||
      !citation ||
      typeof citation !== "object" ||
      !("documentId" in citation) ||
      citation.documentId !== process.env.EXPECTED_DOCUMENT_ID
    ) {
      throw new Error("API did not cite the expected tenant document");
    }
  }
  // Reject even a metadata leak of the other tenant's document ID.
  const serialized = JSON.stringify(parsed);
  if (
    process.env.FORBIDDEN_DOCUMENT_ID &&
    serialized.includes(process.env.FORBIDDEN_DOCUMENT_ID)
  ) {
    throw new Error("Response contains another tenant's document ID");
  }
}

if (process.env.SANITIZED_OUTPUT !== "1") {
  // The ordinary smoke run prints the fictional answer for human policy review.
  console.log(`${expectedId}: HTTP ${result.status} ${result.body}`);
}
