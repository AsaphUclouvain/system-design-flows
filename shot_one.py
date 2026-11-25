import asyncio, sys, pathlib
from playwright.async_api import async_playwright
# usage: shot_one.py hash tab out [width] [scrollTo selector] [clip selector]
h, tab, out = sys.argv[1], sys.argv[2], sys.argv[3]
w = int(sys.argv[4]) if len(sys.argv) > 4 else 1366
sel = sys.argv[5] if len(sys.argv) > 5 else '#sec-sim'
clip = sys.argv[6] if len(sys.argv) > 6 else None
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': w, 'height': 900 if w > 500 else 844}, device_scale_factor=2 if w < 500 else 1)
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(pathlib.Path('dist/system-design-flows.html').resolve().as_uri() + h); await pg.wait_for_timeout(600)
        if tab != '-':
            await pg.click('#tabs [data-tab="' + tab + '"]'); await pg.wait_for_timeout(200)
        await pg.evaluate("s => { const e = document.querySelector(s); if (e) e.scrollIntoView(); }", sel); await pg.wait_for_timeout(500)
        if clip:
            await (await pg.query_selector(clip)).screenshot(path=out)
        else:
            await pg.screenshot(path=out)
        print('errors', errs)
        await b.close()
asyncio.run(main())
