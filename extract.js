const fs = require('fs');
const lines = fs.readFileSync('server.js', 'utf8').split('\n');
lines.forEach((line, i) => {
  if (line.includes('absoluteUrl')) console.log(`${i+1}: ${line}`);
});
