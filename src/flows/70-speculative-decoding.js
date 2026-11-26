flow({
  id: 'speculative-decoding',
  title: 'Speculative decoding: draft fast, verify in one pass',
  category: 'AI & machine learning',
  tags: ['Memory-bound decoding', 'Draft model', 'Parallel verification', 'Acceptance / rejection sampling', 'Same output distribution', 'Medusa heads'],
  summary: 'Generating K tokens normally takes K slow passes of the big model, one after another. Speculative decoding lets a small draft model guess the next few tokens, then the big model checks all the guesses in one pass, keeping the longest correct run plus one token of its own. The output is provably the same as the big model alone, just faster.',
  requirements: {
    functional: ['Generate text from a large target model.'],
    nonFunctional: ['Lower time per output token without changing what the model would output.', 'Extra GPU memory for the draft model must be small.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'app', label: 'Serving engine', sub: 'vLLM / TensorRT-LLM', kind: 'service', icon: 'server', x: 0, y: 1, desc: 'Runs the draft-then-verify loop for each sequence.' },
    { id: 'draft', label: 'Draft model', sub: '1B params, fast', kind: 'ai', icon: 'spark', x: 1, y: 0, desc: 'A small model with the same tokenizer. Cheap to run, often right on easy tokens.' },
    { id: 'target', label: 'Target model', sub: '70B params', kind: 'ai', icon: 'brain', x: 2, y: 1, desc: 'The model whose output we want. Checking 5 tokens costs about the same as producing 1, because decoding is limited by reading the weights from memory, not by arithmetic.' },
    { id: 'acc', label: 'Accept / reject', sub: 'rejection sampling', kind: 'worker', icon: 'check', x: 3, y: 1, desc: 'Compares draft and target probabilities token by token and keeps the longest accepted run.' },
    { id: 'out', label: 'Output stream', sub: 'to the user', kind: 'client', icon: 'browser', x: 3, y: 2, desc: 'Receives accepted tokens.' }
  ],
  pseudo: `
while not done:
    guesses = draft.generate(prefix, k=5)          # 5 cheap serial steps
    p = target.forward(prefix + guesses)           # ONE big pass, 6 positions
    for i, g in enumerate(guesses):
        if random() < min(1, p[i][g] / q[i][g]):   # accept with prob p/q
            prefix.append(g)
        else:
            prefix.append(sample(norm(max(0, p[i] - q[i]))))  # fix-up token
            break
    else:
        prefix.append(sample(p[k]))                # bonus token`,
  steps: [
    {
      from: 'app', to: 'draft', label: 'prefix: "The capital of Belgium is"', pc: ['guesses = draft.generate'],
      title: 'The draft model guesses 5 tokens',
      caption: 'The small model runs 5 quick steps and proposes " Brussels , which is also". Each guess comes with the draft\'s probability q.',
      text: ['Leviathan et al. (2022) observe that hard language-modeling tasks contain easier subtasks a smaller model can approximate well.'],
      payloadKind: 'Draft',
      payload: { guesses: [' Brussels', ',', ' which', ' is', ' also'], q: [0.92, 0.81, 0.40, 0.66, 0.30], draft_ms: 6 }
    },
    {
      from: 'app', to: 'target', label: 'verify prefix + 5 guesses in 1 pass', pc: ['p = target.forward'],
      title: 'The big model checks all guesses at once',
      caption: 'Like a prefill, the target processes all 5 guessed positions in parallel and returns its own probability p at every position, plus one extra position after the last guess.',
      text: ['Decoding one token at a time is memory-bandwidth bound: the GPU spends most of each step loading weights. Scoring 6 positions instead of 1 barely changes the step time.'],
      payloadKind: 'Target probabilities',
      payload: { p_of_guess: [0.97, 0.88, 0.05, '—', '—'], target_ms: 24 }
    },
    {
      from: 'target', to: 'acc', label: 'accept " Brussels" "," … reject " which"', pc: ['if random() < min(1, p[i][g] / q[i][g])'],
      title: 'Accept the longest agreeing run',
      caption: '" Brussels" and "," pass (p ≥ q). " which" fails: the target gives it only 0.05 against the draft\'s 0.40, so it is rejected with high probability, and the rest is thrown away.',
      text: [],
      payloadKind: 'Decision',
      payload: { accepted: [' Brussels', ','], rejected_at: 2, discarded: [' is', ' also'] },
      branch: { q: 'Were all 5 guesses accepted?', options: [ { label: 'no: add a fix-up token', goto: 'fix' }, { label: 'yes: add a bonus token', goto: 'bonus' } ] }
    },
    {
      id: 'fix', from: 'acc', to: 'out', label: '+ " the" (sampled from p − q)', pc: ['prefix.append(sample(norm(max(0, p[i] - q[i]))))'],
      title: 'Fix-up token from the target',
      caption: 'At the rejected position, a replacement is sampled from the normalised difference between the target and draft distributions. This correction is what keeps the output distribution exactly the target\'s.',
      text: [],
      payloadKind: 'Emitted this round',
      payload: { tokens: [' Brussels', ',', ' the'], target_passes: 1, speedup_this_round: '3 tokens for ~1 target pass' },
      next: 'loop'
    },
    {
      id: 'bonus', path: 'all accepted', from: 'acc', to: 'out', label: '+ bonus token from position 6', pc: ['prefix.append(sample(p[k]))'],
      title: 'Other outcome: everything accepted',
      caption: 'When all 5 guesses pass, the target\'s extra position gives a 6th token for free: 6 tokens from one target pass.',
      text: [],
      payloadKind: 'Emitted',
      payload: { tokens: 6, target_passes: 1 },
      next: 'loop'
    },
    {
      id: 'loop', from: 'app', to: 'draft', label: 'next round from "…Brussels, the"', pc: ['while not done'],
      title: 'Repeat',
      caption: 'The loop restarts from the new prefix. Over a whole answer the paper measured 2–3× faster generation on T5-XXL with identical outputs; the gain depends on how often the draft is right.',
      text: ['Variants avoid a separate draft model: Medusa adds extra decoding heads to the target that predict several future tokens; n-gram or prompt-lookup drafting copies likely spans from the prompt.'],
      payloadKind: 'Run stats',
      payload: { mean_accepted_per_round: 2.6, rounds: 81, tokens: 292, plain_decoding_passes_needed: 292, target_passes_used: 81 }
    }
  ],
  decisions: [
    { q: 'Where do drafts come from?', options: [
      { name: 'Separate small model', verdict: 'good', why: 'Original method; needs a compatible model and extra memory.' },
      { name: 'Extra heads (Medusa / EAGLE)', verdict: 'good', why: 'No second model; heads are trained on the target.' },
      { name: 'Prompt lookup / n-grams', verdict: 'good', why: 'Free; great when output repeats the input (code edits, summaries).' } ] }
  ],
  refs: [
    { label: 'Leviathan et al. (2022): Fast inference from transformers via speculative decoding', url: 'https://arxiv.org/abs/2211.17192' },
    { label: 'Cai et al. (2024): Medusa, multiple decoding heads', url: 'https://arxiv.org/abs/2401.10774' },
    { label: 'vLLM docs: Speculative decoding', url: 'https://docs.vllm.ai/en/latest/features/spec_decode.html' }
  ],
  verify: {
    checked: ['K tokens take K serial runs; draft + parallel verification; same output distribution; 2–3× on T5-XXL with identical outputs: Leviathan et al. abstract.', 'Medusa: extra decoding heads, tree attention, motivated by moving parameters from HBM each step: Medusa abstract.'],
    uncertain: ['The acceptance rule shown (accept with probability min(1, p/q), fix-up from max(0, p−q)) follows the paper\'s method as commonly described; check the paper for the exact algorithm.', 'All probabilities, timings and counts are illustrative.']
  }
});
