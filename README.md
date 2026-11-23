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

   For the unregistered probe, **no X.509-SVID is the passing outcome**. The
   command may report an error or exit nonzero because it cannot fetch an
   identity. Do not treat a failed fetch as a failed isolation check; inspect
   its output and confirm that it did not receive any SPIFFE ID.

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

## Resume and rehearse an existing installation

From the repository root, reload `.env` in **each new terminal**. Keep the
existing Compose volumes: they hold the SPIRE server's signing keys and
registrations and the agent's state. If the server and agent are already
healthy, **do not generate another join token or recreate the four workload
entries**. Bring up the existing services and check their health and agent ID:

```bash
set -a
source .env
set +a
docker compose up -d --wait spire-server spire-agent
docker compose exec -T spire-server /opt/spire/bin/spire-server agent list
docker compose --profile api up -d --build api
docker compose ps
```

If the agent is not healthy, inspect `docker compose logs --tail=100
spire-server spire-agent` before changing any token, bundle, entry, or volume.
Do not run `docker compose down -v` for a routine stop or restart. To pause
the local demo without deleting its persistent identity state, run:

```bash
docker compose --profile api stop
docker compose --profile api ps -a
```

The default smoke questions in step 8 are shorter than the exact questions in
`eval/demo-test-plan.md`. To rehearse those two cases, run the following from
the repository root. The smoke client checks the status, the expected
document ID, and the absence of the other tenant's document ID. **Read the
answer yourself** against the test plan; the client does not grade its policy
wording.

```bash
docker compose --profile api --profile smoke run --rm \
  -e QUESTION="I purchased two shirts from VOLTFRAME two weeks ago, but I'm not satisfied with the material and want to send them back. How can I do so?" \
  voltframe-client

docker compose --profile api --profile smoke run --rm \
  -e QUESTION="I purchased shirts and pants from both Driftwood & Daughters and VOLTFRAME a few weeks ago. I'm not satisfied with any of the items, so I'm going to return everything tomorrow. What are my options?" \
  driftwood-client
```

The Voltframe answer should explain why dissatisfaction with the material is
not the damaged-or-wrong-item exception and cite `voltframe-returns-v1`.
The Driftwood answer should explain its own policy and refund conditions,
say that Voltframe's policy cannot be determined from the available source,
and cite only `driftwood-returns-v1`. Record the actual outputs or failures
in `eval/results-template.md` after sanitizing them; do not mark a case passed
solely because it returned HTTP 200.

## Teardown

Run these steps only when you are done with the demonstration of this project. The two S3 buckets
are **versioned**. First inspect every current object, noncurrent version,
and delete marker in both the foundation evidence bucket and the bootstrap
state bucket; preserve anything you need. Deleting a current S3 object by
itself does not remove its older versions. In particular, the foundation's
Terraform state must remain available until its destroy has completed.

1. Stop the local services with `docker compose --profile api stop`. Then verify with `docker compose --profile api ps -a`. Leave named volumes
   intact if you may run this installation again.
2. Load `.env` as above. From `live/dev/foundation/`, find the evidence bucket
   and inspect its versions. Review the foundation destroy plan. If the bucket
   contains data you intend to keep, export it before proceeding. A nonempty
   versioned bucket can prevent Terraform from destroying the foundation;
   remove **only the reviewed versions and delete markers** when you are ready
   to permanently discard them (S3 console → bucket → **Show versions** →
   select and permanently delete those versions and markers).

   ```bash
   cd live/dev/foundation
   EVIDENCE_BUCKET=$(terragrunt run -- output -raw sanitized_evidence_bucket_name)
   aws s3api list-object-versions --bucket "$EVIDENCE_BUCKET" --region us-east-1
   terragrunt run -- plan -destroy
   terragrunt run destroy
   cd ../../..
   ```

3. **Only after the foundation destroy succeeds**, inspect the bootstrap
   state bucket's versions (including `dev/foundation/terraform.tfstate` and
   its older versions and lock markers). The bootstrap unit's own state is a
   local file under ignored `live/.state/bootstrap/`; keep that file until
   the bootstrap destroy succeeds. Review the bootstrap destroy plan, then
   destroy it. If the versioned state bucket is nonempty, permanently remove
   only the reviewed versions and delete markers in the S3 console before
   retrying the destroy.

   ```bash
   aws s3api list-object-versions --bucket "$TF_STATE_BUCKET" --region us-east-1
   cd live/bootstrap
   terragrunt run -- plan -destroy
   terragrunt run destroy
   cd ../..
   ```

Do not use `terragrunt run --all destroy` here: the foundation depends on a
separately bootstrapped state bucket, and the order and contents need review.
Do not delete `live/.state/bootstrap/` or the SPIRE volumes as a substitute
for destroying AWS resources. An AWS account may also contain unrelated
resources; inspect the plans before confirming either destroy.

## Evidence and limits

Record actual outcomes in `eval/results-template.md`. Save only sanitized metadata, response summaries, account-independent resource names, and timings in Git; leave raw prompts, responses, AWS account details, state, keys, SPIRE tokens, and the generated index out of commits. Run negative identity, selector failure, SVID rotation/reload, AWS state/lock/KMS inspection, and a no-change plan only when you can observe and record their results. The present corpus has one passage per tenant, so Recall@5 and a two-configuration retrieval comparison are **unrun**, not passing metrics.

The response citation is taken from the authorized indexed passage, not written by the model. A prompt instructs Nova to stay within that passage, but human review of the answer is still necessary to judge factual support. No measured cost, latency, or restoration result is claimed by this repository until it is recorded from an actual run.
