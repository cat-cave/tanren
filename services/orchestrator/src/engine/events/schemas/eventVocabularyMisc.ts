// Aggregates small, unrelated vocabulary modules so the registry keeps one
// dependency per logical group and stays under the dependency/file-size caps.
import { BenchmarkAcceptFailedPayload, BenchmarkAcceptPassedPayload } from "./benchmark.js";
import { projectActivationVocabularyRegistry } from "./projectActivationVocabulary.js";
import { RedactionRawAccessPayload } from "./redaction.js";
import { wave3EventRegistry } from "./wave3Vocabulary.js";

export const eventVocabularyMiscRegistry = {
  "redaction.raw_access": RedactionRawAccessPayload,
  "benchmark.accept.passed": BenchmarkAcceptPassedPayload,
  "benchmark.accept.failed": BenchmarkAcceptFailedPayload,
  ...projectActivationVocabularyRegistry,
  ...wave3EventRegistry,
};
