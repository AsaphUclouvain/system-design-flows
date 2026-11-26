// Static checks on every flow: valid icons and kinds, every goto target exists, every pc line exists in the pseudocode, refs + verify present.
const fs = require('fs'), path = require('path'); global.window = {};
const dir = __dirname; eval(fs.readFileSync(path.join(dir, 'src/data.js'), 'utf8'));
fs.readdirSync(path.join(dir, 'src/flows')).sort().forEach(f => eval(fs.readFileSync(path.join(dir, 'src/flows', f), 'utf8')));
const app = fs.readFileSync(path.join(dir, 'src/app.js'), 'utf8'); const seg = app.slice(app.indexOf('/* ---------- icons'), app.indexOf('const nodeIcon'));
const icons = new Set([...seg.matchAll(/^\s+([a-z0-9_]+):\s*'/gm)].map(m => m[1]));
const kinds = new Set([...fs.readFileSync(path.join(dir, 'src/app.css'), 'utf8').matchAll(/--k-([a-z]+)/g)].map(m => m[1]));
let bad = 0; const err = (f, m) => { bad++; console.log('ERR', f.id, m); };
const flows = window.SD_FLOWS; const ids = new Set();
for (const f of flows) {
  if (ids.has(f.id)) err(f, 'duplicate id'); ids.add(f.id);
  const nodes = new Set(f.nodes.map(n => n.id));
  for (const n of f.nodes) { if (n.icon && !icons.has(n.icon)) err(f, 'icon ' + n.icon); if (!kinds.has(n.kind)) err(f, 'kind ' + n.kind); }
  const sids = new Set(f.steps.map(s => s.id).filter(Boolean));
  f.steps.forEach((s, i) => {
    if (!nodes.has(s.from) || !nodes.has(s.to)) err(f, 'step ' + (i + 1) + ' unknown node ' + s.from + '->' + s.to);
    if (s.next && !sids.has(s.next)) err(f, 'next ' + s.next);
    (s.branch && s.branch.options || []).forEach(o => { if (!sids.has(o.goto)) err(f, 'goto ' + o.goto); });
    (s.pc || []).forEach(p => { if (f.pseudo && !f.pseudo.includes(p)) err(f, 'step ' + (i + 1) + ' pc not in pseudo: ' + p); });
  });
  if (!(f.refs || []).length) err(f, 'no refs'); if (!f.verify) err(f, 'no verify panels');
}
const cats = {}; flows.forEach(f => cats[f.category] = (cats[f.category] || 0) + 1);
console.log(flows.length, 'flows', JSON.stringify(cats)); console.log(bad, 'problems'); process.exit(bad ? 1 : 0);
