// Backwards-compatible entrypoint. Setup never deletes the other security cases.
if (!process.argv.includes('--test')) process.argv.push('--test', 'IA01');
await import('./run-security-attacks.js');

export {};
