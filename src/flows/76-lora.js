flow({
  id: 'lora-finetuning',
  title: 'Fine-tuning with LoRA / QLoRA: from dataset to served adapter',
  category: 'AI & machine learning',
  tags: ['Instruction dataset', 'Frozen base weights', 'Low-rank adapters (A·B)', '4-bit quantization (QLoRA)', 'Eval before ship', 'Multi-adapter serving'],
  summary: 'Fine-tuning every weight of a big model needs many GPUs and a full copy per task. LoRA freezes the model and trains two tiny matrices per layer instead. Follow a team turning 4,000 support chats into a LoRA adapter on one GPU, evaluating it against the base model, and serving it next to other adapters on the same base.',
  requirements: {
    functional: ['Teach an open model the company\'s tone and product facts from past support chats.'],
    nonFunctional: ['Train on a single 48 GB GPU.', 'Adapter file in megabytes, not a full model copy.', 'No regression on a held-out eval set before release.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'data', label: 'Dataset builder', sub: 'chats → JSONL', kind: 'worker', icon: 'filter', x: 0, y: 1, desc: 'Cleans past chats, removes personal data, formats them as prompt/response pairs, splits train and test.' },
    { id: 'base', label: 'Base model', sub: '8B, frozen, 4-bit', kind: 'storage', icon: 'box', x: 1, y: 0, desc: 'The pretrained weights. Never updated. In QLoRA they are stored in 4-bit NF4 to save memory.' },
    { id: 'train', label: 'Trainer', sub: 'PEFT on 1 GPU', kind: 'ai', icon: 'gpu', x: 1, y: 1, desc: 'Runs forward and backward passes; gradients flow through the frozen weights into the adapters only.' },
    { id: 'eval', label: 'Eval harness', sub: 'held-out set', kind: 'worker', icon: 'check', x: 2, y: 2, desc: 'Compares base vs base+adapter on unseen chats with automatic metrics and an LLM judge.' },
    { id: 'reg', label: 'Adapter registry', sub: 'object storage', kind: 'storage', icon: 'folder', x: 3, y: 1, desc: 'Versioned adapter files with their eval scores.' },
    { id: 'srv', label: 'Inference server', sub: 'multi-LoRA', kind: 'service', icon: 'server', x: 3, y: 0, desc: 'One copy of the base model in GPU memory, many small adapters loaded on demand per request.' }
  ],
  pseudo: `
ds = load_jsonl("support.jsonl").train_test_split(test_size=0.1)
base = load("llama-8b", quantization="nf4")      # QLoRA: 4-bit, frozen
cfg = LoraConfig(r=16, alpha=32, target_modules=["q_proj", "v_proj"])
model = get_peft_model(base, cfg)                # adds A (d×r), B (r×d)
# W_eff = W + (alpha/r) * B @ A ; only A, B train
train(model, ds["train"], epochs=2, lr=2e-4)
score = evaluate(model, ds["test"]) - evaluate(base, ds["test"])
if score > 0: registry.push("support-v3", model.adapter)
# serve: POST {"model": "support-v3"} -> base + adapter`,
  steps: [
    {
      from: 'data', to: 'train', label: '4,000 pairs, PII removed, 90/10 split', pc: ['ds = load_jsonl'],
      title: 'Build the dataset',
      caption: 'Most of the work is here: picking good conversations, removing names and emails, and formatting each as a prompt and an ideal answer. 10% is held out for evaluation.',
      text: [],
      payloadKind: 'JSONL row',
      payload: { messages: [{ role: 'user', content: 'My MadShop order shows delivered but nothing came.' }, { role: 'assistant', content: 'Sorry about that! Couriers sometimes mark parcels early…' }] }
    },
    {
      from: 'base', to: 'train', label: 'load 8B in 4-bit NF4 (~5 GB)', pc: ['base = load('],
      title: 'Load the frozen base, quantized',
      caption: 'QLoRA stores the frozen weights in a 4-bit data type and dequantizes on the fly during computation. That is what makes big models fit on one GPU.',
      text: ['QLoRA reports fine-tuning a 65B model on a single 48 GB GPU while preserving 16-bit fine-tuning performance, using NF4, double quantization and paged optimizers.'],
      payloadKind: 'Memory',
      payload: { params: '8B', fp16_gb: 16, nf4_gb: 5, trainable: false }
    },
    {
      from: 'train', to: 'train', label: 'inject A (4096×16), B (16×4096) per layer', pc: ['cfg = LoraConfig', 'model = get_peft_model'],
      title: 'Add the low-rank adapters',
      caption: 'Next to chosen weight matrices W, LoRA adds a product B·A of rank 16. B starts at zero, so training begins exactly at the base model. Only A and B get gradients.',
      text: ['The LoRA paper reports up to 10,000× fewer trainable parameters and 3× less GPU memory than full fine-tuning of GPT-3 175B, with no extra inference latency because B·A can be merged into W.'],
      payloadKind: 'Trainable parameters',
      payload: { rank: 16, per_matrix: '2 × 4096 × 16 = 131,072', matrices: 64, trainable: '8.4M', base: '8B', share: '0.1%' }
    },
    {
      from: 'train', to: 'eval', label: '2 epochs, 3 h → adapter 34 MB', pc: ['train(model'],
      title: 'Train',
      caption: 'Two passes over the data on one GPU. The result is a 34 MB adapter file, not a new 16 GB model.',
      text: [],
      payloadKind: 'Run',
      payload: { gpu: '1 × 48 GB', hours: 3.1, train_loss: [1.92, 1.21, 1.08], adapter_mb: 34 }
    },
    {
      from: 'eval', to: 'eval', label: 'base vs adapter on 400 held-out chats', pc: ['score = evaluate'],
      title: 'Evaluate before shipping',
      caption: 'Both versions answer the same unseen prompts. An LLM judge and spot checks by the support team compare tone and correctness. Also check that general skills did not regress.',
      text: [],
      payloadKind: 'Eval',
      payload: { judge_win_rate_vs_base: 0.71, factual_errors: { base: 38, adapter: 22 }, general_benchmark_delta: -0.4 },
      branch: { q: 'Better than base without regressions?', options: [ { label: 'yes: register', goto: 'push' }, { label: 'no: fix data, retrain', goto: 'redo' } ] }
    },
    {
      id: 'redo', path: 'not good enough', from: 'eval', to: 'data', label: 'error analysis → more/better examples', pc: ['if score > 0'],
      title: 'Other outcome: back to the data',
      caption: 'If the adapter loses, the usual fix is the data (wrong labels, too few examples of a case), not the hyperparameters.',
      text: [],
      payloadKind: 'Findings',
      payload: { weak_cases: ['refund policy for EU', 'multi-item orders'], action: 'add 300 examples' },
      next: 'push'
    },
    {
      id: 'push', from: 'eval', to: 'reg', label: 'push support-v3 + scores', pc: ['registry.push'],
      title: 'Register the adapter',
      caption: 'The adapter file is versioned with its base model id, data version and eval scores, so it can be rolled back.',
      text: [],
      payloadKind: 'Registry entry',
      payload: { name: 'support-v3', base: 'llama-8b-instruct', data: 'support-2026-11', win_rate: 0.71, size_mb: 34 }
    },
    {
      from: 'reg', to: 'srv', label: 'load adapter next to 11 others on one base', pc: ['# serve'],
      title: 'Serve many adapters on one base',
      caption: 'The server keeps one base model in memory and applies the right adapter per request. Twelve teams\' fine-tunes cost about as much GPU memory as one model.',
      text: [],
      payloadKind: 'Request',
      payload: { model: 'support-v3', messages: ['…'], server: { base_loaded: 1, adapters_loaded: 12 } }
    }
  ],
  decisions: [
    { q: 'Fine-tune or RAG?', options: [
      { name: 'RAG', verdict: 'good', why: 'For facts that change: update the documents, not the model.' },
      { name: 'Fine-tune (LoRA)', verdict: 'good', why: 'For style, format and narrow skills that prompting cannot reach reliably.' } ] },
    { q: 'Full fine-tune or LoRA?', options: [
      { name: 'Full', verdict: 'ok', why: 'Most capacity; needs many GPUs and a full model copy per task.' },
      { name: 'LoRA / QLoRA', verdict: 'great', why: 'One GPU, tiny files, quality on par in the paper\'s experiments.' } ] }
  ],
  refs: [
    { label: 'Hu et al. (2021): LoRA, low-rank adaptation of LLMs', url: 'https://arxiv.org/abs/2106.09685' },
    { label: 'Dettmers et al. (2023): QLoRA', url: 'https://arxiv.org/abs/2305.14314' },
    { label: 'Hugging Face PEFT docs: LoRA', url: 'https://huggingface.co/docs/peft/main/en/conceptual_guides/lora' },
    { label: 'vLLM docs: LoRA adapters', url: 'https://docs.vllm.ai/en/latest/features/lora/' }
  ],
  verify: {
    checked: ['B initialised to zero so training starts from the base model; adapters can be merged: PEFT LoRA guide.', 'Frozen weights + trainable rank decomposition matrices, 10,000× fewer parameters, 3× less memory, no added inference latency: LoRA abstract.', '65B on one 48 GB GPU, 4-bit NF4, double quantization, paged optimizers: QLoRA abstract.'],
    uncertain: ['B initialised to zero (identity at start) and lora_alpha as the scaling factor: PEFT LoRA guide (read). The exact alpha/r formula is from the paper, not re-read.', 'Dataset size, losses, timings and win rates are illustrative.']
  }
});
