flow({
  id: 'react-agent',
  title: 'ReAct: reason, act, observe (and reflect on failure)',
  category: 'AI & machine learning',
  tags: ['Thought / Action / Observation', 'Interleaved reasoning', 'Grounding in tool results', 'Reflexion', 'Stop condition'],
  summary: 'ReAct is the pattern under most agents: the model writes a short thought, picks one action, reads the observation, and repeats. Follow a multi-hop question where the first search misses, the agent notices and adjusts, and a final self-check catches an error before answering.',
  requirements: {
    functional: ['Answer questions that need several lookups in a row, where each lookup depends on the last result.'],
    nonFunctional: ['Every fact in the answer comes from an observation, not from the model\'s memory.', 'Stops after 8 actions.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'User', sub: 'question', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Asks a question no single lookup answers.' },
    { id: 'agent', label: 'ReAct loop', sub: 'controller', kind: 'service', icon: 'robot', x: 1, y: 1, desc: 'Appends Thought, Action and Observation lines to one growing transcript and sends it back to the model each time.' },
    { id: 'llm', label: 'LLM', sub: 'writes thoughts + actions', kind: 'ai', icon: 'brain', x: 1, y: 0, desc: 'Generates the next Thought and Action given the transcript so far.' },
    { id: 'search', label: 'search[]', sub: 'Wikipedia-style API', kind: 'external', icon: 'search', x: 3, y: 0, desc: 'Returns the first paragraph of the best matching page, or similar titles if there is no exact match.' },
    { id: 'calc', label: 'calculate[]', sub: 'Python sandbox', kind: 'worker', icon: 'cpu', x: 3, y: 2, desc: 'Evaluates arithmetic exactly, because models make arithmetic slips.' },
    { id: 'mem', label: 'Reflection notes', sub: 'Reflexion memory', kind: 'cache', icon: 'doc', x: 2, y: 2, desc: 'Short lessons the agent writes after a failed attempt, given to the next attempt.' }
  ],
  pseudo: `
transcript = PROMPT + "Question: " + q
for i in range(8):
    step = llm(transcript, stop=["Observation:"])   # Thought + Action
    transcript += step
    action, arg = parse(step)                  # e.g. search["Atomium"]
    if action == "finish": break
    obs = TOOLS[action](arg)
    transcript += "Observation: " + obs
check = llm("Verify each number against the observations:" + transcript)
if not check.ok: lessons.add(check.note); retry()`,
  steps: [
    {
      from: 'user', to: 'agent', label: '"How much older is the Atomium than someone born in 2005?"', pc: ['transcript = PROMPT'],
      title: 'A multi-hop question',
      caption: 'One fact is missing (when the Atomium was built), then arithmetic is needed. The model should look the fact up, not recall it.',
      text: ['Yao et al. (2022) showed that interleaving reasoning traces with actions beat both reasoning-only (chain of thought, which can hallucinate facts) and acting-only baselines on question answering and decision-making tasks.'],
      payloadKind: 'Question',
      payload: { q: 'How many years older is the Atomium than a person born in 2005?' }
    },
    {
      from: 'agent', to: 'llm', label: 'transcript so far', pc: ['step = llm(transcript'],
      title: 'The model thinks, then picks one action',
      caption: 'The model writes a Thought and an Action, then generation is stopped at "Observation:" so it cannot invent the result itself.',
      text: [],
      payloadKind: 'Model output',
      payload: 'Thought: I need the year the Atomium was built.\nAction: search["Atomium construction"]'
    },
    {
      from: 'agent', to: 'search', label: 'search["Atomium construction"]', pc: ['obs = TOOLS[action](arg)'],
      title: 'Act: the first search misses',
      caption: 'No page has that exact title. The tool returns similar titles instead of facts.',
      text: [],
      payloadKind: 'Observation',
      payload: 'Observation: Could not find "Atomium construction". Similar: ["Atomium", "Expo 58", "Heysel Plateau"]'
    },
    {
      from: 'agent', to: 'llm', label: 'Thought: use exact title', pc: ['transcript += "Observation: "'],
      title: 'Observe and adjust',
      caption: 'The observation is appended. The next Thought reacts to it: search the exact title "Atomium". This is what reasoning-only prompting cannot do.',
      text: [],
      payloadKind: 'Model output',
      payload: 'Thought: The page is called "Atomium". Search that.\nAction: search["Atomium"]'
    },
    {
      from: 'search', to: 'agent', reply: true, label: '"…built for Expo 58…"', pc: ['obs = TOOLS[action](arg)'],
      title: 'A useful observation',
      caption: 'The paragraph says it was built for the 1958 Brussels World\'s Fair (Expo 58). The fact now sits in the transcript, where it can be checked later.',
      text: [],
      payloadKind: 'Observation',
      payload: 'Observation: The Atomium is a landmark in Brussels, built for the 1958 Brussels World\'s Fair (Expo 58)…'
    },
    {
      from: 'agent', to: 'calc', label: 'calculate["2005 - 1958"]', pc: ['obs = TOOLS[action](arg)'],
      title: 'Act: compute instead of guessing',
      caption: 'The model asks the sandbox for the subtraction rather than doing it in its head. Observation: 47.',
      text: [],
      payloadKind: 'Observation',
      payload: 'Action: calculate["2005 - 1958"]\nObservation: 47'
    },
    {
      from: 'agent', to: 'llm', label: 'self-check every number', pc: ['check = llm('],
      title: 'Verify before answering',
      caption: 'A final pass asks the model to tie every number in the draft answer to an observation. 1958 and 47 are both grounded.',
      text: ['Reflexion (Shinn et al., 2023) adds this kind of self-evaluation: after a failed attempt the agent writes a verbal lesson and keeps it in memory for the next attempt, without retraining.'],
      payloadKind: 'Check',
      payload: { claims: [{ value: '1958', source: 'Observation 2' }, { value: '47', source: 'Observation 3' }], ok: true },
      branch: { q: 'Did the check pass?', options: [ { label: 'yes: finish', goto: 'fin' }, { label: 'no: write a lesson and retry', goto: 'lesson' } ] }
    },
    {
      id: 'lesson', path: 'reflexion', from: 'agent', to: 'mem', label: 'lesson: "use exact page titles"', pc: ['lessons.add'],
      title: 'Other outcome: learn from the miss',
      caption: 'If the check had failed, the agent would store a one-line lesson (for example "search exact page titles first") and start a new attempt with it in the prompt.',
      text: [],
      payloadKind: 'Reflection',
      payload: { attempt: 1, lesson: 'Search the exact page title first; use calculate[] for arithmetic.' },
      next: 'fin'
    },
    {
      id: 'fin', from: 'agent', to: 'user', reply: true, label: 'Action: finish["47 years"]', pc: ['if action == "finish"'],
      title: 'Finish',
      caption: 'The model emits the special finish action and the loop returns its argument: 47 years. Four actions used of eight.',
      text: [],
      payloadKind: 'Answer',
      payload: { answer: '47 years (Atomium: 1958, Expo 58).', actions_used: 4 }
    }
  ],
  decisions: [
    { q: 'Text ReAct or native tool calling?', options: [
      { name: 'Text format (Thought/Action lines)', verdict: 'good', why: 'The original paper\'s format; works with any completion model but needs a parser.' },
      { name: 'Native tool calls', verdict: 'great', why: 'Same loop with structured tool_use blocks; no parsing errors. Most production agents do this.' } ] }
  ],
  refs: [
    { label: 'Yao et al. (2022): ReAct: Synergizing reasoning and acting in language models', url: 'https://arxiv.org/abs/2210.03629' },
    { label: 'Shinn et al. (2023): Reflexion: language agents with verbal reinforcement learning', url: 'https://arxiv.org/abs/2303.11366' },
    { label: 'Wei et al. (2022): Chain-of-thought prompting', url: 'https://arxiv.org/abs/2201.11903' },
    { label: 'Wikipedia: Atomium (the fact used in this example)', url: 'https://en.wikipedia.org/wiki/Atomium' },
    { label: 'ByteByteGo: Top AI agentic workflow patterns', url: 'https://blog.bytebytego.com/p/top-ai-agentic-workflow-patterns' }
  ],
  verify: {
    checked: ['Interleaved thought/action/observation and its advantage over reasoning-only and acting-only: ReAct abstract.', 'search[] returning similar titles and finish[] action: ReAct paper\'s Wikipedia action space.', 'Verbal self-reflection stored in memory: Reflexion abstract.', 'Atomium built for Expo 58 (1958): Wikipedia article on the Atomium.'],
    uncertain: ['The calculate[] tool and the final self-check are additions of this example; the original ReAct action space had search, lookup and finish.']
  }
});
