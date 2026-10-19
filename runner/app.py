"""Authenticated native RAGAS adapter for the Axiom event evaluation workspace."""
import os
os.environ.setdefault("RAGAS_DO_NOT_TRACK", "true")
import asyncio
import math
import secrets
from typing import List, Optional, Literal
from importlib.metadata import version
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ConfigDict
from openai import AsyncOpenAI
from ragas.llms import llm_factory
from ragas.metrics.collections import Faithfulness, ContextPrecision, ContextRecall, ExactMatch, FactualCorrectness

app = FastAPI(title="Axiom RAGAS runner", version="1.0.0")
origins = os.environ.get("AXIOM_ALLOWED_ORIGINS", "https://axiom-eval-observatory.reddyvishalch.chatgpt.site").split(",")
app.add_middleware(CORSMiddleware, allow_origins=[x.strip() for x in origins], allow_methods=["GET", "POST"], allow_headers=["Content-Type", "Authorization", "X-OpenAI-Key"], allow_credentials=False)

class Event(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    description: str = Field(min_length=1, max_length=20000)
    analyst_label: Optional[Literal["TP", "FP"]] = None
    reference_explanation: str = Field(default="", max_length=16000)

class Context(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=16000)

class Decision(BaseModel):
    model_config = ConfigDict(extra="ignore")
    verdict: Literal["TP", "FP"]
    rationale: str = Field(min_length=1, max_length=16000)

MetricName = Literal["faithfulness", "context_precision", "context_recall", "label_match", "factual_correctness"]
class EvaluationRequest(BaseModel):
    event: Event
    contexts: List[Context] = Field(min_length=1, max_length=20)
    decision: Decision
    model: str = Field(default="gpt-4.1-mini", min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9._:-]+$")
    metrics: List[MetricName] = Field(default_factory=lambda: ["faithfulness", "context_precision", "context_recall", "label_match", "factual_correctness"], min_length=1, max_length=5)

@app.middleware("http")
async def limit_body(request, call_next):
    if request.method == "POST":
        size = request.headers.get("content-length")
        if size and (not size.isdigit() or int(size) > 180000):
            from starlette.responses import JSONResponse
            return JSONResponse({"error": "Request too large."}, status_code=413)
        body = await request.body()
        if len(body) > 180000:
            from starlette.responses import JSONResponse
            return JSONResponse({"error": "Request too large."}, status_code=413)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response

@app.get("/health")
def health():
    return {"ok": True, "engine": "ragas", "version": version("ragas"), "authentication_required": True}

def verify_token(authorization):
    expected = os.environ.get("AXIOM_RUNNER_TOKEN", "")
    if len(expected) < 24:
        raise HTTPException(503, "Set AXIOM_RUNNER_TOKEN to a random secret of at least 24 characters before serving evaluations.")
    supplied = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(401, "Invalid runner bearer token.")

def serialize_result(result):
    value = float(result.value)
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("RAGAS returned an undefined metric.")
    reason = getattr(result, "reason", None)
    return {"status": "ok", "value": value, "reason": str(reason) if reason else "Computed by the native RAGAS library."}

async def evaluate_metrics(body, api_key):
    llm = None
    client = None
    needs_model = any(m == "faithfulness" or m in ["context_precision", "context_recall", "factual_correctness"] and body.event.reference_explanation.strip() for m in body.metrics)
    if needs_model:
        if not api_key or len(api_key) < 12:
            raise HTTPException(401, "Supply an OpenAI key in X-OpenAI-Key for model-based RAGAS metrics.")
        client = AsyncOpenAI(api_key=api_key, timeout=60, max_retries=1)
        llm = llm_factory(body.model, client=client)
    query = f"Assess this security event as TP or FP: {body.event.title}\n{body.event.description}"
    contexts = [c.text for c in body.contexts]
    reference = body.event.reference_explanation.strip()
    results = {}
    try:
        for name in dict.fromkeys(body.metrics):
            if name in ["context_precision", "context_recall", "factual_correctness"] and not reference:
                results[name] = {"status": "skipped", "value": None, "reason": "No analyst reference explanation is available. A TP/FP label alone is insufficient for this metric."}
                continue
            if name == "label_match":
                if body.event.analyst_label is None:
                    results[name] = {"status": "skipped", "value": None, "reason": "No analyst-confirmed label is available."}
                    continue
                result = await ExactMatch().ascore(reference=body.event.analyst_label, response=body.decision.verdict)
            elif name == "faithfulness":
                result = await Faithfulness(llm=llm).ascore(user_input=query, response=body.decision.rationale, retrieved_contexts=contexts)
            elif name == "context_precision":
                result = await ContextPrecision(llm=llm).ascore(user_input=query, reference=reference, retrieved_contexts=contexts)
            elif name == "context_recall":
                result = await ContextRecall(llm=llm).ascore(user_input=query, reference=reference, retrieved_contexts=contexts)
            elif name == "factual_correctness":
                result = await FactualCorrectness(llm=llm, mode="f1").ascore(response=body.decision.rationale, reference=reference)
            results[name] = serialize_result(result)
        return results
    finally:
        if client:
            await client.close()

@app.post("/v1/evaluate")
async def evaluate(body: EvaluationRequest, authorization: Optional[str] = Header(default=None), x_openai_key: Optional[str] = Header(default=None)):
    verify_token(authorization)
    try:
        metrics = await asyncio.wait_for(evaluate_metrics(body, x_openai_key), timeout=170)
        return {"engine": "ragas", "version": version("ragas"), "event_id": body.event.id, "metrics": metrics}
    except HTTPException:
        raise
    except asyncio.TimeoutError:
        raise HTTPException(504, "RAGAS timed out. Reduce context size or retry the event.")
    except Exception:
        # Provider exceptions can include request content; never echo them or credentials.
        raise HTTPException(502, "RAGAS could not score this event. Check provider access, model compatibility, and evidence completeness.")
