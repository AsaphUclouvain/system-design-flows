flow({
  id: 'transformer-attention',
  title: 'Inside a transformer: tokens, attention, next token',
  category: 'AI & machine learning',
  tags: ['Tokenizer', 'Embeddings + positions', 'Q / K / V', 'Scaled dot-product attention', 'Multi-head', 'Causal mask', 'Softmax over vocabulary'],
  summary: 'Every LLM flow on this site has a box labelled "model". This flow opens it. Text becomes token ids, ids become vectors, and each layer lets every token look at earlier tokens through attention: queries are compared with keys, the scores become weights, and the weights mix the values. After the last layer, a softmax over the vocabulary picks the next token. Follow "The gate is" becoming "The gate is open".',
  requirements: {
    functional: ['Turn a prompt into a probability for every possible next token.', 'Repeat to generate text one token at a time.'],
    nonFunctional: ['Parallel over all positions during training (no recurrence).', 'Each token may only use earlier tokens when generating (causal).']
  },
  estimates: ['Original Transformer base model: d_model = 512, 8 heads of size 64, feed-forward size 2048, 6 layers. Modern LLMs are far larger.'],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'text', label: 'Prompt text', sub: '"The gate is"', kind: 'client', icon: 'doc', x: 0, y: 1, desc: 'Raw characters from the user.' },
    { id: 'tok', label: 'Tokenizer', sub: 'BPE', kind: 'service', icon: 'hash', x: 1, y: 1, desc: 'Splits text into sub-word tokens and maps each to an integer id.' },
    { id: 'emb', label: 'Embedding + position', sub: 'id → vector', kind: 'service', icon: 'layers', x: 1, y: 0, desc: 'Looks up a learned vector per id and adds position information so order is known.' },
    { id: 'attn', label: 'Self-attention', sub: 'Q·Kᵀ/√d → softmax → ·V', kind: 'ai', icon: 'brain', x: 2, y: 1, desc: 'Each token builds a query; compares it with the keys of all earlier tokens; mixes their values by the resulting weights. Several heads do this in parallel.' },
    { id: 'ffn', label: 'Feed-forward', sub: 'per token MLP', kind: 'ai', icon: 'cpu', x: 3, y: 1, desc: 'Transforms each token\'s vector independently. Attention + feed-forward (with residuals and normalisation) form one layer; layers are stacked.' },
    { id: 'head', label: 'Output head', sub: 'softmax over vocab', kind: 'ai', icon: 'chart', x: 3, y: 0, desc: 'Projects the last token\'s vector to one score per vocabulary token, then softmax turns scores into probabilities.' },
    { id: 'out', label: 'Next token', sub: 'sampled', kind: 'client', icon: 'spark', x: 4, y: 1, desc: 'Picked by greedy choice or sampling (temperature, top-p), appended, and the loop repeats.' }
  ],
  pseudo: `
ids = tokenizer.encode("The gate is")          # [791, 18618, 374]
x = embed[ids] + position(0..2)                 # 3 x d_model
for layer in layers:
    Q, K, V = x@Wq, x@Wk, x@Wv                    # per head
    scores = Q @ K.T / sqrt(d_k)
    scores[j > i] = -inf                          # causal mask
    x = x + softmax(scores) @ V                   # mix earlier tokens
    x = x + ffn(x)
probs = softmax(x[-1] @ W_vocab)
next = sample(probs, temperature=0.7)           # " open"`,
  steps: [
    {
      from: 'text', to: 'tok', label: '"The gate is" → [791, 18618, 374]', pc: ['ids = tokenizer.encode'],
      title: 'Text becomes token ids',
      caption: 'A byte-pair-encoding tokenizer splits the text into frequent pieces (often whole words with their leading space) and maps each to an id in a vocabulary of tens of thousands to a few hundred thousand.',
      text: [],
      payloadKind: 'Tokens',
      payload: { tokens: ['The', ' gate', ' is'], ids: [791, 18618, 374], note: 'ids depend on the tokenizer' }
    },
    {
      from: 'tok', to: 'emb', label: '3 ids → 3 vectors of 512 numbers', pc: ['x = embed[ids] + position'],
      title: 'Ids become vectors, plus position',
      caption: 'Each id selects a learned row of an embedding table. Position information is added, otherwise "gate is the" and "the gate is" would look identical to attention.',
      text: ['The original paper used fixed sine/cosine position encodings; many current models use rotary position embeddings instead.'],
      payloadKind: 'Embeddings (truncated)',
      payload: { shape: [3, 512], row_0_The: [0.12, -0.53, 0.07, '…'], row_1_gate: [-0.31, 0.44, 0.9, '…'], plus: 'position(0), position(1), position(2)' }
    },
    {
      from: 'emb', to: 'attn', label: 'Q, K, V per head (8 heads × 64)', pc: ['Q, K, V = x@Wq', 'scores = Q @ K.T'],
      title: 'Queries meet keys',
      caption: 'For " is", its query is compared (dot product) with the keys of "The", " gate" and itself. Scores are divided by √64 = 8 so they stay in a range where softmax still gives useful gradients.',
      text: [],
      payloadKind: 'Scores for token " is" (head 3)',
      payload: { query_token: ' is', raw_scores: { The: 1.6, ' gate': 6.4, ' is': 2.4 }, scaled_by: 8, scaled: { The: 0.2, ' gate': 0.8, ' is': 0.3 } }
    },
    {
      from: 'attn', to: 'attn', label: 'mask future, softmax → weights, mix V', pc: ['scores[j > i] = -inf', 'x = x + softmax(scores) @ V'],
      title: 'Mask, softmax, mix the values',
      caption: 'Positions after the current token are set to −∞ so a token can never peek ahead. Softmax turns scores into weights that sum to 1, and the output for " is" is the weighted mix of the three value vectors. In this head " is" attends mostly to " gate": it has learned what the sentence is about.',
      text: ['Eight heads do this in parallel with different learned projections, so different heads can track different relations (subject, previous word, and so on). Their outputs are concatenated.'],
      payloadKind: 'Attention weights (head 3)',
      payload: { The: 0.27, ' gate': 0.4, ' is': 0.33, sum: 1.0, masked_positions: 'none after " is" yet' }
    },
    {
      from: 'attn', to: 'ffn', label: 'residual + feed-forward (2048 hidden)', pc: ['x = x + ffn(x)'],
      title: 'Feed-forward, then the next layer',
      caption: 'Each token\'s vector goes through a small two-layer network. The result is added back (residual connection). This attention + feed-forward block repeats for every layer: 6 in the original base model, dozens in modern LLMs.',
      text: [],
      payloadKind: 'Layer',
      payload: { layer: '1 of 6', d_model: 512, d_ff: 2048, residual: true, norm: 'layer norm' }
    },
    {
      from: 'ffn', to: 'head', label: 'last vector → scores for every token', pc: ['probs = softmax'],
      title: 'Scores over the whole vocabulary',
      caption: 'Only the last position\'s vector is needed to predict what comes next. It is projected to one score per vocabulary token; softmax turns them into probabilities.',
      text: [],
      payloadKind: 'Top probabilities',
      payload: { ' open': 0.31, ' closed': 0.22, ' locked': 0.09, ' made': 0.04, '…': '…' },
      branch: { q: 'How is the token chosen?', options: [ { label: 'sampling (temperature 0.7)', goto: 'samp' }, { label: 'greedy (always the top one)', goto: 'greedy' } ] }
    },
    {
      id: 'greedy', path: 'greedy', from: 'head', to: 'out', label: 'argmax → " open"', pc: ['next = sample'],
      title: 'Other outcome: greedy decoding',
      caption: 'Always taking the most likely token is deterministic. It is fine for short factual answers but tends to repeat itself in long text.',
      text: [],
      payloadKind: 'Choice',
      payload: { method: 'greedy', token: ' open', p: 0.31 },
      next: 'loop'
    },
    {
      id: 'samp', from: 'head', to: 'out', label: 'sample → " open"', pc: ['next = sample'],
      title: 'Sample the next token',
      caption: 'Temperature reshapes the distribution (lower = more focused) and a token is drawn at random from it. This time it is " open"; another run might say " closed".',
      text: [],
      payloadKind: 'Choice',
      payload: { method: 'sampling', temperature: 0.7, token: ' open' }
    },
    {
      id: 'loop', from: 'out', to: 'tok', label: 'append → "The gate is open" → repeat', pc: ['ids = tokenizer.encode'],
      title: 'Append and repeat',
      caption: 'The new token is appended and the model runs again for the next one. In serving, the keys and values of earlier tokens are kept in a KV cache so only the new token is computed (see the LLM inference serving flow).',
      text: [],
      payloadKind: 'Generation',
      payload: { text: 'The gate is open', ids: [791, 18618, 374, 1825], next_step: 'predict token 5' }
    }
  ],
  decisions: [
    { q: 'Why attention instead of recurrence (RNNs)?', options: [
      { name: 'Attention', verdict: 'good', why: 'Every position is processed in parallel during training, and any two tokens are one step apart.' },
      { name: 'RNN', verdict: 'ok', why: 'Constant memory per step, but sequential and weak on long-range dependencies.' } ] }
  ],
  refs: [
    { label: 'Vaswani et al., Attention Is All You Need (arXiv 1706.03762)', url: 'https://arxiv.org/abs/1706.03762' },
    { label: 'Jay Alammar: The Illustrated Transformer', url: 'https://jalammar.github.io/illustrated-transformer/' },
    { label: 'Hugging Face LLM Course: How do Transformers work?', url: 'https://huggingface.co/learn/llm-course/chapter1/4' },
    { label: 'Su et al., RoFormer: Rotary Position Embedding (arXiv 2104.09864)', url: 'https://arxiv.org/abs/2104.09864' }
  ],
  verify: {
    checked: ['Attention(Q,K,V) = softmax(QKᵀ/√d_k)V, h = 8 heads, d_k = 64, d_model = 512, d_ff = 2048, 6 layers, masking future positions with −∞: Attention Is All You Need.', 'Rotary position embeddings: RoFormer paper.'],
    uncertain: ['Token ids, scores, weights and probabilities are made-up examples for readability (the ids are not from a specific tokenizer).']
  }
});
