# Smart EDF AI Autofill

Stateless AI autofill for the Export Declaration Form (EDF), powered by the Google Gemini API.

- `server/` — tiny Express proxy. Holds the Gemini API key server-side, accepts a file upload
  or pasted text at `POST /api/extract`, returns structured JSON. No DB, no disk writes, no login.
  Also serves `frontend/` as static files so everything runs from one origin (no CORS needed).
- `frontend/` — the EDF form (vanilla JS + Tailwind CDN, no build step) wired to call the backend.

## Run it

```bash
cd server
cp .env.example .env   # then edit .env and set GEMINI_API_KEY
npm install
npm start
```

Open http://localhost:8000 — upload an invoice/shipping bill (PDF/PNG/JPG/WEBP, up to 10MB) or
use "Paste text instead", then click "✨ Extract with AI". Fields are tagged **✓ Extracted**
(verbatim from the document) or **✨ AI Suggested** (inferred, with a confidence %).

## Privacy

Uploaded files/text are sent to Gemini for a single extraction call and never written to disk
or a database. "Download Draft" only writes a `.json` file to your own device — nothing is
sent to or stored on the server.
