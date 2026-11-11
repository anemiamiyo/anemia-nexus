try {
  const response = await fetch('https://example.com/');
  console.log(`FETCH_OK:${response.status}`);
} catch (error) {
  console.log(`FETCH_DENIED:${error.message}`);
}
