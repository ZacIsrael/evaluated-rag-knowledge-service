// Run the four live Compose smoke checks and upload only their safe metadata.
// A passed smoke check proves status/citation assertions, not answer correctness.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { runtimeCredentials } from "../../services/shared/runtime-credentials.js";
import { makeDemoResults, observedResult, type CheckResult } from "./metadata.js";

const execFileAsync = promisify(execFile);

// Keep case names and document IDs fixed; never trust text from a subprocess.
// The two longer questions match eval/demo-test-plan.md exactly.
const checks = [
  {
    name: "voltframe_exact_question",
    service: "voltframe-client",
    tenantId: "voltframe",
    documentId: "voltframe-returns-v1",
    question: "I purchased two shirts from VOLTFRAME two weeks ago, but I'm not satisfied with the material and want to send them back. How can I do so?",
    expectedStatus: 200,
  },
  {
    name: "driftwood_cross_tenant_question",
    service: "driftwood-client",
    tenantId: "driftwood-daughters",
    documentId: "driftwood-returns-v1",
    question: "I purchased shirts and pants from both Driftwood & Daughters and VOLTFRAME a few weeks ago. I'm not satisfied with any of the items, so I'm going to return everything tomorrow. What are my options?",
    expectedStatus: 200,
  },
  {
    name: "unauthorized_caller",
    service: "unauthorized-client",
    tenantId: null,
    documentId: null,
    question: null,
    expectedStatus: 403,
  },
  {
    name: "client_supplied_tenant_rejected",
    service: "voltframe-client",
    tenantId: "voltframe",
    documentId: null,
    question: null,
    expectedStatus: 400,
  },
] as const;

async function runCheck(check: typeof checks[number]): Promise<CheckResult> {
  // Passing just the variable name keeps question text out of the process arguments.
  // Docker Compose passes these environment variables to the one-shot client.
  const args = ["compose", "--profile", "api", "--profile", "smoke", "run", "--rm",
    "-e", "SANITIZED_OUTPUT=1", "-e", "EXPECTED_STATUS"];
  if (check.question !== null) args.push("-e", "QUESTION");
  if (check.name === "client_supplied_tenant_rejected") args.push("-e", "SPOOF_TENANT_ID");
  args.push(check.service);

  try {
    // Capture Compose output without printing it: failures may contain response text.
    // A nonzero exit is recorded as fail, with no raw error copied to S3.
    const { stdout } = await execFileAsync("docker", args, {
      env: {
        ...process.env,
        SANITIZED_OUTPUT: "1",
        EXPECTED_STATUS: String(check.expectedStatus),
        ...(check.question !== null ? { QUESTION: check.question } : {}),
        ...(check.name === "client_supplied_tenant_rejected"
          ? { SPOOF_TENANT_ID: "driftwood-daughters" } : {}),
      },
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
    const observed = observedResult(stdout);
    if (!observed) throw new Error("Missing sanitized smoke result");
    if (observed.httpStatus !== check.expectedStatus ||
      observed.documentId !== check.documentId) {
      return { name: check.name, status: "fail", tenantId: check.tenantId,
        httpStatus: observed.httpStatus, documentId: observed.documentId };
    }
    return {
      name: check.name,
      status: "pass",
      tenantId: check.tenantId,
      httpStatus: check.expectedStatus,
      documentId: check.documentId,
    };
  } catch (error: unknown) {
    // If assertions failed, capture the safe marker and discard all error text.
    // Network failures without a response have no observed HTTP status.
    const output = error && typeof error === "object" && "stdout" in error &&
      typeof error.stdout === "string" ? error.stdout : "";
    const observed = observedResult(output);
    return { name: check.name, status: "fail", tenantId: check.tenantId,
      httpStatus: observed?.httpStatus ?? null,
      documentId: observed?.documentId ?? null };
  }
}

async function main(): Promise<void> {
  // Require the existing least-privilege runtime role and bucket output.
  // This avoids silently using broader local profile permissions to upload.
  const bucket = process.env.RAG_EVIDENCE_BUCKET;
  if (!bucket || !process.env.RAG_RUNTIME_ROLE_ARN) {
    throw new Error("RAG_EVIDENCE_BUCKET and RAG_RUNTIME_ROLE_ARN are required");
  }
  const region = process.env.AWS_REGION ?? "us-east-1";
  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = await runCheck(check);
    results.push(result);
    console.log(`${check.name}: ${result.status}`);
  }

  // Include only allow-listed outcomes and document IDs in the uploaded file.
  // Human review of answer wording and other demo-plan checks remain separate.
  const recordedAt = new Date().toISOString();
  const evidence = makeDemoResults(results, recordedAt);
  const key = `evaluations/demo-results-${recordedAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const client = new S3Client({ region, ...runtimeCredentials() });
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(evidence, null, 2),
    ContentType: "application/json",
  }));
  console.log(`Uploaded sanitized evidence to s3://${bucket}/${key}`);
  // Report an unsuccessful smoke check to the shell, even though it was recorded.
  if (results.some((result) => result.status === "fail")) process.exitCode = 1;
}

void main().catch(() => {
  // Do not print SDK exceptions: their context may contain account details.
  console.error("Demo evidence run or S3 upload failed; check local configuration");
  process.exitCode = 1;
});
