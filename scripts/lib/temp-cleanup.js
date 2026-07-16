import { rm } from 'node:fs/promises';

export async function removeTemporaryDirectory(target, { remove = rm } = {}) {
  await remove(target, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
}
