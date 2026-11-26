flow({
  id: 'mlops-pipeline',
  title: 'MLOps: train, register, deploy with canary, monitor drift',
  category: 'AI & machine learning',
  tags: ['Training pipeline', 'Experiment tracking', 'Model registry + aliases', 'Shadow / canary deploy', 'Data drift', 'Retrain trigger'],
  summary: 'A model that is good on launch day gets worse as the world changes. Follow a demand-forecasting model through an automated loop: a pipeline retrains it on fresh data, logs the run, registers version 8, deploys it to 5% of traffic beside version 7, promotes it when its error is lower, and a monitor later detects input drift and triggers the next retrain.',
  requirements: {
    functional: ['Retrain on new data automatically.', 'Roll out new versions gradually and roll back in one step.', 'Detect when live data stops looking like training data.'],
    nonFunctional: ['Every deployed model traces back to its code, data and parameters.', 'Rollback in under a minute.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'sched', label: 'Orchestrator', sub: 'Airflow / Kubeflow', kind: 'worker', icon: 'clock', x: 0, y: 1, desc: 'Runs the pipeline on a schedule or on a trigger: validate data, train, evaluate, register.' },
    { id: 'train', label: 'Training job', sub: 'GPU/CPU cluster', kind: 'ai', icon: 'cpu', x: 1, y: 0, desc: 'Trains on the latest data window and evaluates on a held-out recent period.' },
    { id: 'track', label: 'Tracking + registry', sub: 'MLflow', kind: 'db', icon: 'folder', x: 2, y: 0, desc: 'Stores each run\'s parameters, metrics and artifacts, and versioned registered models with aliases such as "champion".' },
    { id: 'srv', label: 'Model serving', sub: 'v7 95% / v8 5%', kind: 'service', icon: 'server', x: 2, y: 1, desc: 'Serves predictions; can split traffic between versions.' },
    { id: 'app', label: 'Shop backend', sub: 'asks for forecasts', kind: 'client', icon: 'building', x: 3, y: 1, desc: 'Calls the model to plan stock.' },
    { id: 'mon', label: 'Monitor', sub: 'drift + accuracy', kind: 'worker', icon: 'chart', x: 1, y: 2, desc: 'Compares live input distributions with training data and, once true values arrive, live error with offline error.' }
  ],
  pseudo: `
with mlflow.start_run():
    validate(data)                                 # schema, nulls, ranges
    model = train(data["2024-11":"2026-10"])
    mape = evaluate(model, data["2026-11"])
    mlflow.log_params(p); mlflow.log_metric("mape", mape)
    v = mlflow.register_model(run_uri, "demand")   # version 8
if mape < registry.get("demand@champion").mape:
    serving.split({"v7": 95, "v8": 5})             # canary
    if live_mape("v8") <= live_mape("v7"):
        client.set_registered_model_alias("demand", "champion", v)
if drift(live_inputs, train_inputs) > 0.2: trigger(pipeline)`,
  steps: [
    {
      from: 'sched', to: 'train', label: 'monthly run: validate + train', pc: ['validate(data)', 'model = train'],
      title: 'The pipeline retrains',
      caption: 'On the 1st of each month the orchestrator validates the new data (schema, missing values, ranges) and trains on the last two years.',
      text: ['Google Cloud\'s MLOps guide calls automated retraining in production with fresh data "continuous training", and puts data and model validation inside the pipeline.'],
      payloadKind: 'Run config',
      payload: { window: '2024-11 → 2026-10', rows: 4200000, data_checks: { schema: 'ok', null_rate: 0.002 }, params: { model: 'gbdt', depth: 8, lr: 0.05 } }
    },
    {
      from: 'train', to: 'track', label: 'log params, MAPE 11.8%, register v8', pc: ['mlflow.log_params', 'register_model'],
      title: 'Track the run and register a version',
      caption: 'Parameters, metrics, the data window and the model file are logged. The model is registered as version 8 of "demand". Nothing is deployed yet.',
      text: [],
      payloadKind: 'Registry',
      payload: { model: 'demand', version: 8, run_id: 'a1f3…', metrics: { mape_holdout: 0.118 }, champion: { version: 7, mape_holdout: 0.124 } }
    },
    {
      from: 'track', to: 'srv', label: 'canary: v8 gets 5% of traffic', pc: ['serving.split'],
      title: 'Deploy to a small slice',
      caption: 'Offline wins are not enough. v8 serves 5% of requests for a week while v7 keeps 95%, and both predictions are logged.',
      text: [],
      payloadKind: 'Traffic split',
      payload: { v7: '95%', v8: '5%', duration: '7 days', guardrail: 'rollback if p99 latency > 80 ms or errors > 1%' }
    },
    {
      from: 'app', to: 'srv', label: 'POST /predict {sku, store, week}', pc: ['serving.split'],
      title: 'Live predictions',
      caption: 'The shop asks for next week\'s demand. The request is routed by hash of the store id, so a store always gets the same version during the test.',
      text: [],
      payloadKind: 'Prediction',
      payload: { request: { sku: 'MUG-RED', store: 'LLN', week: '2026-W49' }, version: 'v8', units: 42 }
    },
    {
      from: 'srv', to: 'mon', async: true, label: 'actual sales arrive → live MAPE', pc: ['live_mape'],
      title: 'Compare live error once truth arrives',
      caption: 'A week later real sales are known. v8\'s live error is lower than v7\'s.',
      text: [],
      payloadKind: 'Live comparison',
      payload: { v7_live_mape: 0.131, v8_live_mape: 0.122, requests: { v7: 950000, v8: 50000 } },
      branch: { q: 'Is v8 at least as good live?', options: [ { label: 'yes: promote', goto: 'promote' }, { label: 'no: roll back', goto: 'rollback' } ] }
    },
    {
      id: 'rollback', path: 'rollback', from: 'mon', to: 'srv', label: 'route 100% back to v7', pc: ['serving.split'],
      title: 'Other outcome: roll back',
      caption: 'If v8 were worse, traffic goes back to v7 in one config change. The registry keeps v8 for analysis.',
      text: [],
      payloadKind: 'Rollback',
      payload: { v7: '100%', v8: '0%', took_s: 20 },
      next: 'drift'
    },
    {
      id: 'promote', from: 'mon', to: 'track', label: 'set alias champion → v8', pc: ['set_registered_model_alias'],
      title: 'Promote by moving an alias',
      caption: 'The "champion" alias now points to version 8 and serving follows it. Rolling back later is moving the alias back.',
      text: ['MLflow\'s model registry uses aliases (for example @champion) as mutable pointers to a specific model version.'],
      payloadKind: 'Alias',
      payload: { model: 'demand', alias: 'champion', from: 7, to: 8 }
    },
    {
      id: 'drift', from: 'mon', to: 'sched', label: 'drift score 0.27 on "avg_price" → trigger retrain', pc: ['if drift(live_inputs'],
      title: 'Detect drift and close the loop',
      caption: 'Weeks later a price increase shifts the "avg_price" input. The monitor\'s drift score crosses the threshold and triggers the pipeline early instead of waiting for next month.',
      text: [],
      payloadKind: 'Drift report',
      payload: { feature: 'avg_price', test: 'population stability index', score: 0.27, threshold: 0.2, action: 'trigger retrain' }
    }
  ],
  decisions: [
    { q: 'How to release a new model?', options: [
      { name: 'Replace in place', verdict: 'bad', why: 'No live comparison, slow rollback.' },
      { name: 'Shadow (predict, don\'t use)', verdict: 'good', why: 'Zero risk; compares outputs before any user sees them.' },
      { name: 'Canary / A/B', verdict: 'good', why: 'Measures real outcomes on a small slice.' } ] }
  ],
  refs: [
    { label: 'Google Cloud: MLOps, continuous delivery and automation pipelines in ML', url: 'https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning' },
    { label: 'MLflow docs: Model Registry', url: 'https://mlflow.org/docs/latest/ml/model-registry/' },
    { label: 'Sculley et al. (NeurIPS 2015): Hidden technical debt in ML systems', url: 'https://papers.nips.cc/paper/2015/hash/86df7dcfd896fcaf2674f757a2463eba-Abstract.html' },
    { label: 'Evidently docs: data drift', url: 'https://docs.evidentlyai.com/' }
  ],
  verify: {
    checked: ['CI, CD and continuous training (CT) for ML systems: Google Cloud MLOps guide (read).', 'Registered model versions and aliases such as @champion: MLflow Model Registry docs (read).'],
    uncertain: ['MAPE values, PSI threshold and traffic split are illustrative.']
  }
});
