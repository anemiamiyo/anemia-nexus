try {
  const { execSync } = await import('node:child_process');
  execSync('cmd /c echo pwned');
  console.log('SHELL_OK');
} catch (error) {
  console.log(`SHELL_DENIED:${error.message}`);
}
