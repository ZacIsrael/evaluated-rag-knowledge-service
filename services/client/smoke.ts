/* Send a real mTLS request as one of the registered demo tenant workloads. */
import { request as httpsRequest } from "node:https";
import { SpiffeClient } from "@jeengbe/spiffe";
import { spiffeIdFromSan, apiId } from "../api/identity.js";
import { watchX509TlsMaterial } from "../shared/spiffe-x509.js";

const expectedId = process.env.EXPECTED_CALLER_ID;
if (!expectedId) throw new Error("EXPECTED_CALLER_ID is required");
const spiffe = new SpiffeClient();
if ((await spiffe.getSpiffeId()) !== expectedId) {
  throw new Error("Demo caller received an unexpected SPIFFE identity");
}
const updates = watchX509TlsMaterial(spiffe, expectedId);
const current = await updates.next();
if (current.done) throw new Error("Demo caller has no X.509-SVID");

const body = JSON.stringify({
  question: process.env.QUESTION ?? "What is the return policy?",
  ...(process.env.SPOOF_TENANT_ID
    ? { tenantId: process.env.SPOOF_TENANT_ID }
    : {}),
});

const result = await new Promise<{ status: number; body: string }>(
  (resolve, reject) => {
    const request = httpsRequest(
      "https://api:8080/ask",
      {
        method: "POST",
        ...current.value,
        rejectUnauthorized: true,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        checkServerIdentity: (_host, certificate) =>
          spiffeIdFromSan(certificate.subjectaltname) === apiId
            ? undefined
            : new Error("Unexpected API SPIFFE identity"),
      },
      async (response) => {
        try {
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
    request.setTimeout(30_000, () => request.destroy(new Error("API timed out")));
    request.on("error", reject);
    request.end(body);
  }
);

const expectedStatus = Number(process.env.EXPECTED_STATUS ?? 200);
if (result.status !== expectedStatus) {
  throw new Error(`Expected HTTP ${expectedStatus}, received ${result.status}: ${result.body}`);
}
if (result.status === 200) {
  const parsed: unknown = JSON.parse(result.body);
  if (!parsed || typeof parsed !== "object" || !("citation" in parsed) || !("abstained" in parsed)) {
    throw new Error("API returned an invalid answer");
  }
  if (process.env.EXPECTED_DOCUMENT_ID) {
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
  const serialized = JSON.stringify(parsed);
  if (process.env.FORBIDDEN_DOCUMENT_ID && serialized.includes(process.env.FORBIDDEN_DOCUMENT_ID)) {
    throw new Error("Response contains another tenant's document ID");
  }
}

// This demo corpus is fictional; display the result to check citation support.
console.log(`${expectedId}: HTTP ${result.status} ${result.body}`);
