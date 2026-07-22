import fs from 'fs';
import path from 'path';
import os from 'os';

export type DocumentOverride = {
  title: string;
  original_filename?: string;
  category_id: number;
  category_name?: string;
  updated_at: string;
};

function resolveStorePath(): string {
  // Vercel’s app filesystem is read-only; prefer /tmp when cwd/data is not writable.
  const primaryDir = path.join(process.cwd(), 'data');
  try {
    if (!fs.existsSync(primaryDir)) {
      fs.mkdirSync(primaryDir, { recursive: true });
    }
    fs.accessSync(primaryDir, fs.constants.W_OK);
    return path.join(primaryDir, 'document-overrides.json');
  } catch {
    const tmpDir = path.join(os.tmpdir(), 'nautilus-overrides');
    try {
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      return path.join(tmpDir, 'document-overrides.json');
    } catch {
      return path.join(primaryDir, 'document-overrides.json');
    }
  }
}

function readAll(): Record<string, DocumentOverride> {
  try {
    const file = resolveStorePath();
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, DocumentOverride>): void {
  const file = resolveStorePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function getDocumentOverrides(): Record<string, DocumentOverride> {
  return readAll();
}

export function getDocumentOverride(id: number): DocumentOverride | null {
  return readAll()[String(id)] ?? null;
}

export function saveDocumentOverride(
  id: number,
  patch: Omit<DocumentOverride, 'updated_at'>
): DocumentOverride {
  const all = readAll();
  const entry: DocumentOverride = {
    ...patch,
    updated_at: new Date().toISOString(),
  };
  all[String(id)] = entry;
  try {
    writeAll(all);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to write overrides';
    throw new Error(`OVERRIDE_STORE_READONLY:${message}`);
  }
  return entry;
}

export function clearDocumentOverride(id: number): void {
  try {
    const all = readAll();
    if (!(String(id) in all)) return;
    delete all[String(id)];
    writeAll(all);
  } catch {
    // Best-effort — never block a successful live DB update.
  }
}
