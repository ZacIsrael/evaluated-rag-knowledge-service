import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";

// Keep local ingestion/smoke checks usable with the normal AWS profile.
// Deployed application services require RAG_RUNTIME_ROLE_ARN at startup.
export function runtimeCredentials() {
  const roleArn = process.env.RAG_RUNTIME_ROLE_ARN;
  return roleArn
    ? {
        credentials: fromTemporaryCredentials({
          params: { RoleArn: roleArn, RoleSessionName: "rag-service" },
          clientConfig: { region: process.env.AWS_REGION ?? "us-east-1" },
        }),
      }
    : {};
}
