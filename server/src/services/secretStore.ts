import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDeepCodeConfigDir } from './appDataPath.js';

interface StoredSecret {
  iv: string;
  tag: string;
  value: string;
}

type SecretFile = Record<string, StoredSecret>;

const SECRET_DIR = join(resolveDeepCodeConfigDir(), 'secrets');
const STORE_PATH = join(SECRET_DIR, 'llm-secrets.json');
const MASTER_KEY_PATH = join(SECRET_DIR, 'master.key');

let cache: SecretFile | null = null;

function deriveKey(raw: string): Buffer {
  return createHash('sha256').update(raw, 'utf-8').digest();
}

async function loadMasterKey(): Promise<Buffer> {
  const envKey = process.env.DEEPCODE_SECRET_KEY;
  if (envKey && envKey.trim()) {
    return deriveKey(envKey.trim());
  }

  try {
    const raw = await readFile(MASTER_KEY_PATH, 'utf-8');
    return deriveKey(raw.trim());
  } catch {
    await mkdir(SECRET_DIR, { recursive: true });
    const generated = randomBytes(32).toString('base64url');
    await writeFile(MASTER_KEY_PATH, generated, 'utf-8');
    try {
      await chmod(MASTER_KEY_PATH, 0o600);
    } catch {
      // Windows may not honor chmod here; the UI should still treat this as local-only storage.
    }
    return deriveKey(generated);
  }
}

async function loadStore(): Promise<SecretFile> {
  if (cache) return cache;
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as SecretFile
      : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persistStore(store: SecretFile): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
  await rename(tmp, STORE_PATH);
  try {
    await chmod(STORE_PATH, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

function secretRefForProfile(profileId: string): string {
  return `llm:${profileId}`;
}

export function getSecretStorePath(): string {
  return STORE_PATH;
}

export async function saveLlmSecret(profileId: string, apiKey: string): Promise<string> {
  const secretRef = secretRefForProfile(profileId);
  const key = await loadMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(apiKey, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const store = await loadStore();
  store[secretRef] = {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    value: encrypted.toString('base64'),
  };
  await persistStore(store);
  return secretRef;
}

export async function getLlmSecret(secretRef: string | undefined): Promise<string | null> {
  if (!secretRef) return null;
  const store = await loadStore();
  const entry = store[secretRef];
  if (!entry) return null;

  const key = await loadMasterKey();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(entry.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(entry.value, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf-8');
}

export async function deleteLlmSecret(secretRef: string | undefined): Promise<void> {
  if (!secretRef) return;
  const store = await loadStore();
  if (secretRef in store) {
    delete store[secretRef];
    await persistStore(store);
  }
}
