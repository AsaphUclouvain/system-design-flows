flow({
  id: 'image-generation-diffusion',
  title: 'Image generation with latent diffusion',
  category: 'AI & machine learning',
  tags: ['Text encoder', 'Latent space (VAE)', 'Denoising U-Net / transformer', 'Classifier-free guidance', 'Scheduler steps', 'Safety filter', 'Provenance (C2PA)'],
  summary: 'Type "a red gate glowing in the dark" and get a picture. Follow a latent diffusion pipeline like Stable Diffusion: the prompt is encoded, a small block of pure noise in latent space is denoised step by step, guided toward the prompt, then a VAE decoder turns the latent into pixels, and safety and provenance checks run before the image is returned.',
  requirements: {
    functional: ['Generate an image from a text prompt.'],
    nonFunctional: ['A 1024×1024 image in a few seconds on one GPU.', 'Block disallowed content; mark images as AI-generated.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'User', sub: 'prompt', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Types a prompt.' },
    { id: 'api', label: 'Image API', sub: 'queue + policy', kind: 'service', icon: 'api', x: 1, y: 1, desc: 'Checks the prompt against policy, queues the job on a GPU worker.' },
    { id: 'te', label: 'Text encoder', sub: 'CLIP / T5', kind: 'ai', icon: 'doc', x: 1, y: 0, desc: 'Turns the prompt into embeddings the denoiser can condition on.' },
    { id: 'unet', label: 'Denoiser', sub: 'U-Net / DiT', kind: 'ai', icon: 'gpu', x: 2, y: 0, desc: 'Predicts the noise in the current latent, given the step number and the text embeddings.' },
    { id: 'vae', label: 'VAE decoder', sub: 'latent → pixels', kind: 'worker', icon: 'layers', x: 3, y: 1, desc: 'Expands the small latent (e.g. 128×128×4) into the full-resolution image.' },
    { id: 'safe', label: 'Safety + provenance', sub: 'classifier, C2PA', kind: 'edge', icon: 'shield', x: 2, y: 2, desc: 'Checks the output image and attaches content credentials saying it was AI-generated.' }
  ],
  pseudo: `
cond = text_encoder(prompt); uncond = text_encoder("")
latent = randn(4, 128, 128, seed=1234)             # pure noise
for t in scheduler.timesteps(30):
    e_c = unet(latent, t, cond); e_u = unet(latent, t, uncond)
    eps = e_u + guidance * (e_c - e_u)             # classifier-free guidance
    latent = scheduler.step(eps, t, latent)        # remove a bit of noise
image = vae.decode(latent)
if safety(image).flagged: return refuse()
return sign_c2pa(image)`,
  steps: [
    {
      from: 'user', to: 'api', label: '"a red gate glowing in the dark, embers"', pc: ['cond = text_encoder'],
      title: 'Prompt and policy check',
      caption: 'The prompt is checked against the content policy, then queued. Parameters: 1024×1024, 30 steps, guidance 7.5, seed 1234.',
      text: [],
      payloadKind: 'Request',
      payload: { prompt: 'a red gate glowing in the dark, embers', size: '1024x1024', steps: 30, guidance_scale: 7.5, seed: 1234 }
    },
    {
      from: 'api', to: 'te', label: 'encode prompt and empty prompt', pc: ['cond = text_encoder(prompt); uncond'],
      title: 'Encode the text',
      caption: 'The text encoder produces embeddings for the prompt and for an empty prompt. Both are needed for guidance.',
      text: [],
      payloadKind: 'Embeddings',
      payload: { cond: '77 × 768', uncond: '77 × 768' }
    },
    {
      from: 'te', to: 'unet', label: 'start from noise 4×128×128', pc: ['latent = randn'],
      title: 'Start from noise in latent space',
      caption: 'Working on a compressed latent (8× smaller per side) instead of pixels makes each step far cheaper. The seed fixes the noise, so the same seed and prompt give the same image.',
      text: ['Rombach et al. (2021) introduced latent diffusion: run diffusion in the latent space of a pretrained autoencoder, with cross-attention for conditioning on text, cutting compute versus pixel-space diffusion.'],
      payloadKind: 'Latent',
      payload: { shape: [4, 128, 128], seed: 1234, content: 'pure Gaussian noise' }
    },
    {
      from: 'unet', to: 'unet', label: '30 steps: predict noise, guide, subtract', pc: ['for t in scheduler.timesteps', 'eps = e_u + guidance'],
      title: 'Denoise step by step, guided by the prompt',
      caption: 'At each step the model predicts the noise twice (with and without the prompt); the difference is amplified by the guidance scale to push the image toward the prompt. The scheduler removes that much noise.',
      text: ['Hugging Face\'s diffusers guide walks through this same loop: text encoder, UNet, scheduler, guidance_scale, then VAE decoding.'],
      payloadKind: 'Step 15 of 30',
      payload: { t: 499, guidance_scale: 7.5, latent_std: 0.71, visible: 'rough gate shape, red glow emerging' }
    },
    {
      from: 'unet', to: 'vae', label: 'final latent → decode to 1024×1024 RGB', pc: ['image = vae.decode'],
      title: 'Decode to pixels',
      caption: 'The VAE decoder turns the clean latent into a full-resolution image.',
      text: [],
      payloadKind: 'Image',
      payload: { size: '1024×1024', format: 'PNG', gpu_time_s: 3.4 }
    },
    {
      from: 'vae', to: 'safe', label: 'safety classifier + C2PA manifest', pc: ['safety(image)', 'sign_c2pa'],
      title: 'Check and label the output',
      caption: 'A classifier checks the image itself (a safe prompt can still produce an unsafe image). Content credentials are attached so platforms can show it was AI-generated.',
      text: [],
      payloadKind: 'Checks',
      payload: { flagged: false, c2pa: { claim_generator: 'ImageAPI/2.1', actions: ['c2pa.created'], digitalSourceType: 'trainedAlgorithmicMedia' } },
      branch: { q: 'Image flagged?', options: [ { label: 'no: return it', goto: 'ret' }, { label: 'yes: refuse', goto: 'refuse' } ] }
    },
    {
      id: 'refuse', path: 'flagged', from: 'safe', to: 'user', reply: true, label: 'refused, image discarded', pc: ['return refuse()'],
      title: 'Other outcome: blocked output',
      caption: 'A flagged image is discarded and never stored or returned.',
      text: [],
      payloadKind: 'Refusal',
      payload: { error: 'content_policy_violation' },
      next: 'ret'
    },
    {
      id: 'ret', from: 'safe', to: 'user', reply: true, label: 'image URL (expires in 1 h)', pc: ['return sign_c2pa(image)'],
      title: 'Return the image',
      caption: 'The image is uploaded to object storage and returned as a short-lived URL.',
      text: [],
      payloadKind: 'Response',
      payload: { url: 'https://cdn.example/gen/7f3a.png?exp=…', seed: 1234 }
    }
  ],
  decisions: [
    { q: 'Steps and guidance?', options: [
      { name: 'More steps', verdict: 'ok', why: 'Usually cleaner, linearly slower; distilled models need only 1–4.' },
      { name: 'Higher guidance', verdict: 'ok', why: 'Follows the prompt more closely; too high looks oversaturated.' } ] }
  ],
  refs: [
    { label: 'Rombach et al. (2021): High-resolution image synthesis with latent diffusion models', url: 'https://arxiv.org/abs/2112.10752' },
    { label: 'Ho et al. (2020): Denoising diffusion probabilistic models', url: 'https://arxiv.org/abs/2006.11239' },
    { label: 'Hugging Face diffusers: Understanding pipelines, models and schedulers', url: 'https://huggingface.co/docs/diffusers/using-diffusers/write_own_pipeline' },
    { label: 'C2PA: Coalition for Content Provenance and Authenticity', url: 'https://c2pa.org/' }
  ],
  verify: {
    checked: ['Diffusion in the latent space of pretrained autoencoders, cross-attention conditioning: latent diffusion abstract.', 'Text encoder, UNet, scheduler loop, guidance_scale, VAE decode: diffusers guide (read).'],
    uncertain: ['Latent shapes, step counts, timings and the C2PA fields are illustrative and simplified.']
  }
});
