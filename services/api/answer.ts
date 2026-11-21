// The only passage type the API accepts from the mTLS retriever.
export type Passage = {
  tenantId: string;
  documentId: string;
  source: string;
  text: string;
};

export type Answer =
  | { abstained: true; answer: string; citation: null }
  | {
      abstained: false;
      answer: string;
      citation: { documentId: string; source: string };
    };

const abstention: Answer = {
  abstained: true,
  answer: "I can't answer from the available authorized source.",
  citation: null,
};

// Keep the authorization boundary independent of the Bedrock SDK for testing.
export async function answerQuestion(
  question: string,
  tenantId: string,
  retrieve: (question: string, tenantId: string) => Promise<Passage | null>,
  generate: (question: string, passage: Passage) => Promise<string | null>
): Promise<Answer> {
  const passage = await retrieve(question, tenantId);
  if (passage === null) return abstention; // No model call on no match.

  // Fail closed if the retriever ever returns a different tenant's text.
  if (passage.tenantId !== tenantId) throw new Error("Retriever tenant mismatch");
  if (!passage.documentId || !passage.source || !passage.text) {
    throw new Error("Retriever passage is incomplete");
  }

  const answer = await generate(question, passage);
  if (!answer?.trim()) return abstention;

  // Citation metadata comes from the authorized index, not from the model.
  return {
    abstained: false,
    answer: answer.trim(),
    citation: { documentId: passage.documentId, source: passage.source },
  };
}
