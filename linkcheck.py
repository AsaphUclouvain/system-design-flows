"""Check every reference link of every flow. Usage: python3 linkcheck.py [flow_id ...]
Prints one line per link: status, flow, url. Exit code 1 if a link is broken (404, 410 or another 4xx).
Codes that bot protection or a flaky network returns (401, 403, 406, 429, 999, 5xx, timeouts) print as WARN and do not fail:
the page usually opens in a browser, and a CI runner cannot tell a block from a broken link."""
import json, subprocess, sys, concurrent.futures as cf, pathlib
ROOT = pathlib.Path(__file__).parent
JS = """
global.window = {}; const fs = require('fs'), path = require('path');
const dir = process.argv[1]; eval(fs.readFileSync(path.join(dir, 'src/data.js'), 'utf8'));
global.flow = window.flow || flow; global.terms = terms;
fs.readdirSync(path.join(dir, 'src/flows')).sort().forEach(f => eval(fs.readFileSync(path.join(dir, 'src/flows', f), 'utf8')));
console.log(JSON.stringify(window.SD_FLOWS.map(f => ({ id: f.id, refs: f.refs || [], verify: !!f.verify }))));
"""
flows = json.loads(subprocess.check_output(['node', '-e', JS, str(ROOT)]))
want = set(a for a in sys.argv[1:] if not a.startswith('-'))
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
cache = {}
MANUAL = set(l.strip() for l in (ROOT / 'linkcheck_manual.txt').read_text().splitlines() if l.startswith('http')) if (ROOT / 'linkcheck_manual.txt').exists() else set()
manual = 0
def check(url):
    if url in cache: return cache[url]
    for method in (['-I'], []):
        r = subprocess.run(['curl', '-sL', '-o', '/dev/null', '-w', '%{http_code} %{url_effective}', '--max-time', '25', '-A', UA, '-H', 'Accept-Language: en'] + method + [url], capture_output=True, text=True)
        code = (r.stdout.split(' ')[0] or '000')
        if code.startswith(('2', '3')): break
    cache[url] = r.stdout
    return r.stdout
jobs = [(f['id'], r['url']) for f in flows if not want or f['id'] in want for r in f['refs']]
bad = 0; warn = 0
BLOCKED = ('401', '403', '406', '429', '999', '000')
with cf.ThreadPoolExecutor(16) as ex:
    for (fid, url), res in zip(jobs, ex.map(lambda j: check(j[1]), jobs)):
        code = res.split(' ')[0]
        ok = code.startswith(('2', '3'))
        if not ok and url in MANUAL: manual += 1; continue
        soft = not ok and (code in BLOCKED or code.startswith('5'))
        if soft: warn += 1
        elif not ok: bad += 1
        if not ok or '-v' in sys.argv: print(('OK  ' if ok else 'WARN' if soft else 'BAD ') + code, fid, url, '->', res.split(' ', 1)[-1] if res.split(' ', 1)[-1] != url else '')
print(len(jobs), 'links,', manual, 'blocked for scripts but checked by hand (linkcheck_manual.txt),', len(set(u for _, u in jobs)), 'unique,', bad, 'broken,', warn, 'blocked or unreachable (warning only);', sum(1 for f in flows if not f['refs']), 'flows without refs;', sum(1 for f in flows if not f['verify']), 'flows without verify panels')
sys.exit(1 if bad else 0)
