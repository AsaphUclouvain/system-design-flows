# usage: python3 shot.py flow:step [flow:step ...]  -> shots/<flow>_<step>_{d,m}.png (diagram + caption area)
import asyncio, sys, pathlib
from playwright.async_api import async_playwright
HTML = pathlib.Path(__file__).parent / 'dist' / 'system-design-flows.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for vw, tag in ((1440, 'd'), (390, 'm')):
            ctx = await b.new_context(viewport={'width': vw, 'height': 900 if tag == 'd' else 844}, device_scale_factor=1 if tag=='d' else 2)
            pg = await ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            for a in sys.argv[1:]:
                fid, st = a.split(':')
                await pg.goto(HTML.as_uri() + '#/flow/' + fid + '/' + st); await pg.wait_for_timeout(250)
                await pg.reload(); await pg.wait_for_timeout(1800)
                el = await pg.query_selector('#sec-sim')
                await el.screenshot(path=f'shots/{fid}_{st}_{tag}.png')
            if errs: print('ERR', tag, errs)
        await b.close()
asyncio.run(main())
