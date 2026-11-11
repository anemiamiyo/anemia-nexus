/**
 * Warning filter must be installed before anemia-core imports `node:sqlite`,
 * otherwise Node prints ExperimentalWarning to stderr on every invocation.
 */
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const { run } = await import('./cli.js');
const exitCode = await run(process.argv);
process.exitCode = exitCode;
