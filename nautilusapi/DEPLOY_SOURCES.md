# Deploy API source-attribution fix

The Next.js frontend calls **https://nautilus.crafttechhub.com/api/v1**.
Local PHP under `nautilusapi/` does nothing until uploaded to that server.

## Upload these files to the live API host

Overwrite the matching paths on the server (same layout as this folder):

```
nautilusapi/api/v1/chat/ChatController.php
nautilusapi/api/v1/documents/DocumentController.php
nautilusapi/services/LLMService.php
nautilusapi/services/DocumentParser.php
nautilusapi/services/SourceAttributor.php   ← NEW (required)
nautilusapi/services/ChunkReranker.php      ← NEW (required)
nautilusapi/worker.php
```

## After upload

1. Confirm the new files exist on the server:
   - `services/SourceAttributor.php`
   - `services/ChunkReranker.php`
2. Ask a **new** question in chat (avoid FAQ-cache-only repeats if possible).
3. Check `nautilusapi/logs/app.log` for:
   - `[chat-response] sources.length=1` (or higher)
4. In browser Network tab → `POST /chat/ask` → response `data.sources` must be a non-empty array.

## Expected response shape

```json
{
  "success": true,
  "data": {
    "answer": "...",
    "sources": [
      {
        "fileId": 3,
        "fileName": "Safety Management Manual",
        "pageNumber": 49,
        "pdfUrl": "/api/v1/chat/documents/3/file?token=..."
      }
    ],
    "is_answered": true
  }
}
```

If `sources` is `[]`, the frontend correctly hides the PDF cards.
