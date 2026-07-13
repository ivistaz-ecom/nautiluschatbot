import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

type DbConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

export type DocumentUpdateInput = {
  title: string;
  category_id: number;
  original_filename?: string;
};

export type UpdatedDocument = {
  id: number;
  title: string;
  original_filename: string;
  category_id: number;
  category_name: string;
  mime_type: string;
  file_size: number;
  status: string;
  created_at: string;
  updated_at: string;
};

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};

  const out: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }

  return out;
}

export function getDbConfig(): DbConfig | null {
  const fileEnv = parseEnvFile(path.join(process.cwd(), 'nautilusapi', '.env'));

  const host = process.env.API_DB_HOST || fileEnv.DB_HOST;
  const database = process.env.API_DB_NAME || fileEnv.DB_NAME;
  const user = process.env.API_DB_USER || fileEnv.DB_USER;
  const password = process.env.API_DB_PASSWORD ?? fileEnv.DB_PASS ?? '';
  const port = Number(process.env.API_DB_PORT || fileEnv.DB_PORT || 3306);

  if (!host || !database || !user) {
    return null;
  }

  return { host, port, database, user, password };
}

export async function verifyAdminToken(
  authHeader: string,
  apiBaseUrl: string
): Promise<boolean> {
  if (!authHeader) return false;

  const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/auth/me`, {
    headers: { Authorization: authHeader },
    cache: 'no-store',
  });

  if (!res.ok) return false;

  const payload = await res.json().catch(() => ({}));
  return (payload as { data?: { role?: string } }).data?.role === 'admin';
}

export async function updateDocumentInDb(
  id: number,
  input: DocumentUpdateInput
): Promise<UpdatedDocument> {
  const cfg = getDbConfig();
  if (!cfg) {
    throw new Error('DB_NOT_CONFIGURED');
  }

  const title = input.title.trim();
  const categoryId = input.category_id;
  let originalFilename = input.original_filename?.trim() ?? '';

  if (!title) {
    throw new Error('Document name is required');
  }

  if (!Number.isFinite(categoryId) || categoryId <= 0) {
    throw new Error('Invalid category');
  }

  if (originalFilename) {
    originalFilename = originalFilename.replace(/[^\w\s.\-()]/g, '_');
  }

  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
  });

  try {
    const [docRows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM documents WHERE id = ? LIMIT 1',
      [id]
    );
    if (!docRows.length) {
      throw new Error('Document not found');
    }

    const [catRows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM categories WHERE id = ? LIMIT 1',
      [categoryId]
    );
    if (!catRows.length) {
      throw new Error('Invalid category');
    }

    if (originalFilename) {
      await conn.execute(
        'UPDATE documents SET title = ?, category_id = ?, original_filename = ?, updated_at = NOW() WHERE id = ?',
        [title, categoryId, originalFilename, id]
      );
    } else {
      await conn.execute(
        'UPDATE documents SET title = ?, category_id = ?, updated_at = NOW() WHERE id = ?',
        [title, categoryId, id]
      );
    }

    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT d.*, c.name AS category_name
       FROM documents d
       JOIN categories c ON c.id = d.category_id
       WHERE d.id = ?
       LIMIT 1`,
      [id]
    );

    const row = rows[0];
    if (!row) {
      throw new Error('Document not found after update');
    }

    return {
      id: Number(row.id),
      title: String(row.title),
      original_filename: String(row.original_filename),
      category_id: Number(row.category_id),
      category_name: String(row.category_name),
      mime_type: String(row.mime_type),
      file_size: Number(row.file_size),
      status: String(row.status),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  } finally {
    await conn.end();
  }
}
