import re

with open('css/style.css', 'r', encoding='utf-8') as f:
    css = f.read()

# basic regex to find .blog-grid
matches = re.finditer(r'\.blog-grid\s*{[^}]*}', css)
for m in matches:
    print(m.group(0))

matches = re.finditer(r'@media[^{]+\{\s*\.blog-grid\s*{[^}]*}', css)
for m in matches:
    print(m.group(0))

matches = re.finditer(r'\.blog-carousel[^{]*{[^}]*}', css)
for m in matches:
    print(m.group(0))
