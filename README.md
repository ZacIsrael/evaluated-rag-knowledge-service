# Evaluated RAG Knowledge Service

Imagine a company offering one AI support assistant to two retailers, each with its own return policy. When someone asks a question, the assistant checks which retailer they represent, looks up only that retailer's policy, and answers with a reference to the source. If it cannot find a relevant answer, it says so instead of guessing. This project demonstrates how a shared knowledge service could help people find reliable answers while keeping each organization's information separate.

Small, local two-tenant demonstration: two labeled fictional runbooks are embedded with Titan Text Embeddings V2; a SPIRE-authenticated client asks the API; the API derives its tenant from the client's X.509-SVID, queries the retriever over mTLS, and passes only the authorized passage to Nova Micro. The API attaches the index's source reference, or abstains without generation when retrieval finds no match.

The API also writes a structured, content-free event for each completed HTTP request to the foundation's CloudWatch Logs stream. A separate demo runner checks four live requests and uploads their sanitized statuses and document IDs under `evaluations/` in the foundation S3 bucket. Neither destination receives the question, retrieved passage, or generated answer; review answer quality separately.

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
   terragrunt run -- output -raw tf_state_bucket_name
   cd ../..
   ```

3. Copy `.env.example` to `.env`. Put the **bucket name** from the previous output in `TF_STATE_BUCKET`, not its ARN. Get the ARN of the bucket's intended AWS-managed S3 KMS key in `us-east-1` using `aws kms describe-key --key-id alias/aws/s3 --region us-east-1 --query KeyMetadata.Arn --output text`, then put it in `TF_STATE_KMS_KEY_ARN`. Set `RUNTIME_PRINCIPAL_ARN` to the actual IAM principal authorized to assume the runtime role. Run `.github/workflows/inspect-oidc.yml` manually on the intended GitHub ref and use its exact printed `sub` claim for `REPOSITORY_SUBJECT`; its audience must be `sts.amazonaws.com`. Reload `.env` in every new terminal before running Terragrunt or Compose:

   ```bash
   set -a
   source .env
   set +a
   aws sts get-caller-identity
   ```

4. Validate the dev foundation from **`live/dev/foundation/`**, review the actual S3 backend key `dev/foundation/terraform.tfstate`, `.tflock`, KMS key, IAM/OIDC permissions, resources, and cost, then apply. Capture a fresh no-change plan after apply. Set these three variables in the repository-root `.env` from the outputs, then reload `.env`:

   | Foundation output | `.env` variable | Used by |
   | --- | --- | --- |
   | `rag_runtime_role_arn` | `RAG_RUNTIME_ROLE_ARN` | API, retriever, and evidence runner assume the scoped role |
   | `log_group_name` | `RAG_LOG_GROUP_NAME` | API writes request events to the `rag` stream |
   | `sanitized_evidence_bucket_name` | `RAG_EVIDENCE_BUCKET` | Evidence runner uploads JSON under `evaluations/` |

   ```bash
   cd live/dev/foundation
   terragrunt hcl validate
   terragrunt run validate
   terragrunt run plan
   terragrunt run apply
   terragrunt run -- output -raw rag_runtime_role_arn
   terragrunt run -- output -raw log_group_name
   terragrunt run -- output -raw sanitized_evidence_bucket_name
   terragrunt run plan
   cd ../../..
   ```

   If your local Terragrunt reports a version mismatch, run the repository-pinned `1.2.1` binary before retrying; removing `--` from `run -- output -raw` does not fix a version mismatch. If you only need the already-created runtime ARN and your AWS profile permits `iam:GetRole`, `aws iam get-role --role-name dev-rag --query 'Role.Arn' --output text` returns the same role ARN without reading Terragrunt state.

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

7. Register **four distinct workload identities** beneath the current agent SPIFFE ID printed by `agent list` (the API, retriever, and both demo tenant callers). If entries already have this **same Parent ID**, do not create duplicates. If you had to replace an expired agent, its old entries have the **old Parent ID**: create the four entries again under the new agent. Set `AGENT_SPIFFE_ID` to the exact new ID, then run these commands once. Check each result's Parent ID and verify with the identity probes before starting the app:

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

8. Start the API and retriever with `RAG_RUNTIME_ROLE_ARN` and `RAG_LOG_GROUP_NAME` loaded from `.env`. The local AWS profile is used **only to assume the runtime role**; both runtime Bedrock calls and the API's CloudWatch writes use its scoped temporary credentials. The API is not published on a host port. Run the actual client requests from Compose:

   ```bash
   docker compose config --quiet
   docker compose --profile api up -d --build --wait api
   docker compose --profile api --profile smoke run --rm voltframe-client
   docker compose --profile api --profile smoke run --rm driftwood-client
   docker compose --profile api --profile smoke run --rm unauthorized-client
   docker compose --profile api --profile smoke run --rm -e SPOOF_TENANT_ID=driftwood-daughters -e EXPECTED_STATUS=400 voltframe-client
   ```

   Both authorized responses should contain their own document ID and source. The Driftwood question mentions Voltframe but must never receive the Voltframe passage. The `unauthorized-client` has a trusted **retriever** identity but must receive HTTP 403. A request with a tenant ID in its body must receive HTTP 400. Confirm your model's actual answers against `eval/demo-test-plan.md` before marking the end-to-end cases passed.

   If `--wait` reports that `api` or `retriever` exited, inspect `docker compose logs --no-color --tail=80 api retriever`. Both services require a nonempty `RAG_RUNTIME_ROLE_ARN`; the API also requires `RAG_LOG_GROUP_NAME`. Add missing foundation outputs to `.env`, reload it in this terminal, and rerun the `up` command. A healthy container confirms startup, not that a CloudWatch write or Bedrock request succeeded.

## Check CloudWatch audits and publish sanitized demo evidence

After the four smoke requests, read the API's request events from the Terraform-created `rag` stream. An event includes `eventType`, `timestamp`, the tenant (or `null` for an unauthorized caller), `outcome`, `httpStatus`, a known `documentId` only for an answered request, and `durationMs`. Audit delivery happens **after** the HTTP response and is best-effort: a failed write leaves the client response unchanged and prints `Request audit delivery failed` in Docker logs. A TLS handshake rejected before an HTTP request reaches the handler produces no request event.

From the repository root, with `.env` loaded and an AWS profile allowed to read these resources:

```bash
aws logs get-log-events --log-group-name "$RAG_LOG_GROUP_NAME" --log-stream-name rag --limit 20 --region us-east-1
docker compose logs --no-color --tail=50 api
```

Run the evidence job while the API, retriever, and SPIRE agent are healthy. It executes the **two exact questions** in `eval/demo-test-plan.md`, the unauthorized 403 check, and the client-supplied-tenant 400 check. It stores only fixed check names, pass/fail, tenant, observed HTTP status, and an allow-listed document ID. It uses the scoped runtime role for `s3:PutObject` and prints the uploaded object key. A nonzero exit means a smoke assertion failed or the upload failed; inspect local service logs and the printed check statuses without copying raw responses into the evidence object.

```bash
npm run demo:evidence
aws s3api list-objects-v2 --bucket "$RAG_EVIDENCE_BUCKET" --prefix evaluations/ --region us-east-1 --query 'Contents[].Key'
```

To read an uploaded file, replace the example key with the **key** printed by the job (without the `s3://bucket/` part):

```bash
EVIDENCE_KEY='evaluations/demo-results-REPLACE_WITH_PRINTED_FILENAME.json'
aws s3api get-object --bucket "$RAG_EVIDENCE_BUCKET" --key "$EVIDENCE_KEY" /tmp/rag-demo-results.json --region us-east-1
cat /tmp/rag-demo-results.json
```

The runtime role has write permission to `evaluations/`, but no S3 read or CloudWatch read permission. The AWS profile used for the read commands therefore needs its **own** read access. The JSON records transport/status/citation assertions, **not** whether an answer follows each return policy. Read the two answers yourself against the test plan before recording policy checks as passed.

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

If the agent is not healthy, inspect `docker compose logs --no-color --tail=100
spire-server spire-agent` before changing any token, bundle, entry, or volume.
An agent stopped past its SVID's expiry may log `SVID is expired` and
`certificate signed by unknown authority`. In that **specific** case, first
export the current server bundle into a new file and recreate only the agent
container. The nonempty check must succeed before replacing the old file:

```bash
docker compose exec -T spire-server /opt/spire/bin/spire-server bundle show -format pem > spire/agent/bootstrap-new.pem
test -s spire/agent/bootstrap-new.pem && mv spire/agent/bootstrap-new.pem spire/agent/bootstrap.pem
docker compose up -d --force-recreate spire-agent
docker compose logs --no-color --since=5m --tail=60 spire-agent
```

If it **still** cannot verify the server and the logs show recovery of the
expired saved SVID, reset **only the agent's** state. First inspect the exact
volume mounted at `/var/lib/spire/agent`; the next command names the default
Compose project volume. If the inspected name differs, use the inspected
agent-data name instead. Never remove `spire-server-data`: it holds the
server's keys and registrations.

```bash
docker inspect "$(docker compose ps -aq spire-agent)" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/spire/agent"}}{{.Name}}{{end}}{{end}}'
docker compose rm -sf spire-agent
docker volume rm evaluated-rag-knowledge-service_spire-agent-data
docker compose exec -T spire-server /opt/spire/bin/spire-server token generate
printf 'Paste the new one-time token: '; read -rs JOIN_TOKEN; printf '\n'
(umask 077; printf '%s' "$JOIN_TOKEN" > spire/agent/join-token)
unset JOIN_TOKEN
chmod 600 spire/agent/join-token
docker compose up -d --wait spire-agent
docker compose exec -T spire-server /opt/spire/bin/spire-server agent list
```

Paste only the generated token at the hidden `read` prompt and press Return;
never paste it into chat or commit it. The new agent has a **new SPIFFE ID**.
Set `AGENT_SPIFFE_ID` to that full ID and repeat the four registration commands
in step 7; old entries still point to the old agent. Verify the probes, then
start the API again.

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
in a dated copy of `eval/results-template.md` after sanitizing them; leave the
template blank for other users. Do not mark a case passed
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

Record actual outcomes in a dated copy of `eval/results-template.md`; keep the reusable template blank. Save only sanitized metadata, response summaries, account-independent resource names, and timings in Git; leave raw prompts, responses, AWS account details, state, keys, SPIRE tokens, and the generated index out of commits. The automated S3 JSON covers four smoke checks, not answer-quality grading or the negative selector and rotation cases. Run negative identity, selector failure, SVID rotation/reload, AWS state/lock/KMS inspection, and a no-change plan only when you can observe and record their results. The present corpus has one passage per tenant, so Recall@5 and a two-configuration retrieval comparison are **unrun**, not passing metrics.

The response citation is taken from the authorized indexed passage, not written by the model. A prompt instructs Nova to stay within that passage, but human review of the answer is still necessary to judge factual support. No measured cost, latency, or restoration result is claimed by this repository until it is recorded from an actual run.