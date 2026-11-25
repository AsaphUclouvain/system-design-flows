import pathlib, re
root = pathlib.Path(__file__).parent
src = root / 'src'
tpl = (src / 'template.html').read_text()
css = (src / 'app.css').read_text()
data = [(src / 'data.js').read_text(), (src / 'glossary.js').read_text()]
data += [p.read_text() for p in sorted((src / 'flows').glob('*.js'))]
app = (src / 'app.js').read_text()
out = tpl.replace('/*CSS*/', css).replace('/*DATA*/', '\n'.join(data)).replace('/*APP*/', app)
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist' / 'system-design-flows.html').write_text(out)
# GitHub Pages serves the docs/ folder of main: https://asaphuclouvain.github.io/system-design-flows/
(root / 'docs').mkdir(exist_ok=True)
(root / 'docs' / 'index.html').write_text(out)
(root / 'docs' / '.nojekyll').write_text('')
print('built', len(out) // 1024, 'KB')
