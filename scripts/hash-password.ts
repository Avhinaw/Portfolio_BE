import argon2 from 'argon2';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  const password = process.argv[2] ?? (process.stdin.isTTY ? '' : await readStdin());
  if (!password || password.length < 12) {
    console.error('Usage: echo -n "<password, 12+ chars>" | npm run hash-password --silent');
    console.error('   or: npm run hash-password --silent -- "<password>"   (beware of shell history)');
    process.exit(1);
  }
  // OWASP-recommended Argon2id parameters: 19 MiB memory, 2 iterations, 1 lane.
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  console.log("Put this in .env (keep the single quotes so '$' is not interpolated):\n");
  console.log(`HOST_PASSWORD_HASH='${hash}'`);
}

void main();
