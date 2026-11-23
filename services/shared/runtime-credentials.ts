// The SDK provider assumes the configured IAM role and refreshes short-lived credentials.
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";

// Keep local ingestion/smoke checks usable with the normal AWS profile.
// Deployed application services require RAG_RUNTIME_ROLE_ARN at startup.
export function runtimeCredentials() {
  // Compose injects this ARN after the foundation's reviewed apply.
  const roleArn = process.env.RAG_RUNTIME_ROLE_ARN;
  // When present, use the local AWS profile only as the source for AssumeRole.
  return roleArn
    ? {
        credentials: fromTemporaryCredentials({
          // Bedrock access is restricted to the module's configured model ARNs.
          params: { RoleArn: roleArn, RoleSessionName: "rag-service" },
          clientConfig: { region: process.env.AWS_REGION ?? "us-east-1" },
        }),
      }
    // Ingestion and local smoke checks may use the usual SDK credential chain.
    : {};
}
