/*
This file's purpose is to:
- Read the two existing runbooks, 
select at least one passage from each, 
and attach a:
-- tenant ID,
-- document ID,
-- and source reference
- Call the Bedrock embedding model for each passage and write the labeled 
passages and vectors to a small local index.
This job gets run when building or refreshing the local index; not on every question
*/

// Invoke the same Bedrock embedding model during ingestion that retrieval will use for questions.
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

// Read the runbooks and write the completed local index safely.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type RunbookParagraph = {
  // Markdown heading that identifies the paragraph's source section.
  heading: string;
  // Original runbook text to embed.
  text: string;
};

type IndexedPassage = {
  // Trusted ownership label used to filter passages before retrieval.
  tenantId: string;
  // Stable ID declared in the source runbook.
  documentId: string;
  // Filename and section heading used for citations.
  source: string;
  // Source text returned with a matching passage.
  text: string;
  // Vector returned by Bedrock for this text.
  embedding: number[];
};

type RunbookSpec = {
  fileName: string;
  // Expected tenant ID; checked against the runbook before indexing.
  tenantId: string;
  // Expected document ID; checked against the runbook before indexing.
  documentId: string;
  // Policy section to select from this runbook.
  sectionHeading: string;
};

const modelId = "amazon.titan-embed-text-v2:0";

// Retrieval must request this same vector size when embedding a question.
const dimensions = 1024;

// Generated index stays local and is excluded from Git.
const indexPath = resolve("jobs/ingest/.local-index/index.json");

// These labels are reviewed corpus metadata, not values supplied by a question.
const runbooks: RunbookSpec[] = [
  {
    fileName: "driftwood-daughters-returns.md",
    tenantId: "driftwood-daughters",
    documentId: "driftwood-returns-v1",
    sectionHeading: "Return policy",
  },
  {
    fileName: "voltframe-returns.md",
    tenantId: "voltframe",
    documentId: "voltframe-returns-v1",
    sectionHeading: "Order and return policy",
  },
];

// Run from the repository root so corpus/ and the local index resolve there.
async function loadRunbook(fileName: string): Promise<string> {
  return readFile(resolve("corpus", fileName), "utf8");
}

// Read a declared corpus label so it can be checked against the approved runbook mapping.
function readLabel(runbook: string, name: "Tenant ID" | "Document ID"): string {
  // Match the label's Markdown line and capture the value inside backticks.
  const pattern =
    name === "Tenant ID"
      ? /^\*\*Tenant ID:\*\*[ \t]*`([^`]+)`[ \t]*$/m
      : /^\*\*Document ID:\*\*[ \t]*`([^`]+)`[ \t]*$/m;

  const label = runbook.match(pattern)?.[1];

  // Stop ingestion rather than index a document without an ownership or document label.
  if (!label) throw new Error(`Missing ${name} in runbook`);

  return label;
}

// Keep the nearest Markdown heading with each paragraph for source citations.
function getParagraphs(runbook: string): RunbookParagraph[] {
  const paragraphs: RunbookParagraph[] = [];
  let heading = "";
  let lines: string[] = [];

  // Save the accumulated lines as one paragraph under the current heading.
  function finishParagraph(): void {
    const text = lines.join("\n").trim();

    // Skip empty blocks so the index contains only actual text.
    if (text) paragraphs.push({ heading, text });

    lines = [];
  }

  // Accept both Unix and Windows line endings.
  for (const line of runbook.split(/\r?\n/)) {
    // Recognize Markdown headings from # through ######.
    const headingMatch = line.match(/^#{1,6}[ \t]+(.+?)[ \t]*$/);

    if (headingMatch) {
      // Finish the previous paragraph before changing its source heading.
      finishParagraph();
      heading = headingMatch[1]?.trim() ?? "";
    } else if (!line.trim()) {
      // A blank line marks the end of a paragraph.
      finishParagraph();
    } else {
      lines.push(line);
    }
  }

  // Keep the final paragraph even when the file has no trailing blank line.
  finishParagraph();
  return paragraphs;
}

function selectPassage(
  runbook: string,
  spec: RunbookSpec
): Omit<IndexedPassage, "embedding"> {
  // Reject a mislabeled document before its text can enter the tenant index.
  if (
    readLabel(runbook, "Tenant ID") !== spec.tenantId ||
    readLabel(runbook, "Document ID") !== spec.documentId
  ) {
    throw new Error(
      `Corpus labels do not match the approved mapping for ${spec.fileName}`
    );
  }

  // Keep the full short policy together, including its refund or damage exception.
  const text = getParagraphs(runbook)
    .filter((paragraph) => paragraph.heading === spec.sectionHeading)
    .map((paragraph) => paragraph.text)
    .join("\n\n");
  if (!text || text.length > 50_000) {
    throw new Error(`Missing or oversized policy section in ${spec.fileName}`);
  }

  return {
    tenantId: spec.tenantId,
    documentId: spec.documentId,
    source: `${spec.fileName} — ${spec.sectionHeading}`,
    text,
  };
}

// Convert one approved runbook passage into a vector using Titan Text Embeddings V2.
async function embed(
  client: BedrockRuntimeClient,
  text: string
): Promise<number[]> {
  // Invoke the model selected for this index. Retrieval must use the same
  // model and dimensions when it embeds a question.
  const response = await client.send(
    new InvokeModelCommand({
      modelId,

      // Titan expects a JSON request and returns a JSON response.
      contentType: "application/json",
      accept: "application/json",

      // inputText is the actual runbook passage. Request a fixed vector size
      // and normalized values so vectors can be compared consistently.
      body: JSON.stringify({ inputText: text, dimensions, normalize: true }),
    })
  );

  // Decode Bedrock's response bytes before parsing the JSON.
  // Treat parsed JSON as unknown until its shape has been checked.
  const payload: unknown = JSON.parse(new TextDecoder().decode(response.body));

  // Extract the embedding only if the response is an object with that field.
  const vector =
    payload && typeof payload === "object" && "embedding" in payload
      ? payload.embedding
      : undefined;

  // Reject a missing, wrong-sized, or nonnumeric vector rather than write
  // an index that the retriever cannot compare with question embeddings.
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    !vector.every(
      (value) => typeof value === "number" && Number.isFinite(value)
    )
  ) {
    throw new Error("Bedrock returned an invalid embedding vector");
  }

  // The checks above establish that this is a finite number[] of the
  // expected length; TypeScript still needs the explicit assertion.
  return vector as number[];
}

async function main(): Promise<void> {
  // Use the project's AWS Region unless the caller explicitly sets AWS_REGION.
  // The SDK obtains credentials from the active AWS credential configuration.
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  });

  // Collect the fully labeled passages before writing anything to disk.
  const passages: IndexedPassage[] = [];

  for (const spec of runbooks) {
    // Read the source file named in the approved runbook mapping.
    const runbook = await loadRunbook(spec.fileName);

    // Verify its tenant and document labels, then select its policy section.
    const passage = selectPassage(runbook, spec);

    // Make one real Bedrock call for this passage and keep its vector
    // alongside the source text and ownership labels.
    passages.push({ ...passage, embedding: await embed(client, passage.text) });
  }

  // Write the complete index only after both model calls succeed.
  // A temporary file prevents a failed write from replacing the previous index.
  const temporaryPath = `${indexPath}.${process.pid}.tmp`;
  await mkdir(resolve("jobs/ingest/.local-index"), { recursive: true });

  try {
    await writeFile(
      temporaryPath,
      JSON.stringify(
        {
          // The retriever can check this version before reading the file.
          schemaVersion: 1,

          // Store the embedding settings so question vectors use the same
          // model, dimensions, and normalization setting.
          modelId,
          dimensions,
          normalized: true,

          // Each entry contains its tenant label, citation, text, and vector.
          passages,
        },
        null,
        2
      ) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );

    // Replace the previous index only after the new file is fully written.
    await rename(temporaryPath, indexPath);
  } catch (error) {
    // Remove an incomplete temporary file, but preserve the previous index.
    await rm(temporaryPath, { force: true });
    throw error;
  }

  // Log metadata only; the generated file contains document text and vectors.
  console.log(`Indexed ${passages.length} labeled passages at ${indexPath}`);
  for (const passage of passages) {
    console.log(
      `${passage.documentId}: ${passage.source} (${passage.embedding.length} dimensions)`
    );
  }
}

// Report an ingestion failure and return a nonzero exit status to the shell.
main().catch((error: unknown) => {
  console.error("Ingestion failed:", error);
  process.exitCode = 1;
});
