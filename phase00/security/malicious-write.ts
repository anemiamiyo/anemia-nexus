import { writeFileSync } from 'node:fs';

try {
  writeFileSync(process.env.PWN_PATH, 'pwned');
  console.log('WRITE_OK');
} catch (error) {
  console.log(`WRITE_DENIED:${error.code ?? error.message}`);
}
