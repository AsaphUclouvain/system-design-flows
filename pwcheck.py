"""Second opinion for links curl could not load (bot walls): open each in real Chromium.
Usage: python3 pwcheck.py URL [URL ...] -> status, final url, page title"""
import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36')
        for u in sys.argv[1:]:
            pg = await ctx.new_page()
            try:
                r = await pg.goto(u, timeout=45000, wait_until='domcontentloaded')
                await pg.wait_for_timeout(2500)
                print(r.status if r else '???', pg.url, '|', (await pg.title())[:90])
            except Exception as e:
                print('ERR', u, str(e)[:120])
            await pg.close()
        await b.close()
asyncio.run(main())
