import os
os.environ['AXIOM_RUNNER_TOKEN'] = 'test-runner-token-not-a-real-secret'
os.environ['RAGAS_DO_NOT_TRACK'] = 'true'
from fastapi.testclient import TestClient
from runner.app import app
client = TestClient(app)
HEADERS = {'Authorization': 'Bearer test-runner-token-not-a-real-secret'}
PAYLOAD = {'event': {'id':'test', 'title':'Test', 'description':'An authorized action.', 'analyst_label':'FP'}, 'contexts':[{'id':'policy', 'text':'The action is authorized.'}], 'decision':{'verdict':'FP', 'rationale':'This is an authorized action.'}, 'metrics':['label_match']}

def test_actual_ragas_label_match():
    response = client.post('/v1/evaluate', json=PAYLOAD, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()['engine'] == 'ragas'
    assert response.json()['version'] == '0.4.3'
    assert response.json()['metrics']['label_match']['value'] == 1.0

def test_missing_label_and_reference_are_skipped():
    payload = {**PAYLOAD, 'event':{**PAYLOAD['event'], 'analyst_label':None}, 'metrics':['label_match','context_precision','context_recall']}
    response = client.post('/v1/evaluate', json=payload, headers=HEADERS)
    assert response.status_code == 200
    assert all(m['status']=='skipped' and m['value'] is None for m in response.json()['metrics'].values())

def test_runner_auth_required():
    assert client.post('/v1/evaluate', json=PAYLOAD).status_code == 401

def test_model_metrics_require_provider_key():
    response = client.post('/v1/evaluate', json={**PAYLOAD,'metrics':['faithfulness']}, headers=HEADERS)
    assert response.status_code == 401

def test_invalid_label_and_empty_context_rejected():
    assert client.post('/v1/evaluate', json={**PAYLOAD,'contexts':[]},headers=HEADERS).status_code==422
    assert client.post('/v1/evaluate', json={**PAYLOAD,'decision':{'verdict':'MAYBE','rationale':'a'}},headers=HEADERS).status_code==422

def test_factual_correctness_skips_without_reference():
    response = client.post('/v1/evaluate', json={**PAYLOAD,'metrics':['factual_correctness']}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()['metrics']['factual_correctness']['status'] == 'skipped'

def test_factual_correctness_uses_response_and_reference(monkeypatch):
    from runner import app as module
    from types import SimpleNamespace
    observed = {}
    class FakeClient:
        def __init__(self, **kwargs): pass
        async def close(self): observed['closed'] = True
    class FakeMetric:
        def __init__(self, **kwargs): observed['mode'] = kwargs['mode']
        async def ascore(self, **kwargs):
            observed.update(kwargs)
            return SimpleNamespace(value=.75, reason='Reference comparison')
    monkeypatch.setattr(module, 'AsyncOpenAI', FakeClient)
    monkeypatch.setattr(module, 'llm_factory', lambda *args, **kwargs: object())
    monkeypatch.setattr(module, 'FactualCorrectness', FakeMetric)
    payload={**PAYLOAD,'event':{**PAYLOAD['event'],'reference_explanation':'Approved activity.'},'metrics':['factual_correctness']}
    response=client.post('/v1/evaluate',json=payload,headers={**HEADERS,'X-OpenAI-Key':'test-key-not-real'})
    assert response.status_code == 200
    assert response.json()['metrics']['factual_correctness']['value'] == .75
    assert observed['response'] == PAYLOAD['decision']['rationale']
    assert observed['reference'] == 'Approved activity.'
    assert observed['mode'] == 'f1' and observed['closed']
