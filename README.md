# Evaluated RAG Knowledge Service

Small, local two-tenant demonstration: two labeled fictional runbooks are embedded with Titan Text Embeddings V2; a SPIRE-authenticated client asks the API; the API derives its tenant from the client's X.509-SVID, queries the retriever over mTLS, and passes only the authorized passage to Nova Micro. The API attaches the index's source reference, or abstains without generation when retrieval finds no match.

This is a **local demonstration**, not a production identity system. Docker labels are usable by anyone with access to the local Docker daemon; do not expose that socket or treat these registrations as strong tenant authentication on an untrusted host. The two-passage index and provisional similarity cutoff are not a measured retrieval benchmark.

## Prerequisites and ordered setup

Use Node `22.23.1`, Terraform `1.16.7`, Terragrunt `1.2.1`, Docker Compose, AWS CLI credentials with access to Bedrock in `us-east-1`, and the two model IDs configured in `live/dev/foundation/terragrunt.hcl`. Run shell commands from the repository root unless a `cd` is shown. Commands that call AWS or Bedrock may incur charges.

1. Install dependencies and check source code:

   ```bash
   npm ci
   npm test
   npm run typecheck
   ```

2. Create the state bucket once from `live/bootstrap/`. Review its plan before apply; its local state belongs in ignored `live/.state/bootstrap/`, outside `.terragrunt-cache/`.

   ```bash
   cd live/bootstrap
   terragrunt hcl validate
   terragrunt run plan
   terragrunt run apply
   terragrunt run output -raw tf_state_bucket_name
   cd ../..
   ```

3. Copy `.env.example` to `.env`. Put the **bucket name** from the previous output in `TF_STATE_BUCKET`, not its ARN. Get the ARN of the bucket's intended AWS-managed S3 KMS key in `us-east-1` using `aws kms describe-key --key-id alias/aws/s3 --region us-east-1 --query KeyMetadata.Arn --output text`, then put it in `TF_STATE_KMS_KEY_ARN`. Set `RUNTIME_PRINCIPAL_ARN` to the actual IAM principal authorized to assume the runtime role. Run `.github/workflows/inspect-oidc.yml` manually on the intended GitHub ref and use its exact printed `sub` claim for `REPOSITORY_SUBJECT`; its audience must be `sts.amazonaws.com`. Reload `.env` in every new terminal before running Terragrunt or Compose:

   ```bash
   set -a
   source .env
   set +a
   aws sts get-caller-identity
   ```

4. Validate the dev foundation from **`live/dev/foundation/`**, review the actual S3 backend key `dev/foundation/terraform.tfstate`, `.tflock`, KMS key, IAM/OIDC permissions, resources, and cost, then apply. Capture a fresh no-change plan after apply. Set `RAG_RUNTIME_ROLE_ARN` in `.env` to the `rag_runtime_role_arn` output and reload `.env`.

   ```bash
   cd live/dev/foundation
   terragrunt hcl validate
   terragrunt run validate
   terragrunt run plan
   terragrunt run apply
   terragrunt run output -raw rag_runtime_role_arn
   terragrunt run plan
   cd ../../..
   ```

5. Run the ingestion job from the root so its corpus paths resolve. The ignored `jobs/ingest/.local-index/index.json` contains document text and vectors; keep it local. Its Bedrock call uses the selected local AWS profile.

   ```bash
   npx tsx jobs/ingest/ingest.ts
   npm test
   ```

6. Start SPIRE. On a **fresh** installation, start the server, export its trust bundle to ignored `spire/agent/bootstrap.pem`, and generate a one-time join token. Copy only the token value from the command's output into the hidden `read` prompt below; the file is ignored by Git. The existing SPIRE configuration and persistent Compose volumes keep registrations across restarts. If the agent is already healthy, skip token generation.

   ```bash
   docker compose up -d --wait spire-server
   docker compose exec -T spire-server /opt/spire/bin/spire-server bundle show -format pem > spire/agent/bootstrap.pem
   docker compose exec -T spire-server /opt/spire/bin/spire-server token generate
   printf 'Paste the one-time token: '; read -rs JOIN_TOKEN; printf '\n'
   (umask 077; printf '%s' "$JOIN_TOKEN" > spire/agent/join-token)
   unset JOIN_TOKEN
   chmod 600 spire/agent/join-token
   docker compose up -d --wait spire-agent
   docker compose exec -T spire-server /opt/spire/bin/spire-server agent list
   ```

7. Register **four distinct workload identities** beneath the agent SPIFFE ID printed by `agent list` (the API, retriever, and both demo tenant callers). Existing registrations do not need to be created again. Set `AGENT_SPIFFE_ID` to the exact ID shown by `agent list`, then run these commands once. Verify with the identity probes before starting the app:

   | Identity | Docker selector |
   | --- | --- |
   | `spiffe://evaluated-rag.local/service/api` | `docker:label:org.example.workload:rag-api` |
   | `spiffe://evaluated-rag.local/service/retriever` | `docker:label:org.example.workload:rag-retriever` |
   | `spiffe://evaluated-rag.local/tenant/voltframe/client` | `docker:label:org.example.workload:rag-caller-voltframe` |
   | `spiffe://evaluated-rag.local/tenant/driftwood-daughters/client` | `docker:label:org.example.workload:rag-caller-driftwood-daughters` |

   ```bash
   AGENT_SPIFFE_ID='spiffe://evaluated-rag.local/spire/agent/REPLACE_WITH_ACTUAL_ID'
   docker compose exec -T spire-server /opt/spire/bin/spire-server entry create -parentID "$AGENT_SPIFFE_ID" -spiffeID spiffe://evaluated-rag.local/service/api -selector docker:label:org.example.workload:rag-api
   docker compose exec -T spire-server /opt/spire/bin/spire-server entry create -parentID "$AGENT_SPIFFE_ID" -spiffeID spiffe://evaluated-rag.local/service/retriever -selector docker:label:org.example.workload:rag-retriever
   docker compose exec -T spire-server /opt/spire/bin/spire-server entry create -parentID "$AGENT_SPIFFE_ID" -spiffeID spiffe://evaluated-rag.local/tenant/voltframe/client -selector docker:label:org.example.workload:rag-caller-voltframe
   docker compose exec -T spire-server /opt/spire/bin/spire-server entry create -parentID "$AGENT_SPIFFE_ID" -spiffeID spiffe://evaluated-rag.local/tenant/driftwood-daughters/client -selector docker:label:org.example.workload:rag-caller-driftwood-daughters
   docker compose --profile identity-check run --rm api-identity-probe
   docker compose --profile identity-check run --rm retriever-identity-probe
   docker compose --profile identity-check run --rm voltframe-caller-identity-probe
   docker compose --profile identity-check run --rm driftwood-caller-identity-probe
   # Expected to return no SVID because its Docker label is not registered:
   docker compose --profile identity-check run --rm unregistered-identity-probe
   ```

8. Start the API and retriever with the runtime role ARN exported from `.env`. The local AWS profile is used **only to assume that role**; both runtime Bedrock calls use its scoped temporary credentials. The API is not published on a host port. Run the actual client requests from Compose:

   ```bash
   docker compose config --quiet
   docker compose --profile api up -d --build api
   docker compose --profile api --profile smoke run --rm voltframe-client
   docker compose --profile api --profile smoke run --rm driftwood-client
   docker compose --profile api --profile smoke run --rm unauthorized-client
   docker compose --profile api --profile smoke run --rm -e SPOOF_TENANT_ID=driftwood-daughters -e EXPECTED_STATUS=400 voltframe-client
   ```

   Both authorized responses should contain their own document ID and source. The Driftwood question mentions Voltframe but must never receive the Voltframe passage. The `unauthorized-client` has a trusted **retriever** identity but must receive HTTP 403. A request with a tenant ID in its body must receive HTTP 400. Confirm your model's actual answers against `eval/demo-test-plan.md` before marking the end-to-end cases passed.

## Evidence and limits

Record actual outcomes in `eval/results-template.md`. Save only sanitized metadata, response summaries, account-independent resource names, and timings in Git; leave raw prompts, responses, AWS account details, state, keys, SPIRE tokens, and the generated index out of commits. Run negative identity, selector failure, SVID rotation/reload, AWS state/lock/KMS inspection, and a no-change plan only when you can observe and record their results. The present corpus has one passage per tenant, so Recall@5 and a two-configuration retrieval comparison are **unrun**, not passing metrics.

The response citation is taken from the authorized indexed passage, not written by the model. A prompt instructs Nova to stay within that passage, but human review of the answer is still necessary to judge factual support. No measured cost, latency, or restoration result is claimed by this repository until it is recorded from an actual run.
