const fs = require('fs');
const path = require('path');

const OLD_DOMAIN = 'acmeinfotechcctv.in';
const NEW_DOMAIN = 'acmeinfotechcctv.in';

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      if (!file.includes('node_modules') && !file.includes('.git')) {
        results = results.concat(walk(file));
      }
    } else {
      if (file.endsWith('.html') || file.endsWith('.js') || file.endsWith('.json') || file.endsWith('.md') || file.endsWith('.xml')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = walk('.');
let count = 0;
files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  if (content.includes(OLD_DOMAIN)) {
    content = content.replace(new RegExp(OLD_DOMAIN, 'g'), NEW_DOMAIN);
    fs.writeFileSync(f, content, 'utf8');
    console.log('Updated', f);
    count++;
  }
});

console.log(`Successfully updated ${count} files.`);
