# Deploy API fixes (sources + PDF upload)

The Next.js frontend calls **https://nautilus.crafttechhub.com/api/v1**.
Local PHP under `nautilusapi/` does nothing until uploaded to that server.

## Upload these files to the live API host

Overwrite the matching paths on the server (same layout as this folder):

```
nautilusapi/api/v1/chat/ChatController.php
nautilusapi/index.php
nautilusapi/api/v1/documents/DocumentController.php   ← parsed_pages + admin file route
nautilusapi/services/DocumentParser.php
nautilusapi/services/LLMService.php
nautilusapi/services/SourceAttributor.php
nautilusapi/services/ChunkReranker.php
nautilusapi/worker.php
```

### PDF upload requires `DocumentController.php` + `index.php`

Admin uploads extract text in **Next.js**, save the PDF on PHP, then send pages as JSON to
`POST /admin/documents/:id/ingest-pages`.

Without the updated PHP files, uploads save the file but indexing fails with the scanned-PDF error.

**Deploy zip in repo root:** `nautilus-pdf-upload-fix.zip`

### Document edit (name + category)

Admin **Edit** calls `PUT /admin/documents/:id` (or fallbacks below).

**Without deploy, save shows:** *Document edit is not enabled on the server yet...*

#### Option A — upload ONE PHP file (production)

Upload **`nautilusapi/document-update.php`** to the **same folder as `index.php`**
(usually `public_html/api/v1/`). Zip: **`nautilus-document-edit.zip`**

Verify: `https://nautilus.crafttechhub.com/api/v1/document-update.php?id=1`  
→ **401** means the file is live (good). **404** means wrong folder.

#### Option B — database credentials in Next.js (local dev, no PHP upload)

1. Copy `.env.local.example` → `.env.local`
2. Add the same `DB_*` values from your server’s `nautilusapi/.env` (cPanel → MySQL)
3. Restart `npm run dev`

Document edit will update the live database directly when PHP routes are missing.

#### Full fix (optional)

Also upload `DocumentController.php` + `index.php` if you want all features (ingest-pages, etc.).

| Local file | Upload to server as |
|---|---|
| `nautilusapi/document-update.php` | `api/v1/document-update.php` |
| `nautilusapi/api/v1/documents/DocumentController.php` | same path |
| `nautilusapi/index.php` | same path |

**Verify full deploy:**

```
https://nautilus.crafttechhub.com/api/v1/health/document-update
```

Expected: `{"success":true,"data":{"document_update_route":true}}`

After deploy:

1. Admin → Documents → upload the PDF again (or Re-parse with file picker on error rows).
2. Status should become **ready**.
3. Check logs for `[DOC_PARSE] Using parsed_pages from upload request` or `ingest-pages`.

## After upload

1. Confirm `GET /api/v1/health/document-file` returns JSON (optional sanity check).
2. Admin → Documents → upload `03_Bulk Cargo Manual.pdf` again (or Re-parse).
3. Status should become **ready**, not **error**.
4. Check `nautilusapi/logs/app.log` for `[DOC_PARSE] Using parsed_pages from upload request`.

## Chat source attribution

1. Ask a **new** question in chat.
2. Check `nautilusapi/logs/app.log` for `[chat-response] sources.length=1` (or higher).
3. In browser Network tab → `POST /chat/ask` → response `data.sources` must be non-empty when answered from docs.
