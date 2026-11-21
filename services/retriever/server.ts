/*
Serve tenant-scoped retrieval over SPIRE-backed mTLS.
Only the registered API workload may call this service. The API must obtain
the tenant ID from verified caller identity before making a request.
*/

// Serve retrieval requests over HTTPS with client certificate authentication.
import { createServer } from "node:https";
import type { TLSSocket } from "node:tls";

// Request this container's workload identity from the SPIRE agent.
import { SpiffeClient } from "@jeengbe/spiffe";

// Reuse the existing tenant-filtered retrieval logic and convert SPIRE's
// identity material into the certificate format expected by Node TLS.
import { retrieve } from "./retrieve.js";
import { watchX509TlsMaterial } from "../shared/spiffe-x509.js";

// These IDs must match the workload registrations in the SPIRE server.
// The retriever presents its own ID and accepts calls only from the API ID.
const trustDomain = "evaluated-rag.local";
const retrieverId = `spiffe://${trustDomain}/service/retriever`;
const allowedApiId = `spiffe://${trustDomain}/service/api`;

// Reject oversized request bodies before parsing their JSON content.
const maxBodyBytes = 16 * 1024;
if (!process.env.RAG_RUNTIME_ROLE_ARN) {
  throw new Error("RAG_RUNTIME_ROLE_ARN must be set for the retriever service");
}

// Connect to the SPIRE Workload API through the socket mounted by Compose.
const spiffe = new SpiffeClient();

// Fail at startup if this container received a different workload identity.
// A label or configuration mistake must not silently start the service.
if ((await spiffe.getSpiffeId()) !== retrieverId) {
  throw new Error("Retriever did not receive its registered SPIFFE identity");
}

// Subscribe to the retriever's current X.509-SVID and future rotations.
const updates = watchX509TlsMaterial(spiffe, retrieverId);

// The HTTPS server needs its first certificate, key, and trust bundle
// before it can accept a connection.
const initial = await updates.next();

if (initial.done) {
  throw new Error("SPIRE did not provide retriever TLS material");
}

const server = createServer(
  {
    ...initial.value,
    requestCert: true,
    rejectUnauthorized: true,
  },
  async (request, response) => {
    // Trusting the certificate chain is not enough: require the API's
    // specific SPIFFE ID in the peer certificate's URI SAN.
    const socket = request.socket as TLSSocket;
    const peer = socket.getPeerCertificate();

    // A trusted certificate chain proves the peer belongs to the trust domain.
    // Require the API's exact SPIFFE ID as well; another registered workload
    // must not be allowed to call the retriever.
    if (!socket.authorized || peer.subjectaltname !== `URI:${allowedApiId}`) {
      response.writeHead(403).end("Caller identity not authorized\n");
      return;
    }

    // This handler exposes one operation. Reject other methods and paths
    // before reading a request body or calling Bedrock.
    if (request.method !== "POST" || request.url !== "/retrieve") {
      response.writeHead(404).end();
      return;
    }

    try {
      // Read the incoming body in chunks while tracking its byte size.
      // The limit prevents an oversized request from being fully buffered.
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

      // Network input has no trustworthy TypeScript type until its contents
      // have been parsed and checked at runtime.
      let input: unknown;

      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        // Malformed JSON is a client error, not a retrieval failure.
        response.writeHead(400).end("Invalid JSON\n");
        return;
      }

      // Require a nonempty question and tenant ID before calling retrieve().
      // The API is responsible for deriving tenantId from verified caller
      // identity; it must never forward a tenant ID supplied by an end user.
      if (
        typeof input !== "object" ||
        input === null ||
        !("question" in input) ||
        typeof input.question !== "string" ||
        !input.question.trim() ||
        !("tenantId" in input) ||
        typeof input.tenantId !== "string" ||
        !input.tenantId.trim()
      ) {
        response.writeHead(400).end("Expected question and tenantId\n");
        return;
      }

      // Only the API workload can connect. Its future handler must derive
      // tenantId from verified identity, never from the user's request body.
      // retrieve() filters by that tenant before embedding or ranking.
      const passage = await retrieve(input.question, input.tenantId);

      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(
          passage === null
            ? { passage: null }
            : {
                passage: {
                  tenantId: passage.tenantId,
                  documentId: passage.documentId,
                  source: passage.source,
                  text: passage.text,
                },
              }
        )
      );
    } catch {
      // Avoid logging questions, passage text, or SDK error details.
      console.error("Retriever request failed");
      response.writeHead(500).end("Retriever unavailable\n");
    }
  }
);

// Use newly issued credentials for subsequent TLS connections.
// Keep watching the same SPIRE stream after using its initial certificate.
// `void` makes clear this background task is intentionally not awaited.
void (async () => {
  for await (const material of updates) {
    // Apply each rotated certificate, key, and trust bundle to new
    // TLS handshakes without restarting the retriever.
    server.setSecureContext(material);
  }

  // An ended stream means the service can no longer receive identity updates.
  throw new Error("SPIRE closed the retriever identity stream");
})().catch((error: unknown) => {
  // Stop accepting new connections if identity updates fail.
  console.error("Retriever identity updates stopped:", error);
  server.close();
  process.exitCode = 1;
});

// Listen inside the container on the port exposed to the API by Compose.
// The HTTPS server still requires a valid client certificate and the API ID.
server.listen(8443, "0.0.0.0", () => {
  console.log(`Retriever listening as ${retrieverId}`);
});
