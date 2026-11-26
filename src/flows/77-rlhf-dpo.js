flow({
  id: 'rlhf-dpo',
  title: 'Post-training: SFT, preference data, RLHF and DPO',
  category: 'AI & machine learning',
  tags: ['Supervised fine-tuning', 'Preference pairs', 'Reward model', 'PPO with KL penalty', 'DPO (no reward model)', 'Reward hacking'],
  summary: 'A pretrained model predicts text; it does not follow instructions or know which answer people prefer. Follow the post-training pipeline used for chat models: demonstrations for supervised fine-tuning, human comparisons of two answers, then either RLHF (train a reward model and optimise against it with PPO, held close to the original by a KL penalty) or DPO (learn directly from the pairs with a classification-style loss).',
  requirements: {
    functional: ['Turn a pretrained model into an assistant that follows instructions helpfully and harmlessly.'],
    nonFunctional: ['Do not drift so far from the base model that fluency or knowledge degrade.', 'Training stable enough to reproduce.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'lab', label: 'Labelers', sub: 'write + compare', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Write ideal answers to prompts, and pick the better of two model answers.' },
    { id: 'sft', label: 'SFT model', sub: 'policy start', kind: 'ai', icon: 'brain', x: 1, y: 1, desc: 'The pretrained model fine-tuned on demonstrations. It also generates the answer pairs labelers compare.' },
    { id: 'pairs', label: 'Preference data', sub: 'prompt, chosen, rejected', kind: 'db', icon: 'vote', x: 1, y: 2, desc: 'Hundreds of thousands of comparisons.' },
    { id: 'rm', label: 'Reward model', sub: 'scores an answer', kind: 'ai', icon: 'gauge', x: 2, y: 0, desc: 'A model trained to give the chosen answer a higher score than the rejected one.' },
    { id: 'ppo', label: 'PPO trainer', sub: 'RL loop', kind: 'worker', icon: 'cpu', x: 3, y: 1, desc: 'Samples answers from the policy, scores them with the reward model minus a KL penalty, and updates the policy.' },
    { id: 'dpo', label: 'DPO trainer', sub: 'no RM, no sampling', kind: 'worker', icon: 'split', x: 2, y: 2, desc: 'Updates the policy directly from preference pairs, comparing its likelihoods to a frozen reference copy.' }
  ],
  pseudo: `
sft = finetune(pretrained, demonstrations)          # step 1
pairs = [(p, a, b, human_pick(a, b)) for p in prompts
         for a, b in [sft.sample(p, n=2)]]          # step 2
# RLHF
rm = train_reward(pairs)     # loss = -log sigmoid(r(chosen) - r(rejected))
for batch in prompts:
    y = policy.sample(batch)
    R = rm(batch, y) - beta * KL(policy || sft)
    policy = ppo_update(policy, R)
# DPO (alternative)
loss = -log sigmoid(beta * (logratio(policy, sft, chosen)
                            - logratio(policy, sft, rejected)))`,
  steps: [
    {
      from: 'lab', to: 'sft', label: '13k demonstrations → supervised fine-tune', pc: ['sft = finetune'],
      title: 'Step 1: show the model what good looks like',
      caption: 'Labelers write ideal answers to prompts. Fine-tuning on them teaches the format of an assistant reply.',
      text: ['InstructGPT (Ouyang et al., 2022) used labeler-written and API prompts, demonstrations for SFT, then rankings for RLHF. Its 1.3B model was preferred over the 175B GPT-3.'],
      payloadKind: 'Demonstration',
      payload: { prompt: 'Explain recursion to a 10-year-old.', ideal: 'Imagine a set of Russian dolls…' }
    },
    {
      from: 'sft', to: 'lab', label: '2 answers per prompt', pc: ['sft.sample(p, n=2)'],
      title: 'Step 2: generate pairs to compare',
      caption: 'The SFT model writes two answers to the same prompt. Comparing is easier and more consistent for people than giving absolute scores.',
      text: [],
      payloadKind: 'Pair',
      payload: { prompt: 'Is it safe to mix bleach and vinegar?', a: 'No. It releases chlorine gas…', b: 'Yes, it makes a stronger cleaner.' }
    },
    {
      from: 'lab', to: 'pairs', label: 'chosen: a, rejected: b', pc: ['human_pick(a, b)'],
      title: 'Record the preference',
      caption: 'The labeler picks a. The row stores prompt, chosen and rejected. This dataset is the shared input of both methods below.',
      text: [],
      payloadKind: 'Preference row',
      payload: { prompt: 'Is it safe to mix bleach and vinegar?', chosen: 'No. It releases chlorine gas…', rejected: 'Yes, it makes a stronger cleaner.' },
      branch: { q: 'Which optimisation?', options: [ { label: 'RLHF: reward model + PPO', goto: 'rm' }, { label: 'DPO: directly from pairs', goto: 'dpo' } ] }
    },
    {
      id: 'rm', from: 'pairs', to: 'rm', label: 'train: r(chosen) > r(rejected)', pc: ['rm = train_reward(pairs)'],
      title: 'RLHF: train a reward model',
      caption: 'A copy of the model with a scalar output learns to score the chosen answer above the rejected one. It becomes an automatic stand-in for the labelers.',
      text: [],
      payloadKind: 'Scores',
      payload: { r_chosen: 2.7, r_rejected: -1.9, loss: 0.01 }
    },
    {
      from: 'rm', to: 'ppo', label: 'reward − β·KL(policy ‖ SFT)', pc: ['R = rm(batch, y) - beta * KL'],
      title: 'RLHF: optimise the policy with PPO',
      caption: 'The policy answers fresh prompts, the reward model scores them, and PPO nudges the policy toward higher scores. The KL term penalises moving too far from the SFT model.',
      text: ['Without the KL penalty the policy can find gibberish or flattery the reward model happens to score highly (reward hacking). Hugging Face\'s RLHF explainer describes this KL term.'],
      payloadKind: 'PPO step',
      payload: { prompts: 512, mean_reward: 1.84, mean_kl: 3.1, beta: 0.02, updated: 'policy weights' },
      next: 'eval'
    },
    {
      id: 'dpo', path: 'DPO', from: 'pairs', to: 'dpo', label: 'loss from log-prob ratios vs reference', pc: ['loss = -log sigmoid(beta * (logratio'],
      title: 'DPO: skip the reward model',
      caption: 'DPO shows the same objective can be solved with a simple classification loss: raise the policy\'s probability of the chosen answer and lower the rejected one, relative to a frozen reference model. No sampling, no separate reward model.',
      text: ['Rafailov et al. (2023) report DPO is stable, performant and lightweight, matching or beating PPO-based RLHF in their experiments.'],
      payloadKind: 'DPO step',
      payload: { logp_chosen: { policy: -41.2, ref: -43.0 }, logp_rejected: { policy: -60.5, ref: -55.1 }, beta: 0.1, loss: 0.28 },
      next: 'eval'
    },
    {
      id: 'eval', from: 'ppo', to: 'lab', label: 'human eval: new vs SFT', pc: ['policy = ppo_update'],
      title: 'Evaluate with people again',
      caption: 'The final check is human preference on held-out prompts, plus safety and capability benchmarks to catch regressions (the "alignment tax").',
      text: [],
      payloadKind: 'Eval',
      payload: { win_rate_vs_sft: 0.68, truthfulness: '+', toxicity: '−', benchmark_regressions: ['minor on 2 of 12'] }
    }
  ],
  decisions: [
    { q: 'RLHF (PPO) or DPO?', options: [
      { name: 'RLHF with PPO', verdict: 'good', why: 'Flexible (online sampling, any reward), but complex: 4 models in memory, unstable.' },
      { name: 'DPO', verdict: 'good', why: 'Simple supervised-style training on pairs; widely used in open models.' } ] }
  ],
  refs: [
    { label: 'Ouyang et al. (2022): InstructGPT, training LMs to follow instructions with human feedback', url: 'https://arxiv.org/abs/2203.02155' },
    { label: 'Rafailov et al. (2023): Direct Preference Optimization', url: 'https://arxiv.org/abs/2305.18290' },
    { label: 'Hugging Face blog: Illustrating RLHF', url: 'https://huggingface.co/blog/rlhf' },
    { label: 'Hugging Face TRL docs: DPO trainer', url: 'https://huggingface.co/docs/trl/main/en/dpo_trainer' }
  ],
  verify: {
    checked: ['Demonstrations → SFT, rankings → RLHF, 1.3B preferred to 175B: InstructGPT abstract.', 'Reward model + RL with KL constraint; DPO closed-form with classification loss; stable and lightweight: DPO abstract.', 'PPO and the KL penalty against the initial model: HF RLHF blog (read).'],
    uncertain: ['The 13k demonstrations figure is approximate from the InstructGPT paper body; all scores, betas and win rates are illustrative.']
  }
});
