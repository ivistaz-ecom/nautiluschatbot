import fs from 'fs';
import path from 'path';

export type DocumentOverride = {
  title: string;
  original_filename?: string;
  category_id: number;
  category_name?: string;
  updated_at: string;
};

const DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'document-overrides.json');

function readAll(): Record<string, DocumentOverride> {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, DocumentOverride>): void {
  if (!fs.existsSync(DIR)) {
    fs.mkdirSync(DIR, { recursive: true });
  }
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
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
  writeAll(all);
  return entry;
}
