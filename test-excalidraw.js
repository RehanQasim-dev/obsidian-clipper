const fs = require('fs');
const js = fs.readFileSync('node_modules/@excalidraw/excalidraw/dist/excalidraw.production.min.js', 'utf8');
const match = js.match(/.{0,50}shortcut.{0,50}/gi);
console.log(match ? match.slice(0, 10) : "no match");
