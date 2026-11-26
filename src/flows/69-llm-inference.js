flow({
  id: 'llm-inference-serving',
  title: 'LLM inference serving: tokens, KV cache, batching, streaming',
  category: 'AI & machine learning',
  tags: ['Tokenization', 'Prefill vs decode', 'KV cache', 'PagedAttention', 'Continuous batching', 'Prefix caching', 'SSE streaming', 'TTFT / TPOT'],
  summary: 'What happens between "send" and the first word appearing? Follow one chat request into a GPU server like vLLM: the prompt is tokenized, a shared system-prompt prefix is found in cache, the rest is processed in one parallel prefill pass, then tokens are generated one at a time while other users\' requests join and leave the same batch, and each token streams back over SSE.',
  requirements: {
    functional: ['Serve chat completions for many users on a pool of GPUs.', 'Stream tokens as they are generated.'],
    nonFunctional: ['Time to first token (TTFT) < 500 ms at p95.', 'High GPU utilization: many requests share each forward pass.', 'Fit as many concurrent sequences as GPU memory allows.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'Chat UI', sub: 'browser', kind: 'client', icon: 'browser', x: 0, y: 1, desc: 'Sends the request and renders tokens as they arrive.' },
    { id: 'api', label: 'API server', sub: 'OpenAI-compatible', kind: 'service', icon: 'api', x: 1, y: 1, desc: 'Authenticates, applies the chat template, tokenizes, and opens the SSE stream.' },
    { id: 'sched', label: 'Scheduler', sub: 'continuous batching', kind: 'worker', icon: 'clock', x: 2, y: 1, desc: 'Every iteration it decides which sequences run in the next forward pass: adds new ones, removes finished ones.' },
    { id: 'gpu', label: 'GPU worker', sub: 'model weights', kind: 'ai', icon: 'gpu', x: 3, y: 1, desc: 'Runs the transformer forward pass for the whole batch at once.' },
    { id: 'kv', label: 'KV cache blocks', sub: 'GPU memory', kind: 'cache', icon: 'layers', x: 3, y: 0, desc: 'Attention keys/values of every token seen so far, per sequence, stored in fixed-size blocks like OS memory pages.' },
    { id: 'tok', label: 'Tokenizer', sub: 'BPE vocabulary', kind: 'worker', icon: 'hash', x: 1, y: 0, desc: 'Turns text into token ids with the model\'s own vocabulary, and token ids back into text.' },
    { id: 'pfx', label: 'Prefix cache', sub: 'hash → blocks', kind: 'cache', icon: 'key', x: 2, y: 0, desc: 'Maps a hash of a token block (and everything before it) to KV blocks already computed, so identical prefixes are reused.' }
  ],
  pseudo: `
ids = tokenizer.apply_chat_template(messages)    # text -> token ids
hit = prefix_cache.match(ids)                     # reuse shared prefix
seq = Sequence(ids, kv=hit.blocks)
scheduler.add(seq)
while scheduler.running:                          # one iteration
    batch = scheduler.pick()                      # new + ongoing seqs
    logits = model.forward(batch)                 # prefill new, decode old
    for s in batch:
        tok = sample(logits[s], temperature=0.7)
        s.kv.append_block_if_full()
        stream(s, tokenizer.decode(tok))          # SSE chunk
        if tok == EOS or s.len == max_tokens: scheduler.finish(s)`,
  steps: [
    {
      from: 'user', to: 'api', label: 'POST /v1/chat/completions stream:true', pc: ['ids = tokenizer'],
      title: 'The request',
      caption: 'An OpenAI-compatible request with stream: true. The 1,200-token system prompt is the same for every user of this app.',
      text: [],
      payloadKind: 'Request',
      payload: { model: 'llama-3.1-8b-instruct', stream: true, max_tokens: 300, temperature: 0.7, messages: [{ role: 'system', content: '(1,200-token app prompt)' }, { role: 'user', content: 'Explain a KV cache in one paragraph.' }] }
    },
    {
      from: 'api', to: 'tok', label: 'chat template → 1,214 token ids', pc: ['apply_chat_template'],
      title: 'Tokenize',
      caption: 'The messages are wrapped in the model\'s chat template (special role markers) and split into subword tokens. The model only ever sees integers.',
      text: ['A token is often a word piece: "caching" may be one token or two. Prices and context limits are counted in tokens, not characters.'],
      payloadKind: 'Tokens',
      payload: { text: '…Explain a KV cache in one paragraph.', ids: ['…', 849, 21435, 264, 85748, 6636, 304, 832, 14646, 13], count: 1214 }
    },
    {
      from: 'api', to: 'pfx', label: 'match blocks of 16 tokens by hash', pc: ['hit = prefix_cache.match'],
      title: 'Reuse the shared prefix',
      caption: 'The ids are cut into blocks; each block\'s hash includes all earlier tokens. The first 75 blocks (1,200 tokens of system prompt) are already in the cache from other users.',
      text: ['vLLM calls this automatic prefix caching. Hosted APIs offer the same idea as "prompt caching", billed cheaper for cached input tokens.'],
      payloadKind: 'Cache match',
      payload: { block_size: 16, blocks: 76, cached_blocks: 75, tokens_to_compute: 14 },
      branch: { q: 'Prefix found?', options: [ { label: 'yes: compute only 14 tokens', goto: 'add' }, { label: 'no: full prefill', goto: 'full' } ] }
    },
    {
      id: 'full', path: 'cold prefix', from: 'sched', to: 'gpu', label: 'prefill all 1,214 tokens', pc: ['logits = model.forward(batch)'],
      title: 'Other outcome: a full prefill',
      caption: 'Without a cache hit, all 1,214 tokens go through the model in one parallel pass. That is compute-heavy and is most of the time to first token for long prompts.',
      text: [],
      payloadKind: 'Prefill',
      payload: { tokens: 1214, ttft_ms: 380 },
      next: 'decode'
    },
    {
      id: 'add', from: 'api', to: 'sched', label: 'add sequence #5531', pc: ['scheduler.add(seq)'],
      title: 'Join the running batch',
      caption: 'The scheduler does not wait for a batch to finish. At the next iteration it adds the new sequence alongside 37 others that are mid-answer.',
      text: ['This iteration-level scheduling was introduced by Orca (OSDI 2022) and is usually called continuous batching. Static batching made short answers wait for the longest one in their batch.'],
      payloadKind: 'Scheduler state',
      payload: { running: 38, waiting: 0, new: ['#5531 (prefill 14 tokens)'], finished_this_step: ['#5502'] }
    },
    {
      id: 'decode', from: 'sched', to: 'gpu', label: 'forward(batch of 38)', pc: ['batch = scheduler.pick()', 'logits = model.forward(batch)'],
      title: 'One forward pass for everyone',
      caption: 'In one iteration the GPU prefills #5531\'s 14 new tokens and produces the next token for the 37 others. Reading the weights once for 38 sequences is what makes batching efficient.',
      text: [],
      payloadKind: 'Iteration',
      payload: { iteration: 90412, prefill_tokens: 14, decode_tokens: 37, step_ms: 21 }
    },
    {
      from: 'gpu', to: 'kv', label: 'append K,V; new block when full', pc: ['s.kv.append_block_if_full()'],
      title: 'Grow the KV cache in pages',
      caption: 'Each new token adds its keys and values. Instead of reserving room for 300 tokens up front, a new 16-token block is allocated only when the last one fills, anywhere in GPU memory.',
      text: ['PagedAttention (the vLLM paper) borrows OS paging: a block table maps a sequence\'s logical blocks to physical ones. It reports near-zero KV waste and 2–4× throughput over earlier systems.'],
      payloadKind: 'Block table #5531',
      payload: { logical: [0, 1, '…', 75, 76], physical: ['shared 812', 'shared 813', '…', 'shared 991', 'own 2207'], free_blocks: 1840 },
      failure: 'If GPU memory runs out of blocks, the scheduler preempts a sequence: frees its blocks and recomputes (or swaps to CPU) later.'
    },
    {
      from: 'api', to: 'user', reply: true, label: 'SSE: data: {"delta":"A KV"}', pc: ['stream(s, tokenizer.decode(tok))'],
      title: 'Stream each token',
      caption: 'Each sampled token is detokenized and sent as an SSE chunk. The first one arrived 140 ms after the request (TTFT); the rest come every ~21 ms (time per output token).',
      text: [],
      payloadKind: 'SSE stream',
      payload: 'data: {"choices":[{"delta":{"content":"A KV"}}]}\n\ndata: {"choices":[{"delta":{"content":" cache"}}]}\n\n…\n\ndata: [DONE]'
    },
    {
      from: 'sched', to: 'kv', label: 'EOS → free own blocks, keep shared', pc: ['if tok == EOS', 'scheduler.finish(s)'],
      title: 'Finish and free memory',
      caption: 'After 212 tokens the model emits end-of-sequence. The sequence\'s own blocks are freed for others; the shared prefix blocks stay cached for the next user.',
      text: [],
      payloadKind: 'Done',
      payload: { output_tokens: 212, finish_reason: 'stop', ttft_ms: 140, tpot_ms: 21, blocks_freed: 14 }
    }
  ],
  decisions: [
    { q: 'How to batch?', options: [
      { name: 'Static batching', verdict: 'bad', why: 'Short requests wait for the longest in the batch; GPU idles as sequences finish.' },
      { name: 'Continuous batching', verdict: 'great', why: 'Sequences join and leave every iteration; standard in vLLM, TGI, TensorRT-LLM.' } ] },
    { q: 'Optimise for what?', options: [
      { name: 'Latency (TTFT, TPOT)', verdict: 'good', why: 'Smaller batches, chat products.' },
      { name: 'Throughput (tokens/s/GPU)', verdict: 'good', why: 'Larger batches, offline jobs. The batch size is the dial between them.' } ] }
  ],
  refs: [
    { label: 'Kwon et al. (2023): Efficient memory management for LLM serving with PagedAttention (vLLM)', url: 'https://arxiv.org/abs/2309.06180' },
    { label: 'Yu et al., OSDI 2022: Orca, iteration-level scheduling', url: 'https://www.usenix.org/conference/osdi22/presentation/yu' },
    { label: 'vLLM docs: Automatic prefix caching', url: 'https://docs.vllm.ai/en/latest/design/prefix_caching.html' },
    { label: 'Hugging Face: Summary of the tokenizers', url: 'https://huggingface.co/docs/transformers/tokenizer_summary' },
    { label: 'OpenAI docs: Streaming API responses', url: 'https://platform.openai.com/docs/guides/streaming-responses' },
    { label: 'ByteByteGo: How LLMs see the world (tokens)', url: 'https://blog.bytebytego.com/p/how-llms-see-the-world' }
  ],
  verify: {
    checked: ['KV cache grows and shrinks per request; PagedAttention inspired by OS paging; near-zero waste; 2–4× throughput vs FasterTransformer and Orca: vLLM abstract.', 'Iteration-level scheduling: Orca OSDI 2022 page.', 'Block hashing that includes prefix tokens: vLLM prefix-caching design doc.'],
    uncertain: ['Token ids, timings, batch sizes and block numbers are illustrative; the block size of 16 is vLLM\'s common default, not universal.', 'The SSE chunk is simplified (real chunks carry id, model and index fields).']
  }
});
