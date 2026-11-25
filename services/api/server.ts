// Authenticate demo callers, derive their tenant, and call the retriever over mTLS.
// Generate from one authorized passage or abstain without a model call.

// Node supplies HTTPS transport and the peer TLS certificate used for identity.
import { createServer, request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
// SPIRE streams the API workload's certificate, key, and trust bundle.
import { SpiffeClient } from "@jeengbe/spiffe";
// Separate policy, identity mapping, and model invocation from network handling.
import { answerQuestion, type Passage } from "./answer.js";
import { apiId, retrieverId, spiffeIdFromSan, tenantForCaller } from "./identity.js";
import { generateAnswer } from "./model.js";
import { createRequestAuditWriter } from "./request-audit.js";
import {
  watchX509TlsMaterial,
  type X509TlsMaterial,
} from "../shared/spiffe-x509.js";

// Cap untrusted request bodies before JSON parsing to avoid unbounded buffering.
const maxBodyBytes = 16 * 1024;
// Both Bedrock-using services must run with the reviewed scoped IAM role.
if (!process.env.RAG_RUNTIME_ROLE_ARN) {
  throw new Error("RAG_RUNTIME_ROLE_ARN must be set for the API service");
}
// The default hostname resolves only inside Compose's network.
const retrieverUrl = new URL(
  process.env.RETRIEVER_URL ?? "https://retriever:8443/retrieve"
);
// Never send a tenant label or retrieved document to plaintext HTTP.
if (retrieverUrl.protocol !== "https:") throw new Error("Retriever must use HTTPS");
// Require the Terraform-provisioned CloudWatch destination at startup.
const writeRequestAudit = createRequestAuditWriter();

// Parse the retriever's JSON as unknown until all citation and text fields are checked.
function isPassage(value: unknown): value is Passage {
  if (!value || typeof value !== "object") return false;
  // This assertion only permits field inspection; the checks below establish the type.
  const passage = value as Record<string, unknown>;
  return (
    typeof passage.tenantId === "string" &&
    typeof passage.documentId === "string" &&
    typeof passage.source === "string" &&
    typeof passage.text === "string"
  );
}

// Send the question and the caller's verified tenant to the retriever over
// a secure connection. Check the retriever's identity and response, then
// return its passage or null if it found no match.
function retrieveFromService(
  material: X509TlsMaterial,
  question: string,
  tenantId: string
): Promise<Passage | null> {
  return new Promise((resolve, reject) => {
    // The API supplies tenantId from the caller's SVID, never from its JSON body.
    const body = JSON.stringify({ question, tenantId });
    const request = httpsRequest(
      retrieverUrl,
      {
        method: "POST",
        // Present the API's own SVID and trust SPIRE's CA for the server chain.
        cert: material.cert,
        key: material.key,
        ca: material.ca,
        rejectUnauthorized: true,
        // Byte length is needed because UTF-8 characters can occupy multiple bytes.
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        // The SVID has a URI SAN, not a DNS SAN for the Compose hostname.
        // Node still verifies the CA chain before this identity check.
        checkServerIdentity: (_host, certificate) =>
          spiffeIdFromSan(certificate.subjectaltname) === retrieverId
            ? undefined
            : new Error("Unexpected retriever SPIFFE identity"),
      },
      async (response) => {
        try {
          // A retriever response is also network input: impose a separate size cap.
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > 64 * 1024) throw new Error("Retriever response too large");
            chunks.push(bytes);
          }
          // Do not treat retriever error bodies as passages or expose them to callers.
          if (response.statusCode !== 200) throw new Error("Retriever failed");
          // JSON.parse returns untrusted data; validate its envelope and payload.
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!parsed || typeof parsed !== "object" || !("passage" in parsed)) {
            throw new Error("Invalid retriever response");
          }
          if (parsed.passage !== null && !isPassage(parsed.passage)) {
            throw new Error("Invalid retriever passage");
          }
          // The answer layer will independently check the passage's tenant label.
          resolve(parsed.passage);
        } catch (error) {
          reject(error);
        }
      }
    );
    // Do not let an unresponsive retriever hold an API request indefinitely.
    request.setTimeout(20_000, () => request.destroy(new Error("Retriever timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

// Fail startup if this container did not receive the API's registered identity.
const spiffe = new SpiffeClient();
if ((await spiffe.getSpiffeId()) !== apiId) {
  throw new Error("API did not receive its registered SPIFFE identity");
}

// The first Workload API update is required before the TLS listener starts.
const updates = watchX509TlsMaterial(spiffe, apiId);
const initial = await updates.next();
if (initial.done) throw new Error("SPIRE did not provide API TLS material");
// Replace this reference when SPIRE rotates the API SVID.
let currentMaterial = initial.value;

// Require a SPIRE-trusted client certificate during the TLS handshake.
const server = createServer(
  { ...currentMaterial, requestCert: true, rejectUnauthorized: true },
  async (request, response) => {
    // Collect only approved metadata for one completed HTTP response.
    // The listener never receives the question, passage, or model output.
    const startedAt = performance.now();
    let auditTenant: string | null = null;
    let abstained = false;
    let documentId: string | null = null;
    response.once("finish", () => {
      // Audit delivery is best-effort after the HTTP response has finished.
      // A CloudWatch outage cannot change the response, but it is visible in Docker logs.
      void writeRequestAudit({
        tenantId: auditTenant,
        httpStatus: response.statusCode,
        abstained,
        documentId,
        durationMs: performance.now() - startedAt,
      }).catch(() => console.error("Request audit delivery failed"));
    });
    // TLS verification alone does not establish which tenant owns the caller.
    const peer = request.socket as TLSSocket;
    // Map the exact URI SAN to an approved tenant; unknown workloads get no tenant.
    const callerId = spiffeIdFromSan(peer.getPeerCertificate().subjectaltname);
    const tenantId = peer.authorized ? tenantForCaller(peer.getPeerCertificate().subjectaltname) : null;
    auditTenant = tenantId;
    if (!tenantId || !callerId) {
      response.writeHead(403).end("Caller identity not authorized\n");
      return;
    }
    // This API exposes exactly one route; unrelated paths never reach Bedrock.
    if (request.method !== "POST" || request.url !== "/ask") {
      response.writeHead(404).end();
      return;
    }

    try {
      // Read the body incrementally so an oversized payload is rejected early.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBodyBytes) {
          response.writeHead(413).end("Request too large\n");
          return;
        }
        chunks.push(bytes);
      }

      // A parsed request does not become trusted simply because it is valid JSON.
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        response.writeHead(400).end("Invalid JSON\n");
        return;
      }
      // Accept one nonempty, bounded question and reject any supplied tenantId.
      // A caller cannot override or confirm the tenant derived from its SVID.
      if (
        !input ||
        typeof input !== "object" ||
        "tenantId" in input ||
        !("question" in input) ||
        typeof input.question !== "string" ||
        !input.question.trim() ||
        input.question.length > 4096
      ) {
        response.writeHead(400).end("Expected a question only\n");
        return;
      }

      // Pass the verified tenant to retrieval; generation occurs only after its checks.
      const result = await answerQuestion(
        input.question,
        tenantId,
        (question, tenant) => retrieveFromService(currentMaterial, question, tenant),
        generateAnswer
      );
      // Citation metadata is from the authorized index, never the model's text.
      abstained = result.abstained;
      documentId = result.citation?.documentId ?? null;
      // Return the answer and index-derived citation, or an abstention with no citation.
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(result)
      );
    } catch {
      // Do not log question text, model output, or retrieved passage content.
      console.error("API request failed");
      response.writeHead(502).end("Answer unavailable\n");
    }
  }
);

// Refresh TLS for new connections when SPIRE rotates the certificate or CA.
void (async () => {
  for await (const material of updates) {
    currentMaterial = material;
    server.setSecureContext(material);
  }
  // Losing the identity stream is fatal: continuing would use stale material.
  throw new Error("SPIRE closed the API identity stream");
})().catch(() => {
  console.error("API identity updates stopped");
  server.close();
  process.exitCode = 1;
});

// Compose exposes this port only to containers on its internal network.
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
  console.log(`API listening as ${apiId}`);
});
