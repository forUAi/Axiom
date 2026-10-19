# Axiom native RAGAS runner

This service runs the real `ragas==0.4.3` collections API. It is separate from the site's custom OpenAI evidence-support judge. The hosted Site uses Cloudflare Workers, which cannot execute this Python package directly.

## Start locally

Use Python 3.11 or newer for deployment. Create a virtual environment, install `requirements.txt`, and set `AXIOM_RUNNER_TOKEN` to a random secret of at least 24 characters. Set `AXIOM_ALLOWED_ORIGINS` to the exact comma-separated browser origins allowed to call the runner. Start with:

```sh
uvicorn app:app --host 127.0.0.1 --port 8000 --no-access-log
```

Configure these environment variables in your hosting platform when deploying the included Dockerfile. Do not expose the service without its bearer token. Use an HTTPS host for access from the published Axiom app. A public page calling a localhost HTTP service can be blocked by browser mixed-content or private-network policies.

In Axiom Connections, enter the runner URL and its token. Enter an OpenAI key separately in the OpenAI section, then enable Native RAGAS metrics. Requests send the supplied key in `X-OpenAI-Key`; the runner creates a request-local OpenAI client and never persists the key. The runner intentionally does not read a global OpenAI key.

## API

`GET /health`: engine, installed version, and health only.

`POST /v1/evaluate`: bearer authentication, event, retrieved contexts, decision, and OpenAI model. See the app's adapter contract. The response identifies `engine: ragas` and includes native metric values.

- **Faithfulness** evaluates the classification rationale against retrieved contexts. It does not establish that the underlying sources are factually correct.
- **Context precision / recall / factual correctness** use the analyst's `reference_explanation`. They are skipped when no explanation exists. A TP/FP label alone is not used as a reference explanation.
- **Label match** uses RAGAS `ExactMatch` against an available analyst-confirmed TP/FP label. No model is required for this metric.
- Optional `metrics` limits execution to a subset of `faithfulness`, `context_precision`, `context_recall`, `label_match`.

The endpoint returns undefined/invalid scores as errors, never as zero. Model failures do not become successful scores. Provider messages are not echoed because they can contain sensitive inputs. RAGAS telemetry is disabled.

## Metric interpretation

The browser computes classification precision, recall, F1, accuracy, and the confusion matrix only on events with analyst labels and valid decisions. Event labels use TP/FP terminology; in the confusion matrix, the positive class is TP, so an actual TP predicted FP is a false negative. Low-confidence classifications remain included but are flagged for review. The UI does not remediate events or write labels back to EMS.

Official definitions: https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/

`factual_correctness` uses `ragas.metrics.collections.FactualCorrectness` in F1 mode to compare the decision rationale with the analyst reference explanation. This is distinct from binary TP/FP answer correctness and classification F1. It is included in the default metrics and skipped when no reference explanation exists.
