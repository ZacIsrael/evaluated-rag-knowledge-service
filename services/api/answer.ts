// The retriever sends text plus ownership and citation metadata for one passage.
export type Passage = {
  tenantId: string;
  documentId: string;
  source: string;
  text: string;
};

// A discriminated union keeps abstentions from carrying a misleading citation.
export type Answer =
  | { abstained: true; answer: string; citation: null }
  | {
      abstained: false;
      answer: string;
      citation: { documentId: string; source: string };
    };

// Reuse the same response when retrieval or generation cannot support an answer.
const abstention: Answer = {
  abstained: true,
  answer: "I can't answer from the available authorized source.",
  citation: null,
};

// Find a passage for the caller's verified tenant and check that it belongs
// to that tenant. If there is no passage or the model cannot answer, abstain;
// otherwise, answer from that passage and cite its source.
export async function answerQuestion(
  question: string,
  tenantId: string,
  retrieve: (question: string, tenantId: string) => Promise<Passage | null>,
  generate: (question: string, passage: Passage) => Promise<string | null>
): Promise<Answer> {
  // Retrieval filters candidates by tenant before ranking them.
  const passage = await retrieve(question, tenantId);
  // Do not ask the model to guess when the tenant has no qualifying passage.
  if (passage === null) return abstention;

  // Fail closed if the retriever ever returns a different tenant's text.
  if (passage.tenantId !== tenantId) throw new Error("Retriever tenant mismatch");
  // An incomplete passage cannot safely ground an answer or citation.
  if (!passage.documentId || !passage.source || !passage.text) {
    throw new Error("Retriever passage is incomplete");
  }

  // Only this checked passage crosses the retrieval-to-generation boundary.
  const answer = await generate(question, passage);
  // The model may explicitly decline when the passage lacks the answer.
  if (!answer?.trim()) return abstention;

  // Citation metadata comes from the authorized index, not from the model.
  return {
    abstained: false,
    answer: answer.trim(),
    citation: { documentId: passage.documentId, source: passage.source },
  };
}
