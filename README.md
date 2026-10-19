# Axiom event evaluation

Private evaluation workspace for a single use case: Zenity and Troj events in an Event Management System, top-K evidence retrieval, LLM TP/FP classification, and evaluation against evidence and available analyst labels.

## Working flows

- OpenAI classification and a separate structured evidence-support judge through same-origin server routes. Enter an API key in Connections; keys stay in page memory and are forwarded to OpenAI only for requested calls.
- EMS adapter: GET `/v1/events`, POST `/v1/retrieve`. A complete downloadable contract lives at `public/adapter-contract.json`. The application does not perform vector search itself; the adapter owns retrieval.
- Evaluate original EMS decisions with their original retrieved contexts, or re-run the classifier.
- Native RAGAS runner under `runner/`, also downloadable in the application. Deploy behind HTTPS and configure its URL/token to enable Faithfulness, ContextPrecision, ContextRecall, and label exact match. The Site's Worker runtime does not execute Python.
- Event-by-event traces, evidence inspection, review flags, confusion matrix, precision/recall/F1/accuracy, session run history, and JSON export.
- Explicitly labelled fictional example events and an illustrative walkthrough. Walkthrough values never become live OpenAI or RAGAS results.

## Local development

Use the Sites install/build helpers. `npm run dev -- --host 127.0.0.1 --port 4387` starts the local app. Source UI is `studio/index.html`, `public/studio.js`, and `public/studio.css`. Server routes are in `app/api/`; the provider client is `server/openai.mjs`.

```sh
node --test tests/evaluation.test.mjs
python -m pytest tests/test_runner.py -q
```

The Python tests require the runner dependencies plus pytest/httpx. They execute the actual native RAGAS ExactMatch metric without an external model key. OpenAI route tests use deterministic fake HTTP responses to verify the request contract and failure behavior. Live OpenAI and LLM-based RAGAS scoring require a user-supplied key and were not called during development.

## Evaluation interpretation

Analyst labels and reference explanations are removed from classifier requests. Classification metrics include only successful decisions with analyst labels. Native context precision/recall require an analyst reference explanation and are skipped without it. Custom LLM evidence support is distinct from native RAGAS Faithfulness. Confidence is self-assessed, not calibrated. Review flags do not change the predicted label. No decisions are written back to EMS and no remediation is performed.

Evidence, secrets, and run traces are not persisted to browser storage. Non-secret endpoint/model preferences are. Runtime keys are not stored in the repository or application logs. Native runner setup is documented in `runner/README.md`.

## Visible evaluation metrics

The main screen keeps six metric groups beside the continuously animated evidence pipeline. The idle tour cycles through existing context records only; it makes no requests and never increments evaluation counts. Motion can be paused and honors reduced-motion preferences. Completed runs replay their evidence without rescoring.

- **Context Relevance:** custom OpenAI judge, relevant chunks / retrieved chunks.
- **Context Sufficiency (Recall):** custom judge, reference claims supported by retrieved contexts / all reference claims. Native RAGAS Context Recall is shown independently. Both require `reference_explanation`.
- **Precision@k / Recall@k:** deterministic rank-cutoff calculations using a complete `relevant_context_ids` set. P@k = hits/k (unfilled slots count as misses); R@k = hits/reference set size. Unknown references are omitted, empty reference sets have undefined recall. Existing EMS decisions use their original context count for k.
- **Groundedness / Faithfulness:** custom claim grounding and separate native RAGAS Faithfulness. Grounding uses retrieved evidence, not the generated answer as its own evidence.
- **Answer Correctness:** TP/FP exact agreement with analyst labels. Rationale factuality is a separate native RAGAS FactualCorrectness F1 against the reference explanation.
- **F1 score:** TP-positive classification F1 over labelled successful decisions.

Per-event metrics are averaged over eligible events only. Unavailable values remain null and display a dash. Cards open definitions and input requirements. Event details expose context verdicts, missing reference facts, retrieval hit counts, and claim support. Analyst labels, reference explanations and relevance IDs are withheld from classifier inputs. Only the evaluator receives the reference explanation.

Native metric references: [RAGAS context recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/) and [factual correctness](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/factual_correctness/).
