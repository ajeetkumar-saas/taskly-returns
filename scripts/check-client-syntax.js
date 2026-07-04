// Validates the inline <script> block in each client HTML file actually parses as valid
// JavaScript. This exact check (manually, via `node -e`) is what caught the literal-newline-in-
// a-string-literal bug that broke the entire embedded seller app for an extended period earlier
// today — every button stopped working because the whole inline script threw a SyntaxError on
// load. Running it in CI on every push means that specific class of bug can never reach
// production silently again.

const fs = require('fs');
const path = require('path');

const files = [
  'client/build/embedded.html',
  'client/build/index.html',
  'client/build/return.html',
  'client/build/login.html',
  'client/build/landing.html',
  'client/build/set-password.html'
];

let hadError = false;

for (const relPath of files) {
  const fullPath = path.join(__dirname, '..', relPath);
  if (!fs.existsSync(fullPath)) continue;
  const html = fs.readFileSync(fullPath, 'utf8');
  const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  let scriptCount = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    scriptCount++;
    const js = match[1];
    if (!js.trim()) continue;
    try {
      new Function(js);
    } catch (e) {
      hadError = true;
      console.error(`SYNTAX ERROR in ${relPath} (inline <script> #${scriptCount}): ${e.message}`);
    }
  }
  if (scriptCount === 0) {
    console.log(`${relPath}: no inline <script> blocks found (ok, may be static-only)`);
  } else {
    console.log(`${relPath}: ${scriptCount} inline <script> block(s) checked`);
  }
}

if (hadError) {
  console.error('\nClient syntax check FAILED.');
  process.exit(1);
} else {
  console.log('\nAll client-side inline scripts are syntactically valid.');
}
