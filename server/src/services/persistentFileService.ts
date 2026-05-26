import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function tempPathFor(targetPath: string): string {
  return `${targetPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

export async function atomicWriteTextFile(
  targetPath: string,
  content: string
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tmp = tempPathFor(targetPath);
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, targetPath);
}

export async function atomicWriteJsonFile(
  targetPath: string,
  value: unknown
): Promise<void> {
  await atomicWriteTextFile(targetPath, JSON.stringify(value, null, 2));
}
