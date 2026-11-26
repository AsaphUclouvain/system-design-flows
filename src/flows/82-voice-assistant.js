flow({
  id: 'voice-assistant',
  title: 'Voice assistant: speech in, speech out, with barge-in',
  category: 'AI & machine learning',
  tags: ['WebRTC audio', 'Voice activity detection', 'Streaming ASR', 'LLM streaming', 'Streaming TTS', 'Barge-in', 'Speech-to-speech models'],
  summary: 'A voice assistant feels natural only if it answers in well under a second and stops talking when you interrupt. Follow one spoken question through a cascaded pipeline: audio over WebRTC, voice activity detection marks the end of your turn, streaming speech recognition, a streaming LLM, and text-to-speech that starts on the first sentence. Then you interrupt, and everything is cancelled.',
  requirements: {
    functional: ['Hold a spoken conversation in real time.', 'Let the user interrupt the assistant mid-sentence.'],
    nonFunctional: ['Voice-to-voice latency under ~800 ms.', 'Works on mobile networks with packet loss.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'phone', label: 'Phone app', sub: 'mic + speaker', kind: 'client', icon: 'phone', x: 0, y: 1, desc: 'Captures audio, plays the reply, and sends audio continuously, including while the assistant talks.' },
    { id: 'rtc', label: 'Media server', sub: 'WebRTC, Opus', kind: 'edge', icon: 'globe', x: 1, y: 1, desc: 'Receives 20 ms Opus audio frames over UDP, handles jitter and packet loss, and sends audio back.' },
    { id: 'vad', label: 'VAD / turn detector', sub: 'small model', kind: 'worker', icon: 'mic', x: 1, y: 0, desc: 'Decides when the user is speaking and when they have finished their turn.' },
    { id: 'asr', label: 'Streaming ASR', sub: 'speech → text', kind: 'ai', icon: 'mic', x: 2, y: 0, desc: 'Turns audio into text incrementally, with partial and final results.' },
    { id: 'llm', label: 'LLM', sub: 'streams tokens', kind: 'ai', icon: 'brain', x: 3, y: 1, desc: 'Generates the reply token by token.' },
    { id: 'tts', label: 'Streaming TTS', sub: 'text → speech', kind: 'ai', icon: 'speaker', x: 2, y: 2, desc: 'Synthesizes audio sentence by sentence as text arrives.' }
  ],
  pseudo: `
for frame in rtc.audio_in():                      # 20 ms Opus frames
    asr.feed(frame)
    if vad.end_of_turn(frame, silence_ms=500):
        text = asr.final()
        for sentence in sentences(llm.stream(history + [text])):
            for chunk in tts.stream(sentence):
                rtc.audio_out(chunk)
                if vad.user_speaking():           # barge-in
                    llm.cancel(); tts.cancel(); rtc.flush()
                    history.add_truncated_reply()
                    break`,
  steps: [
    {
      from: 'phone', to: 'rtc', label: 'Opus frames: "what\'s on my calendar tomorrow?"', pc: ['for frame in rtc.audio_in()'],
      title: 'Audio streams in',
      caption: 'The app sends small audio frames over WebRTC (UDP), which tolerates a lost packet better than waiting for a TCP retransmit.',
      text: ['OpenAI\'s Realtime API documents WebRTC for browser and mobile clients and WebSocket for server-to-server connections.'],
      payloadKind: 'Audio',
      payload: { codec: 'opus', frame_ms: 20, sample_rate: 48000, packets_lost: '1.2%' }
    },
    {
      from: 'rtc', to: 'asr', label: 'partial: "what\'s on my calen…"', pc: ['asr.feed(frame)'],
      title: 'Streaming recognition',
      caption: 'The recognizer emits partial transcripts while the user is still speaking, so the text is almost ready when they stop.',
      text: ['Whisper showed that training on 680,000 hours of weakly supervised multilingual audio gives robust zero-shot recognition; production systems use streaming variants or other streaming ASR models.'],
      payloadKind: 'Partials',
      payload: [{ t_ms: 400, text: 'what\'s' }, { t_ms: 900, text: 'what\'s on my calen' }, { t_ms: 1500, text: 'what\'s on my calendar tomorrow' }]
    },
    {
      from: 'rtc', to: 'vad', label: '500 ms silence → end of turn', pc: ['vad.end_of_turn'],
      title: 'Detect the end of the turn',
      caption: 'Silence alone is a blunt signal: people pause mid-sentence. Turn detectors combine silence with the words so far. Here, 500 ms of silence after a complete question ends the turn.',
      text: [],
      payloadKind: 'Turn',
      payload: { speech_end_ms: 1620, decided_ms: 2120, final_text: 'What\'s on my calendar tomorrow?' }
    },
    {
      from: 'asr', to: 'llm', label: 'final text + history + tools', pc: ['llm.stream(history'],
      title: 'The LLM starts streaming',
      caption: 'The final transcript goes to the LLM, which may call a calendar tool and then streams its reply. The first sentence is complete after ~350 ms.',
      text: [],
      payloadKind: 'LLM stream',
      payload: { first_token_ms: 230, first_sentence: 'Tomorrow you have two things.', tool_calls: ['calendar.list(2026-11-27)'] }
    },
    {
      from: 'llm', to: 'tts', label: 'sentence 1 → audio chunks', pc: ['tts.stream(sentence)'],
      title: 'Speak the first sentence immediately',
      caption: 'TTS starts on the first sentence instead of waiting for the full answer. Audio chunks flow back to the phone while the LLM is still writing sentence 2.',
      text: [],
      payloadKind: 'Latency budget',
      payload: { end_of_turn: 500, asr_final: 60, llm_first_sentence: 350, tts_first_audio: 120, network: 60, total_ms: 1090 }
    },
    {
      from: 'tts', to: 'phone', reply: true, label: '🔊 "Tomorrow you have two things…"', pc: ['rtc.audio_out(chunk)'],
      title: 'The user hears the reply',
      caption: 'Meanwhile the phone keeps sending microphone audio, with echo cancellation removing the assistant\'s own voice.',
      text: [],
      payloadKind: 'Playback',
      payload: { playing: 'sentence 1 of 3', mic_still_open: true, echo_cancellation: true },
      branch: { q: 'Does the user start talking?', options: [ { label: 'yes: barge-in', goto: 'barge' }, { label: 'no: finish the reply', goto: 'finish' } ] }
    },
    {
      id: 'barge', from: 'vad', to: 'llm', label: 'barge-in: cancel LLM + TTS', pc: ['if vad.user_speaking()', 'llm.cancel(); tts.cancel()'],
      title: 'Barge-in: stop talking',
      caption: 'The user says "wait, the day after". VAD detects speech; generation and synthesis are cancelled, queued audio is flushed, and history records only what was actually spoken.',
      text: ['Recording only the spoken part matters: otherwise the model believes it said things the user never heard.'],
      payloadKind: 'Interruption',
      payload: { spoken_so_far: 'Tomorrow you have two things. At ten', cancelled: ['llm', 'tts'], new_turn: 'wait, the day after' }
    },
    {
      id: 'finish', path: 'no interruption', from: 'llm', to: 'phone', reply: true, label: 'remaining sentences', pc: ['rtc.audio_out(chunk)'],
      title: 'Other outcome: finish the reply',
      caption: 'Without an interruption, the remaining sentences play and the system goes back to listening.',
      text: ['Speech-to-speech models (for example the Realtime API\'s models) fold ASR, LLM and TTS into one model that hears tone and answers in audio, cutting latency; the cascade remains easier to debug and to mix vendors.'],
      payloadKind: 'Done',
      payload: { sentences: 3, turn_ms: 4200 }
    }
  ],
  decisions: [
    { q: 'Cascade or speech-to-speech?', options: [
      { name: 'ASR → LLM → TTS', verdict: 'good', why: 'Swap any part, inspect text at each stage, cheaper text LLMs.' },
      { name: 'Speech-to-speech model', verdict: 'good', why: 'Lower latency, hears tone and emotion; fewer choices, harder to inspect.' } ] }
  ],
  refs: [
    { label: 'OpenAI docs: Realtime API (WebRTC, WebSocket, voice activity detection)', url: 'https://developers.openai.com/api/docs/guides/realtime' },
    { label: 'Radford et al. (2022): Whisper, robust speech recognition', url: 'https://arxiv.org/abs/2212.04356' },
    { label: 'RFC 6716: Opus audio codec', url: 'https://www.rfc-editor.org/rfc/rfc6716' },
    { label: 'Pipecat (open-source voice agent framework)', url: 'https://github.com/pipecat-ai/pipecat' }
  ],
  verify: {
    checked: ['WebRTC for browser/mobile, WebSocket for server-to-server, speech-to-speech: OpenAI Realtime docs (read).', '680,000 hours of multilingual weak supervision, zero-shot: Whisper abstract.'],
    uncertain: ['Latency budget numbers and the 500 ms silence threshold are illustrative.']
  }
});
