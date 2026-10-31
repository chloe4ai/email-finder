// Copies the shared engine into extension/engine/ (Chrome can only load files
// inside the extension folder). `--zip` also writes dist/email-finder-extension-<version>.zip
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.join(import.meta.dirname, '..');
const src = path.join(root, 'engine');
const dst = path.join(root, 'extension', 'engine');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`engine → extension/engine (${fs.readdirSync(dst).length} files)`);

if (process.argv.includes('--zip')) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, `email-finder-extension-${version}.zip`);
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-qr', out, 'extension', '-x', '*.DS_Store', 'extension/icon.svg'], { cwd: root });
  console.log(`→ ${out}`);
}
