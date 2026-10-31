// Builds dist/zing.html: the same game as a page fragment for publishing as a claude.ai artifact
// (the artifact host supplies its own <html>/<head>/<body> skeleton).
const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
const out = `<title>Zing Quiz</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="styles.css">
${body}`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/zing.html'), out);
console.log('wrote dist/zing.html');
