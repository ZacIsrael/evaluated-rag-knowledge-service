// Invoke the same Bedrock embedding model during ingestion that retrieval will use for questions.
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export const modelId = "amazon.titan-embed-text-v2:0";
// Retrieval must request this same vector size when embedding a question.
export const dimensions = 1024;

// Convert one approved runbook passage into a vector using Titan Text Embeddings V2.
export async function embed(
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
