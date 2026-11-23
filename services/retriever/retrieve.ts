/*
This file's purpose is to:
- Accept a question and a trusted tenant ID
- Embed the question with the same model used 
during ingestion, consider only passages belonging 
to that tenant, rank those passages by vector similarity, 
and return the best match with its source reference.

Return “no match” when nothing authorized qualifies. 
The question text must never decide the tenant.
*/

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { embed } from "../shared/embedding.js";
// Service calls assume the scoped role; local checks can use the AWS profile.
import { runtimeCredentials } from "../shared/runtime-credentials.js";

// Load the local index
// Run from repository root
const indexPath = resolve("jobs/ingest/.local-index/index.json");

async function loadIndex(): Promise<unknown> {
  const contents = await readFile(indexPath, "utf8");
  return JSON.parse(contents) as unknown;
}

const localIndex = await loadIndex();

// Validate that localIndex is an object
if (
  typeof localIndex !== "object" ||
  localIndex === null ||
  Array.isArray(localIndex)
) {
  throw new Error("Index must be a JSON object");
}

// localIndex is an object

// Validate schemaVersion, modelId, dimensions, and passages
if (
  !("schemaVersion" in localIndex) ||
  localIndex.schemaVersion !== 1 ||
  !("modelId" in localIndex) ||
  localIndex.modelId !== "amazon.titan-embed-text-v2:0" ||
  !("dimensions" in localIndex) ||
  localIndex.dimensions !== 1024 ||
  !("normalized" in localIndex) ||
  localIndex.normalized !== true ||
  !("passages" in localIndex) ||
  !Array.isArray(localIndex.passages)
) {
  throw new Error("Index format or embedding settings do not match retrieval");
}

type IndexedPassage = {
  tenantId: string;
  documentId: string;
  source: string;
  text: string;
  embedding: number[];
};

// Check one parsed JSON value before treating it as an indexed passage.
// JSON.parse() does not verify TypeScript types at runtime.
function isIndexedPassage(value: unknown): value is IndexedPassage {
  // Passage entries must be non-null objects.
  if (typeof value !== "object" || value === null) return false;

  // Inspect the object's fields without assuming their types yet.
  const passage = value as Record<string, unknown>;

  return (
    // Require the ownership label and the metadata needed for a citation.
    typeof passage.tenantId === "string" &&
    typeof passage.documentId === "string" &&
    typeof passage.source === "string" &&
    typeof passage.text === "string" &&
    // The stored vector must match the dimensions used for question embeddings.
    Array.isArray(passage.embedding) &&
    passage.embedding.length === 1024 &&
    // Reject missing, nonnumeric, NaN, or infinite vector components.
    passage.embedding.every(
      (number: unknown) => typeof number === "number" && Number.isFinite(number)
    )
  );
}

// Reject the entire index if any passage is malformed; do not retrieve
// from a partially validated set of tenant-labeled passages.
if (!localIndex.passages.every(isIndexedPassage)) {
  throw new Error("Index contains an invalid passage");
}

// Every entry has now passed the runtime check, so retrieval can use
// the array as IndexedPassage[] without repeating field checks.
const validatedPassages: IndexedPassage[] = localIndex.passages;

// Return the highest-scoring passage owned by the caller's trusted tenant,
// or null when that tenant has no indexed passage.
export async function retrieve(
  // Question being asked
  question: string,
  // Tentant ID of the caller (voltframe or driftwood-daughters in the case of this application)
  callerTenantId: string
): Promise<IndexedPassage | null> {
  // Filter passages by the caller's trusted tentant id
  const authorizedPassages = validatedPassages.filter(
    (passage) => passage.tenantId === callerTenantId
  );

  // No passage belongs to this caller's tenant, so there is nothing
  // authorized to retrieve. Skip the Bedrock call and report no match.
  if (authorizedPassages.length === 0) {
    return null;
  }

  // Use the configured AWS Region, falling back to the Region used by ingestion.
  // The SDK obtains credentials from the active AWS credential configuration.
  // In the deployed service, assume the foundation role before embedding.
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...runtimeCredentials(),
  });

  // Embed the question with the same model, dimensions, and normalization
  // settings used for the indexed passages so their vectors can be compared.
  const questionEmbedding = await embed(client, question);

  // A question without a vector cannot be compared with indexed passages.
  if (questionEmbedding.length === 0) return null;

  // Track the highest-scoring authorized passage as we examine the candidates.
  // -Infinity ensures that the first valid score becomes the initial best score.
  let bestPassage: IndexedPassage | null = null;
  let bestScore = -Infinity;

  for (const passage of authorizedPassages) {
    // Both vectors were normalized using the same embedding settings.
    // Their dot product measures how similar the question and passage are.
    let score = 0;

    for (let i = 0; i < questionEmbedding.length; i++) {
      // Compare corresponding positions in the two 1,024-value vectors.
      const questionValue = questionEmbedding[i];
      const passageValue = passage.embedding[i];

      // Never score incomplete or mismatched vectors.
      if (questionValue === undefined || passageValue === undefined) {
        throw new Error("Embedding dimensions do not match");
      }

      // Add this pair's contribution to the passage's similarity score.
      score += questionValue * passageValue;
    }

    // Keep this passage only if it scores higher than every candidate so far.
    if (score > bestScore) {
      bestScore = score;
      bestPassage = passage;
    }
  }

  // Provisional cutoff measured against the current two-document demo corpus (smoke.ts).
  // Recheck it if the corpus, embedding model, or question set changes.
  const minSimilarity = 0.18;

  if (bestScore < minSimilarity) {
    return null;
  }
  // Return the best passage from the caller's tenant, or null if none was found.
  return bestPassage;
}
