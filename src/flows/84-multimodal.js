flow({
  id: 'multimodal-llm',
  title: 'Multimodal LLM: how an image becomes tokens the model reads',
  category: 'AI & machine learning',
  tags: ['Image upload', 'Resize + tiling', 'Vision encoder (ViT/CLIP)', 'Projector to text space', 'Image tokens cost', 'Interleaved text + image'],
  summary: 'You send a photo of a whiteboard and ask "what\'s wrong with this proof?". A language model only reads token embeddings, so the image has to be turned into some. Follow the image through resizing and tiling, a vision encoder that turns patches into vectors, a projector that maps them into the LLM\'s embedding space, and an answer that reasons over text and image together.',
  requirements: {
    functional: ['Accept images with a text question and answer about them.'],
    nonFunctional: ['Cost and latency grow with image size; cap the resolution.', 'Small text in photos must stay readable.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'User', sub: 'phone photo', kind: 'client', icon: 'phone', x: 0, y: 1, desc: 'Uploads a 4032×3024 photo with a question.' },
    { id: 'api', label: 'API server', sub: 'preprocessing', kind: 'service', icon: 'api', x: 1, y: 1, desc: 'Validates, resizes and cuts the image into tiles according to the detail setting.' },
    { id: 'enc', label: 'Vision encoder', sub: 'ViT, CLIP-style', kind: 'ai', icon: 'search', x: 2, y: 0, desc: 'Splits each tile into patches (e.g. 14×14 px) and outputs one vector per patch. Pretrained to match images with captions.' },
    { id: 'proj', label: 'Projector', sub: 'MLP', kind: 'worker', icon: 'split', x: 2, y: 1, desc: 'A small trained network that maps vision vectors into the LLM\'s token-embedding space.' },
    { id: 'llm', label: 'LLM', sub: 'decoder', kind: 'ai', icon: 'brain', x: 3, y: 1, desc: 'Reads the image tokens and text tokens in one sequence and generates text.' },
    { id: 'meter', label: 'Usage meter', sub: 'billing', kind: 'db', icon: 'chart', x: 1, y: 2, desc: 'Counts image tokens like text tokens.' }
  ],
  pseudo: `
img = resize(upload, max_side=2048); img = fit_short_side(img, 768)
tiles = split(img, 512) + [thumbnail(img)]          # high detail
patches = [vit(t) for t in tiles]                 # vectors per patch
image_tokens = projector(patches)                 # -> LLM embedding size
seq = [*text_tokens("What's wrong with this proof?"), *image_tokens]
answer = llm.generate(seq)
bill(text_tokens + len(image_tokens))`,
  steps: [
    {
      from: 'user', to: 'api', label: 'image (4032×3024) + question', pc: ['img = resize(upload'],
      title: 'Image and question arrive together',
      caption: 'The request interleaves a text part and an image part in one user message, as a URL or base64.',
      text: [],
      payloadKind: 'Request',
      payload: { model: 'vision-model', input: [{ role: 'user', content: [{ type: 'input_text', text: 'What\'s wrong with this proof?' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQ…', detail: 'high' }] }] }
    },
    {
      from: 'api', to: 'api', label: 'resize → 1024×768, 4 tiles of 512 + thumbnail', pc: ['tiles = split'],
      title: 'Resize and tile',
      caption: 'A 12-megapixel photo is far more than needed. It is scaled down, then cut into fixed-size tiles so small handwriting keeps enough pixels; a low-res thumbnail keeps the overall layout.',
      text: ['The "detail" setting in vision APIs trades cost for resolution: low detail sends one small image, high detail sends tiles.'],
      payloadKind: 'Preprocessing',
      payload: { original: '4032×3024', resized: '1024×768', tiles: 4, tile_px: 512, thumbnail: true }
    },
    {
      from: 'api', to: 'enc', label: 'each tile → patches → vectors', pc: ['patches = [vit(t)'],
      title: 'Encode patches with a vision transformer',
      caption: 'Each tile is cut into small square patches; a vision transformer turns every patch into a vector that describes what is there in context (strokes, symbols, an arrow).',
      text: ['CLIP (Radford et al., 2021) trained an image encoder and a text encoder together on 400 million image–caption pairs, so image vectors line up with the meaning of words. Many multimodal LLMs start from such an encoder.'],
      payloadKind: 'Patch vectors',
      payload: { tiles: 5, patches_per_tile: 576, vector_dim: 1024 }
    },
    {
      from: 'enc', to: 'proj', label: 'project 1024-d → 4096-d', pc: ['image_tokens = projector'],
      title: 'Project into the language model\'s space',
      caption: 'A small MLP maps each vision vector to the size of the LLM\'s token embeddings. To the LLM these now look like extra "words".',
      text: ['LLaVA (Liu et al., 2023) connected a CLIP vision encoder to an LLM this way and trained it on GPT-4-generated image instruction data.'],
      payloadKind: 'Image tokens',
      payload: { in_dim: 1024, out_dim: 4096, image_tokens: 765, note: 'often pooled or merged to reduce count' }
    },
    {
      from: 'proj', to: 'llm', label: 'text tokens + 765 image tokens', pc: ['seq = [*text_tokens'],
      title: 'One sequence of text and image',
      caption: 'The LLM attends over the question and the image tokens together, so it can link "line 3" in its reasoning to the region of the image where line 3 is written.',
      text: [],
      payloadKind: 'Sequence',
      payload: { text_tokens: 9, image_tokens: 765, total_input: 774 }
    },
    {
      from: 'llm', to: 'user', reply: true, label: '"Line 3 divides by (n−1), which is 0 when n=1"', pc: ['answer = llm.generate'],
      title: 'The answer',
      caption: 'The model reads the handwriting and points to the step that fails.',
      text: [],
      payloadKind: 'Answer',
      payload: { text: 'Line 3 divides both sides by (n − 1), which is zero for n = 1, so the induction base case does not carry over.' },
      branch: { q: 'Is the handwriting legible at this resolution?', options: [ { label: 'yes: done', goto: 'bill' }, { label: 'no: ask for a closer photo', goto: 'blur' } ] }
    },
    {
      id: 'blur', path: 'unreadable', from: 'llm', to: 'user', reply: true, label: '"I can\'t read line 4, can you zoom in?"', pc: ['answer = llm.generate'],
      title: 'Other outcome: not enough pixels',
      caption: 'With low detail or a blurry photo, small text can be lost in resizing. A good assistant says what it cannot read instead of guessing.',
      text: [],
      payloadKind: 'Answer',
      payload: { text: 'Line 4 is too small to read in this photo. Could you send a closer picture?' },
      next: 'bill'
    },
    {
      id: 'bill', from: 'api', to: 'meter', label: 'bill 774 input tokens', pc: ['bill('],
      title: 'Images are billed as tokens',
      caption: 'Image tokens count toward the context window and the bill. High detail on a large image can cost more than a page of text.',
      text: [],
      payloadKind: 'Usage',
      payload: { input_tokens: 774, of_which_image: 765, output_tokens: 41 }
    }
  ],
  decisions: [
    { q: 'Low or high detail?', options: [
      { name: 'Low', verdict: 'good', why: 'Cheap and fast; fine for "what is in this photo?".' },
      { name: 'High (tiles)', verdict: 'good', why: 'Needed for documents, handwriting, charts, screenshots.' } ] }
  ],
  refs: [
    { label: 'Radford et al. (2021): CLIP, learning transferable visual models from natural language', url: 'https://arxiv.org/abs/2103.00020' },
    { label: 'Liu et al. (2023): LLaVA, visual instruction tuning', url: 'https://arxiv.org/abs/2304.08485' },
    { label: 'Dosovitskiy et al. (2020): An image is worth 16×16 words (ViT)', url: 'https://arxiv.org/abs/2010.11929' },
    { label: 'OpenAI docs: Images and vision', url: 'https://developers.openai.com/api/docs/guides/images-vision' }
  ],
  verify: {
    checked: ['400 million (image, text) pairs, contrastive training: CLIP abstract.', 'Vision encoder + LLM, GPT-4-generated multimodal instruction data: LLaVA abstract.', 'input_image with image_url and detail fields: OpenAI images & vision docs (read).'],
    uncertain: ['Tile sizes, patch counts, token totals and dimensions are illustrative; each provider tiles and counts differently.', 'Some models (natively multimodal) do not use a separate projector in this form.']
  }
});
