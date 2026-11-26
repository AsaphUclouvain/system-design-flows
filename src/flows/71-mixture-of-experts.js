flow({
  id: 'mixture-of-experts',
  title: 'Mixture of experts: routing each token to a few experts',
  category: 'AI & machine learning',
  tags: ['Sparse activation', 'Router / gating network', 'Top-k experts', 'Expert parallelism (all-to-all)', 'Load-balancing loss', 'Capacity factor'],
  summary: 'A mixture-of-experts layer replaces one big feed-forward block with many smaller "experts" and a router that sends each token to only a couple of them. Follow one token through an MoE layer like Mixtral\'s: the router scores 8 experts, picks 2, the token travels to the GPUs that hold them, and their outputs are blended back. The model has 47B parameters but uses about 13B per token.',
  requirements: {
    functional: ['Run a transformer layer whose feed-forward part is split into experts.'],
    nonFunctional: ['Compute per token close to a much smaller dense model.', 'Experts get roughly equal traffic, so no GPU becomes the bottleneck.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'attn', label: 'Attention block', sub: 'shared by all tokens', kind: 'service', icon: 'layers', x: 0, y: 1, desc: 'The usual self-attention. Every token uses it. Its output goes to the MoE block instead of a single feed-forward network.' },
    { id: 'router', label: 'Router', sub: 'linear layer + softmax', kind: 'edge', icon: 'route', x: 1, y: 1, desc: 'A small learned layer that scores every expert for this token and keeps the top 2.' },
    { id: 'e3', label: 'Expert 3', sub: 'FFN on GPU 1', kind: 'ai', icon: 'cpu', x: 2, y: 0, desc: 'A feed-forward network. Through training, experts tend to specialize, though not in human-readable topics.' },
    { id: 'e6', label: 'Expert 6', sub: 'FFN on GPU 3', kind: 'ai', icon: 'cpu', x: 2, y: 2, desc: 'Another feed-forward network, on another GPU.' },
    { id: 'others', label: 'Experts 1,2,4,5,7,8', sub: 'idle for this token', kind: 'storage', icon: 'box', x: 3, y: 1, desc: 'Their weights exist (and use memory) but do no work for this token.' },
    { id: 'mix', label: 'Weighted sum', sub: 'combine', kind: 'worker', icon: 'split', x: 1, y: 2, desc: 'Adds the two expert outputs weighted by the router\'s scores and passes the result to the next layer.' }
  ],
  pseudo: `
def moe_layer(x):                              # x: one token's hidden state
    logits = x @ W_router                      # 8 scores
    top2 = topk(logits, k=2)
    w = softmax(logits[top2])                  # weights over the 2 chosen
    y = sum(w[i] * experts[e](x) for i, e in enumerate(top2))
    return y
# training only:
loss += alpha * load_balance(router_probs, tokens_per_expert)`,
  steps: [
    {
      from: 'attn', to: 'router', label: 'hidden state of token " Brussels"', pc: ['def moe_layer(x)'],
      title: 'A token arrives at the MoE block',
      caption: 'After attention, the token\'s hidden vector (4,096 numbers in Mixtral) would normally go through one large feed-forward network. Here it goes to the router first.',
      text: ['Mixtral 8x7B has the same architecture as Mistral 7B except that each layer has 8 feed-forward blocks (experts).'],
      payloadKind: 'Input',
      payload: { token: ' Brussels', layer: 17, hidden: '[0.12, -0.40, …] (4096)' }
    },
    {
      from: 'router', to: 'router', label: 'scores for 8 experts → top-2: 3 and 6', pc: ['logits = x @ W_router', 'top2 = topk'],
      title: 'Score and pick the top 2',
      caption: 'The router multiplies the vector by a small matrix to get 8 scores, keeps the best 2 and turns those into weights that sum to 1.',
      text: [],
      payloadKind: 'Routing',
      payload: { logits: [0.1, -1.2, 2.3, 0.4, -0.5, 1.9, 0.0, -0.8], chosen: [3, 6], weights: { e3: 0.6, e6: 0.4 } }
    },
    {
      from: 'router', to: 'e3', label: 'all-to-all: send to GPU 1 (w=0.6)', pc: ['experts[e](x)'],
      title: 'Dispatch to the first expert',
      caption: 'With expert parallelism, different experts live on different GPUs. Tokens are exchanged in an all-to-all step: each GPU sends every token to the GPUs of its chosen experts.',
      text: ['GShard used this to scale a translation model with sparsely-gated MoE beyond 600 billion parameters. The network exchange is a major cost of MoE.'],
      payloadKind: 'Dispatch',
      payload: { to_gpu: 1, expert: 3, tokens_in_this_batch_for_e3: 512 }
    },
    {
      from: 'router', to: 'e6', label: 'all-to-all: send to GPU 3 (w=0.4)', pc: ['experts[e](x)'],
      title: 'Dispatch to the second expert',
      caption: 'The same token also goes to expert 6. The other six experts never see it.',
      text: [],
      payloadKind: 'Dispatch',
      payload: { to_gpu: 3, expert: 6, tokens_in_this_batch_for_e6: 498 },
      branch: { q: 'Is expert 6 over capacity this batch?', options: [ { label: 'no: process normally', goto: 'mix1' }, { label: 'yes: token overflows', goto: 'drop' } ] }
    },
    {
      id: 'drop', path: 'overflow', from: 'e6', to: 'mix', label: 'over capacity → skip (residual only)', pc: ['loss += alpha * load_balance'],
      title: 'Other outcome: an overloaded expert',
      caption: 'Training systems such as GShard and Switch Transformer give each expert a fixed capacity per batch. Overflow tokens skip that expert and pass through the residual connection (some systems drop them entirely). An auxiliary load-balancing loss pushes the router to spread tokens evenly so this stays rare.',
      text: [],
      payloadKind: 'Overflow',
      payload: { expert: 6, capacity: 640, assigned: 702, dropped: 62 },
      next: 'mix1'
    },
    {
      id: 'mix1', from: 'e3', to: 'mix', label: '0.6·E3(x) + 0.4·E6(x)', pc: ['y = sum(w[i] * experts[e](x)'],
      title: 'Combine the two outputs',
      caption: 'Both outputs come back through another all-to-all and are summed with the router weights. The result continues to layer 18.',
      text: [],
      payloadKind: 'Output',
      payload: { y: '[0.31, -0.07, …] (4096)', experts_used: 2, experts_total: 8 }
    },
    {
      from: 'mix', to: 'others', label: 'total 47B params, ~13B active per token', pc: ['return y'],
      title: 'Why it pays off',
      caption: 'Every token touches only 2 of 8 experts per layer. Mixtral reports 47B total parameters with 13B active per token, outperforming or matching Llama 2 70B on its benchmarks. But all 47B must sit in GPU memory.',
      text: [],
      payloadKind: 'Trade-off',
      payload: { total_params: '47B', active_params_per_token: '13B', memory_needed_for: '47B', compute_like: '13B dense' }
    }
  ],
  decisions: [
    { q: 'Top-1 or top-2 routing?', options: [
      { name: 'Top-1 (Switch Transformer)', verdict: 'good', why: 'Simplest routing and least communication.' },
      { name: 'Top-2 (Mixtral, GShard)', verdict: 'good', why: 'Blends two experts; a bit more compute and traffic per token.' } ] }
  ],
  refs: [
    { label: 'Jiang et al. (2024): Mixtral of Experts', url: 'https://arxiv.org/abs/2401.04088' },
    { label: 'Fedus et al. (2021): Switch Transformers', url: 'https://arxiv.org/abs/2101.03961' },
    { label: 'Lepikhin et al. (2020): GShard', url: 'https://arxiv.org/abs/2006.16668' },
    { label: 'Hugging Face blog: Mixture of Experts explained', url: 'https://huggingface.co/blog/moe' }
  ],
  verify: {
    checked: ['8 feed-forward experts per layer, router picks 2 per token per layer, 47B total vs 13B active, matches or beats Llama 2 70B: Mixtral abstract.', 'MoE selects different parameters per input with constant compute; simplified routing: Switch Transformers abstract.', 'Sparsely-gated MoE beyond 600B parameters with automatic sharding: GShard abstract.'],
    uncertain: ['Capacity factor, token dropping and the auxiliary load-balancing loss are from the Hugging Face MoE explainer (read), not from the paper abstracts.', 'Hidden size 4,096, the layer number, scores and token counts are illustrative.']
  }
});
