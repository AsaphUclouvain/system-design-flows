"""Build-time checks + browser tests. Usage: python3 test.py [flow_id ...] [--shots]"""
import asyncio, json, re, sys, pathlib
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).parent
HTML = (ROOT / 'dist' / 'system-design-flows.html').resolve()
SHOTS = ROOT / 'shots'; SHOTS.mkdir(exist_ok=True)
args = [a for a in sys.argv[1:] if not a.startswith('--')]
want_shots = '--shots' in sys.argv

CHECK_JS = r"""
() => {
  const F = window.SD_FLOWS, G = window.SD_GLOSSARY, problems = [];
  const ids = new Set();
  const kinds = ['client','edge','service','worker','db','cache','queue','storage','external'];
  F.forEach(f => {
    if (ids.has(f.id)) problems.push('duplicate flow id ' + f.id); ids.add(f.id);
    ['id','title','category','summary','grid','nodes','steps'].forEach(k => { if (!f[k]) problems.push(f.id + ': missing ' + k); });
    const nid = new Set(), pos = new Set();
    f.nodes.forEach(n => {
      if (nid.has(n.id)) problems.push(f.id + ': duplicate node ' + n.id); nid.add(n.id);
      if (!kinds.includes(n.kind)) problems.push(f.id + ': bad kind ' + n.kind + ' on ' + n.id);
      if (n.x >= f.grid.cols || n.y >= f.grid.rows || n.x < 0 || n.y < 0) problems.push(f.id + ': node off grid ' + n.id);
      const p = n.x + ',' + n.y; if (pos.has(p)) problems.push(f.id + ': two nodes at ' + p); pos.add(p);
      if (!n.desc) problems.push(f.id + ': node without desc ' + n.id);
    });
    const used = new Set();
    f.steps.forEach((s, i) => {
      if (!nid.has(s.from) || !nid.has(s.to)) problems.push(f.id + ' step ' + (i+1) + ': unknown node ' + s.from + '/' + s.to);
      used.add(s.from); used.add(s.to);
      if (!s.title || !s.caption) problems.push(f.id + ' step ' + (i+1) + ': missing title/caption');
      if (!s.text) problems.push(f.id + ' step ' + (i+1) + ': no text');
    });
    f.nodes.forEach(n => { if (!used.has(n.id)) problems.push(f.id + ': node never used ' + n.id); });
    const sids = new Set(f.steps.filter(s => s.id).map(s => s.id));
    const plen = f.pseudo ? f.pseudo.replace(/^\n+|\s+$/g, '').split('\n').length : 0;
    f.steps.forEach((s, i) => {
      if (s.next && !sids.has(s.next)) problems.push(f.id + ' step ' + (i+1) + ': next to unknown step ' + s.next);
      if (s.branch) s.branch.options.forEach(o => { if (!sids.has(o.goto)) problems.push(f.id + ' step ' + (i+1) + ': branch to unknown step ' + o.goto); });
      const pls = f.pseudo ? f.pseudo.replace(/^\n+|\s+$/g, '').split('\n') : [];
      (s.pc || []).forEach(v => { if (typeof v === 'string' && !/^\d+(-\d+)?$/.test(v)) { if (!pls.some(l => l.includes(v))) problems.push(f.id + ' step ' + (i+1) + ': pc text not found "' + v + '"'); return; } String(v).split('-').forEach(n => { if (+n < 1 || +n > plen) problems.push(f.id + ' step ' + (i+1) + ': pc line ' + n + ' outside pseudocode (' + plen + ')'); }); });
      if (f.pseudo && !(s.pc || []).length) problems.push(f.id + ' step ' + (i+1) + ': no pseudocode line');
    });
    const blob = JSON.stringify(f, (k, v) => ['code','schema','payload'].includes(k) ? undefined : v);
    (blob.match(/\{\{([A-Za-z][^}|]*)/g) || []).forEach(m => { const t = m.slice(2).trim().toLowerCase(); if (!G[t]) problems.push(f.id + ': glossary term missing "' + t + '"'); });
    (blob.match(/\[\[([\w-]+)/g) || []).forEach(m => { const t = m.slice(2); if (!nid.has(t)) problems.push(f.id + ': chip to unknown node ' + t); });
  });
  const stats = F.map(f => {
    const st = f.steps;
    return { id: f.id, steps: st.length, nodes: f.nodes.length,
      payload: st.filter(s => s.payload !== undefined).length,
      code: st.filter(s => s.code).length,
      failure: st.filter(s => s.failure).length,
      fields: st.filter(s => s.fields).length,
      details: st.filter(s => s.details).length,
      req: !!f.requirements, est: !!f.estimates, api: !!f.api, schema: !!f.schema, deep: (f.decisions||[]).length, refs: (f.refs||[]).length };
  });
  return { problems, stats, count: F.length };
}
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        errors = []
        ctx = await b.new_context(viewport={'width': 1366, 'height': 900})
        pg = await ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
        await pg.goto(HTML.as_uri())
        await pg.wait_for_timeout(300)
        res = await pg.evaluate(CHECK_JS)
        print('flows:', res['count'])
        for pr in res['problems']: print('PROBLEM', pr)
        for s in res['stats']:
            print('  {id:34s} steps={steps:2d} nodes={nodes:2d} payload={payload:2d} code={code:2d} fail={failure:2d} fields={fields:2d} det={details:2d} req={req} est={est} api={api} schema={schema} deep={deep} refs={refs}'.format(**s))
        ids = args or [s['id'] for s in res['stats']]
        for fid in ids:
            n = next(s['steps'] for s in res['stats'] if s['id'] == fid)
            await pg.goto(HTML.as_uri() + '#/flow/' + fid + '/1'); await pg.wait_for_timeout(150)
            # step through every step and every tab
            for i in range(n):
                await pg.evaluate('i => window.SD_APP.go(i)', i)
                tabs = await pg.eval_on_selector_all('#tabs .sd-tab', 'els => els.map(e => e.dataset.tab)')
                for t in tabs:
                    await pg.click('#tabs [data-tab="' + t + '"]')
                active = await pg.evaluate('() => !!document.querySelector(".sd-wire.active, .sd-busychip")')
                lab = await pg.evaluate('''() => { const cv = document.querySelector('#cv').getBoundingClientRect(); const l = document.querySelector('#cv .sd-wlabel, #cv .sd-busychip'); if (!l) return null; const r = l.getBoundingClientRect(); return (r.left < cv.left - 14 || r.right > cv.right + 14) ? Math.round(r.left - cv.left) + '..' + Math.round(r.right - cv.left) + ' of ' + Math.round(cv.width) : null; }''')
                if lab: errors.append(fid + ' step ' + str(i+1) + ': label outside diagram ' + lab)
                if not active: errors.append(fid + ' step ' + str(i+1) + ': no arrow/chip drawn')
                await pg.click('#tabs [data-tab="explain"]')
            # overlap check on desktop and phone
            for vw, vh in ((1366, 900), (390, 844)):
                await pg.set_viewport_size({'width': vw, 'height': vh}); await pg.wait_for_timeout(200)
                ov = await pg.evaluate('''() => { const r = [...document.querySelectorAll('#cv .sd-node')].map(e => [e.dataset.node, e.getBoundingClientRect()]); const o = [];
                  for (let i=0;i<r.length;i++) for (let j=i+1;j<r.length;j++){ const a=r[i][1], b=r[j][1]; if (a.left < b.right-2 && b.left < a.right-2 && a.top < b.bottom-2 && b.top < a.bottom-2) o.push(r[i][0]+'~'+r[j][0]); }
                  const cv = document.querySelector('#cv').getBoundingClientRect(); const out = r.filter(x => x[1].left < cv.left-1 || x[1].right > cv.right+1).map(x=>x[0]);
                  return {o, out, docW: document.documentElement.scrollWidth}; }''')
                if ov['o']: errors.append(fid + ' @' + str(vw) + ' overlapping nodes ' + ','.join(ov['o']))
                if ov['out']: errors.append(fid + ' @' + str(vw) + ' nodes outside canvas ' + ','.join(ov['out']))
                if ov['docW'] > vw + 1: errors.append(fid + ' @' + str(vw) + ' horizontal page overflow ' + str(ov['docW']))
            await pg.set_viewport_size({'width': 1366, 'height': 900})
        await pg.goto(HTML.as_uri() + '#/'); await pg.wait_for_timeout(200)
        cards = await pg.eval_on_selector_all('.sd-card', 'e => e.length')
        print('home cards:', cards)
        for e in errors: print('ERR', e)
        if want_shots:
            for fid in ids[:6]:
                for vw, vh, tag in ((1366, 900, 'desk'), (390, 844, 'mob')):
                    pg2 = await b.new_page(viewport={'width': vw, 'height': vh}, device_scale_factor=2 if vw < 500 else 1)
                    await pg2.goto(HTML.as_uri() + '#/flow/' + fid + '/3'); await pg2.wait_for_timeout(900)
                    await pg2.evaluate("document.querySelector('#sec-sim').scrollIntoView()"); await pg2.wait_for_timeout(700)
                    await pg2.screenshot(path=str(SHOTS / (fid + '_' + tag + '.png')))
                    await pg2.close()
            for vw, vh, tag in ((1366, 900, 'desk'), (390, 844, 'mob')):
                pg2 = await b.new_page(viewport={'width': vw, 'height': vh}, device_scale_factor=2 if vw < 500 else 1)
                await pg2.goto(HTML.as_uri() + '#/'); await pg2.wait_for_timeout(500)
                await pg2.screenshot(path=str(SHOTS / ('home_' + tag + '.png')))
                await pg2.close()
        await b.close()

asyncio.run(main())
