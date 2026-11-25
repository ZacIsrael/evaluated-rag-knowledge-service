// CloudWatch receives deliberately small, structured request events.
// This module never accepts a question, passage, model answer, or request body.
import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { runtimeCredentials } from "../shared/runtime-credentials.js";

type RequestOutcome =
  | "answered"
  | "abstained"
  | "unauthorized"
  | "invalid_request"
  | "not_found"
  | "too_large"
  | "upstream_error";

export type RequestAuditEvent = {
  eventType: "rag.api.request";
  timestamp: string;
  tenantId: "voltframe" | "driftwood-daughters" | null;
  outcome: RequestOutcome;
  httpStatus: number;
  documentId: "voltframe-returns-v1" | "driftwood-returns-v1" | null;
  durationMs: number;
};

type RequestResult = {
  tenantId: string | null;
  httpStatus: number;
  abstained: boolean;
  documentId: string | null;
  durationMs: number;
};

// Use fixed metadata values, even if a future retriever supplies a bad ID.
// The tenant label must come from the verified caller's SPIFFE identity.
export function makeRequestAuditEvent(result: RequestResult): RequestAuditEvent {
  const tenantId =
    result.tenantId === "voltframe" || result.tenantId === "driftwood-daughters"
      ? result.tenantId
      : null;
  const outcome: RequestOutcome =
    result.httpStatus === 200
      ? result.abstained ? "abstained" : "answered"
      : result.httpStatus === 403 ? "unauthorized"
      : result.httpStatus === 404 ? "not_found"
      : result.httpStatus === 413 ? "too_large"
      : result.httpStatus === 400 ? "invalid_request"
      : "upstream_error";

  // Only a successful answer may carry one of this demo's known document IDs.
  // This prevents arbitrary upstream strings from entering the audit log.
  const documentId =
    outcome === "answered" && tenantId === "voltframe" &&
    result.documentId === "voltframe-returns-v1"
      ? "voltframe-returns-v1"
      : outcome === "answered" && tenantId === "driftwood-daughters" &&
        result.documentId === "driftwood-returns-v1"
        ? "driftwood-returns-v1"
        : null;

  return {
    eventType: "rag.api.request",
    timestamp: new Date().toISOString(),
    tenantId,
    outcome,
    httpStatus: result.httpStatus,
    documentId,
    durationMs: Math.max(0, Math.round(result.durationMs)),
  };
}

// Terraform creates the stream, so the API only needs PutLogEvents permission.
// Reuse the scoped runtime role already required by the API for Bedrock.
export function createRequestAuditWriter() {
  const logGroupName = process.env.RAG_LOG_GROUP_NAME;
  if (!logGroupName) throw new Error("RAG_LOG_GROUP_NAME is required for API audit logging");
  const client = new CloudWatchLogsClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...runtimeCredentials(),
  });

  return async (result: RequestResult): Promise<void> => {
    const event = makeRequestAuditEvent(result);
    await client.send(new PutLogEventsCommand({
      logGroupName,
      logStreamName: "rag",
      logEvents: [{ timestamp: Date.parse(event.timestamp), message: JSON.stringify(event) }],
    }));
  };
}
