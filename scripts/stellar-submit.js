export async function sendAndWait(rpc, tx, label) {
  const result = await rpc.sendTransaction(tx);
  if (result.status === 'ERROR') {
    throw new Error(`${label} failed to submit: ${JSON.stringify(result)}`);
  }

  for (;;) {
    const final = await rpc.getTransaction(result.hash);
    if (final.status === 'SUCCESS') {
      return result.hash;
    }
    if (final.status === 'FAILED') {
      throw new Error(`${label} failed on-chain: ${JSON.stringify(final)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
