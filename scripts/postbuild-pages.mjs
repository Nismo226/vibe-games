import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const gameDir = path.join(dist, 'ultimate-snake');

fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });

if (!fs.existsSync(gameDir)) {
  console.error('Expected game output at', gameDir);
  process.exit(1);
}

// Copy portal homepage to dist root
fs.copyFileSync(path.join(root, 'portal', 'index.html'), path.join(dist, 'index.html'));
fs.copyFileSync(path.join(root, 'portal', 'portal.css'), path.join(dist, 'portal.css'));

// Copy favicon to dist root
fs.copyFileSync(path.join(root, 'public', 'favicon.svg'), path.join(dist, 'favicon.svg'));

console.log('Pages postbuild complete. dist contains portal + /ultimate-snake/ game.');
