import { cp } from 'node:fs/promises';

const src = new URL('../fonts/', import.meta.url);
const dst = new URL('../public/fonts/', import.meta.url);
await cp(src, dst, { recursive: true });
console.log('fonts copied');
