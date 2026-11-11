import { readFileSync } from 'node:fs';

try {
  const text = readFileSync(process.env.SECRET_PATH, 'utf8');
  console.log(`READ_OK:${text.length}`);
} catch (error) {
  console.log(`READ_DENIED:${error.code ?? error.message}`);
}
