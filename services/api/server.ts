/*
Accept a question from an mTLS-authenticated demo caller, derive its tenant
from the caller's SPIFFE ID, and call the retriever as the API workload.
Only authorized retrieval text is passed to Bedrock; no match abstains.
*/

import { createServer, request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { SpiffeClient } from "@jeengbe/spiffe";
import { answerQuestion, type Passage } from "./answer.js";
import { apiId, retrieverId, spiffeIdFromSan, tenantForCaller } from "./identity.js";
import { generateAnswer } from "./model.js";
import {
  watchX509TlsMaterial,
  type X509TlsMaterial,
} from "../shared/spiffe-x509.js";

const maxBodyBytes = 16 * 1024;
if (!process.env.RAG_RUNTIME_ROLE_ARN) {
  throw new Error("RAG_RUNTIME_ROLE_ARN must be set for the API service");
}
const retrieverUrl = new URL(
  process.env.RETRIEVER_URL ?? "https://retriever:8443/retrieve"
);
if (retrieverUrl.protocol !== "https:") throw new Error("Retriever must use HTTPS");

function isPassage(value: unknown): value is Passage {
  if (!value || typeof value !== "object") return false;
  const passage = value as Record<string, unknown>;
  return (
    typeof passage.tenantId === "string" &&
    typeof passage.documentId === "string" &&
    typeof passage.source === "string" &&
    typeof passage.text === "string"
  );
}

// Use the current SPIRE-issued API key and certificate for every outbound call.
function retrieveFromService(
  material: X509TlsMaterial,
  question: string,
  tenantId: string
): Promise<Passage | null> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ question, tenantId });
    const request = httpsRequest(
      retrieverUrl,
      {
        method: "POST",
        cert: material.cert,
        key: material.key,
        ca: material.ca,
        rejectUnauthorized: true,
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
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > 64 * 1024) throw new Error("Retriever response too large");
            chunks.push(bytes);
          }
          if (response.statusCode !== 200) throw new Error("Retriever failed");
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!parsed || typeof parsed !== "object" || !("passage" in parsed)) {
            throw new Error("Invalid retriever response");
          }
          if (parsed.passage !== null && !isPassage(parsed.passage)) {
            throw new Error("Invalid retriever passage");
          }
          resolve(parsed.passage);
        } catch (error) {
          reject(error);
        }
      }
    );
    request.setTimeout(20_000, () => request.destroy(new Error("Retriever timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

const spiffe = new SpiffeClient();
if ((await spiffe.getSpiffeId()) !== apiId) {
  throw new Error("API did not receive its registered SPIFFE identity");
}

const updates = watchX509TlsMaterial(spiffe, apiId);
const initial = await updates.next();
if (initial.done) throw new Error("SPIRE did not provide API TLS material");
let currentMaterial = initial.value;

const server = createServer(
  { ...currentMaterial, requestCert: true, rejectUnauthorized: true },
  async (request, response) => {
    const peer = request.socket as TLSSocket;
    const callerId = spiffeIdFromSan(peer.getPeerCertificate().subjectaltname);
    const tenantId = peer.authorized ? tenantForCaller(peer.getPeerCertificate().subjectaltname) : null;
    if (!tenantId || !callerId) {
      response.writeHead(403).end("Caller identity not authorized\n");
      return;
    }
    if (request.method !== "POST" || request.url !== "/ask") {
      response.writeHead(404).end();
      return;
    }

    try {
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

      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        response.writeHead(400).end("Invalid JSON\n");
        return;
      }
      // A tenant supplied by a caller is rejected even if it matches its SVID.
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

      const result = await answerQuestion(
        input.question,
        tenantId,
        (question, tenant) => retrieveFromService(currentMaterial, question, tenant),
        generateAnswer
      );
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

void (async () => {
  for await (const material of updates) {
    currentMaterial = material;
    server.setSecureContext(material);
  }
  throw new Error("SPIRE closed the API identity stream");
})().catch(() => {
  console.error("API identity updates stopped");
  server.close();
  process.exitCode = 1;
});

server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
  console.log(`API listening as ${apiId}`);
});
