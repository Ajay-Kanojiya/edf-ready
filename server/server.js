require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");
const { EDF_RESPONSE_SCHEMA, EXTRACTION_PROMPT, FALLBACK_EXTRACTION_PROMPT } = require("./schema");
const { isOcrEligible, runOcr, heuristicParseEDF } = require("./ocrFallback");

const PORT = Number(process.env.PORT) || 3001;
const AI_PROVIDER = "openrouter";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite";
const OPENROUTER_MODELS = [OPENROUTER_MODEL];
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || `http://localhost:${PORT}`;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 30;

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_CHARS = 20000;
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

if (!OPENROUTER_API_KEY) {
  console.error("Missing OPENROUTER_API_KEY. Set it in server/.env.");
  process.exit(1);
}

const app = express();

app.use((req, res, next) => {
  const startedAt = Date.now();
  console.log(`[http] ${req.method} ${req.path}`);
  res.on("finish", () => {
    console.log(`[http] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });
  next();
});

// Same-origin by default (this server also serves the frontend static files).
// Only relevant when the frontend is hosted separately from this API.
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

const extractLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many extraction requests. Please wait a few minutes and try again." },
});

const upload = multer({
  storage: multer.memoryStorage(), // in-memory only, never written to disk
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new Error("UNSUPPORTED_FILE_TYPE"));
      return;
    }
    cb(null, true);
  },
});

function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Maximum size is 10MB." });
    }
    if (err.message === "UNSUPPORTED_FILE_TYPE") {
      return res.status(400).json({ error: "Unsupported file type. Please upload a PDF, PNG, JPG, or WEBP." });
    }
    return res.status(400).json({ error: "Could not read the uploaded file." });
  });
}

async function callGeminiRaw({ inlineFile, text, promptText, schema }) {
  const parts = [{ text: promptText }];
  if (inlineFile) {
    parts.push({ inlineData: { mimeType: inlineFile.mimetype, data: inlineFile.buffer.toString("base64") } });
  } else {
    parts.push({ text: `Source text:\n\n${text}` });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

  const generationConfig = { responseMimeType: "application/json" };
  if (schema) generationConfig.responseSchema = schema;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig,
    }),
  });

  if (!response.ok) {
    // Never forward upstream body (may echo request details) — log server-side only.
    const errText = await response.text().catch(() => "");
    console.error("Gemini API error", response.status, errText.slice(0, 500));
    throw new Error("UPSTREAM_ERROR");
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("EMPTY_RESPONSE");

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("INVALID_JSON_RESPONSE");
  }
}

// Gemini's strict responseSchema validator can reject EDF_RESPONSE_SCHEMA once it grows
// too large/complex (undocumented limit). If that structured call fails for any reason,
// fall back to a schema-less JSON-mode call (same field shape, described in the prompt
// text instead of a formal schema) so the form still gets populated best-effort.
async function callGemini({ inlineFile, text }) {
  try {
    return await callGeminiRaw({ inlineFile, text, promptText: EXTRACTION_PROMPT, schema: EDF_RESPONSE_SCHEMA });
  } catch (err) {
    console.error("Structured extraction failed, falling back to schema-less JSON mode:", err.message);
    return callGeminiRaw({ inlineFile, text, promptText: FALLBACK_EXTRACTION_PROMPT, schema: null });
  }
}

function parseModelJson(raw) {
  const withoutFence = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("INVALID_JSON_RESPONSE");

    const candidate = withoutFence.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
    const closers = [];
    let inString = false;
    let escaped = false;
    for (const character of candidate) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === "{" || character === "[") closers.push(character === "{" ? "}" : "]");
      if (character === "}" || character === "]") closers.pop();
    }

    try {
      return JSON.parse(candidate + closers.reverse().join(""));
    } catch {
      throw new Error("INVALID_JSON_RESPONSE");
    }
  }
}

function sanitizeExtractedData(value) {
  if (typeof value === "string") {
    return value.replace(/[\uE000-\uF8FF]/g, "-").replace(/[‐‑‒–—−]/g, "-");
  }
  if (Array.isArray(value)) return value.map(sanitizeExtractedData);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeExtractedData(child)]));
  }
  return value;
}

function extractPanFromSource(sourceText) {
  const labeledMatch = String(sourceText || '').match(/(?:PAN|Permanent\s+Account\s+Number|Income\s+Tax\s+PAN)[^\nA-Z0-9]{0,20}([A-Z](?:\s*[A-Z]){4}\s*\d(?:\s*\d){3}\s*[A-Z])/i);
  const compactMatch = String(sourceText || '').match(/\b([A-Z]{5}\d{4}[A-Z])\b/i);
  return (labeledMatch?.[1] || compactMatch?.[1] || '').replace(/\s+/g, '').toUpperCase();
}

function ensurePanFromSource(result, sourceText) {
  const pan = extractPanFromSource(sourceText);
  if (!pan) return result;
  const generalInfo = result && typeof result.generalInfo === 'object' ? result.generalInfo : {};
  const existingPan = generalInfo.pan && String(generalInfo.pan.value || '').replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]{5}\d{4}[A-Z]$/.test(existingPan)) return result;
  return {
    ...result,
    generalInfo: {
      ...generalInfo,
      pan: {
        value: pan,
        status: 'extracted',
        confidence: 1,
        rationale: 'Matched the PAN shown in the source document.'
      }
    }
  };
}

function ensureIndividualExporterCategory(result, sourceText) {
  const source = String(sourceText || '');
  const generalInfo = result && typeof result.generalInfo === 'object' ? result.generalInfo : {};
  const category = String(generalInfo.exporterCategory?.value || '').toLowerCase();
  const detail = String(generalInfo.exporterCategoryOtherSpecify?.value || '').trim();
  const sourceIdentifiesIndividual = /\bindividual\b/i.test(source);
  const categoryIdentifiesIndividual = category.includes('individual') || detail.toLowerCase().includes('individual');
  if (!sourceIdentifiesIndividual && !categoryIdentifiesIndividual) return result;
  return {
    ...result,
    generalInfo: {
      ...generalInfo,
      exporterCategory: category.includes('individual') && !category.includes('other')
        ? { value: 'others', status: 'ai_suggested', confidence: 0.9, rationale: 'Individual exporter mapped to Other (Specify).' }
        : generalInfo.exporterCategory,
      exporterCategoryOtherSpecify: {
        value: 'Individual',
        status: categoryIdentifiesIndividual ? (generalInfo.exporterCategoryOtherSpecify?.status || 'ai_suggested') : 'extracted',
        ...(generalInfo.exporterCategoryOtherSpecify?.confidence !== undefined ? { confidence: generalInfo.exporterCategoryOtherSpecify.confidence } : { confidence: sourceIdentifiesIndividual ? 1 : 0.9 }),
        rationale: 'Individual exporter identified from the source document.'
      }
    }
  };
}

async function callOpenRouter({ inlineFile, text }) {
  let sourceText = text;
  if (inlineFile) {
    // Nemotron Ultra is used here as a text model. Extract text locally first so
    // PDFs and image invoices still work without sending binary data upstream.
    sourceText = await runOcr(inlineFile.buffer, inlineFile.mimetype);
  }

  let lastError = "UPSTREAM_ERROR";
  for (const model of OPENROUTER_MODELS) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": FRONTEND_ORIGIN,
        "X-Title": "Smart EDF Autofill",
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: `${FALLBACK_EXTRACTION_PROMPT}\n\nSource text:\n\n${sourceText || "No readable source text was found."}`,
        }],
        response_format: { type: "json_object" },
        reasoning: { exclude: true },
        max_tokens: 12000,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      lastError = response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_ERROR";
      console.error(`OpenRouter API error model=${model} status=${response.status}`, errText.slice(0, 500));
      continue;
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) {
      lastError = "EMPTY_RESPONSE";
      continue;
    }
    console.log(`[openrouter] model=${model} response:`, raw);
    return ensureIndividualExporterCategory(ensurePanFromSource(parseModelJson(raw), sourceText), sourceText);
  }

  throw new Error(lastError);
}

// Last resort when both Gemini calls fail (e.g. free-tier quota exhausted): run real local
// OCR (no AI, no network) on the image and apply simple regex heuristics so the form still
// gets populated with whatever can be confidently found, instead of a hard failure.
async function extractWithOcrFallback({ inlineFile }) {
  if (!inlineFile || !isOcrEligible(inlineFile.mimetype)) {
    throw new Error("OCR_FALLBACK_NOT_ELIGIBLE");
  }
  const rawText = await runOcr(inlineFile.buffer, inlineFile.mimetype);
  const result = heuristicParseEDF(rawText);
  result._meta = { method: "ocr-fallback" };
  return result;
}

app.post("/api/extract", extractLimiter, handleUpload, async (req, res) => {
  try {
    const file = req.file;
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

    if (!file && !text) {
      return res.status(400).json({ error: "Provide a file upload or pasted text." });
    }
    if (text && text.length > MAX_TEXT_CHARS) {
      return res.status(400).json({ error: `Pasted text is too long (max ${MAX_TEXT_CHARS} characters).` });
    }

    console.log(`[extract] provider=${AI_PROVIDER} input=${file ? `file:${file.mimetype}` : "pasted-text"}`);

    let result;
    try {
      result = AI_PROVIDER === "openrouter"
        ? await callOpenRouter({ inlineFile: file, text: file ? undefined : text })
        : await callGemini({ inlineFile: file, text: file ? undefined : text });
    } catch (aiErr) {
      console.error(`All ${AI_PROVIDER} tiers failed, attempting OCR fallback:`, aiErr.message);
      result = await extractWithOcrFallback({ inlineFile: file });
    }
    result = sanitizeExtractedData(result);
    console.log(`[extract] completed method=${result?._meta?.method || AI_PROVIDER}`);
    res.json(result);
  } catch (err) {
    console.error("Extraction failed:", err.message);
    res.status(502).json({ error: "Extraction failed. Please try again." });
  }
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Private IDFC-specific EDF form: HTTP Basic auth over HTTPS; disabled unless a password (or password hash) is configured.
const IDFC_ACCESS_USER = process.env.IDFC_ACCESS_USER || "idfc";
const IDFC_ACCESS_PASSWORD = process.env.IDFC_ACCESS_PASSWORD;
const IDFC_PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function safeEqual(a, b) {
  const hash = (value) => crypto.createHash("sha256").update(String(value)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function idfcEnabled(_req, res, next) {
  if (!IDFC_ACCESS_PASSWORD) return res.status(404).end();
  return next();
}

// Passwords must travel over TLS; plain HTTP is only tolerated for direct localhost development.
function requireHttps(req, res, next) {
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.set("Strict-Transport-Security", "max-age=31536000");
    return next();
  }
  const hostHeader = String(req.headers.host || "");
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (!req.headers["x-forwarded-for"] && ["localhost", "127.0.0.1", "[::1]"].includes(host)) return next();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(hostHeader)) return res.status(400).end();
  if (req.method === "GET" || req.method === "HEAD") return res.redirect(308, `https://${hostHeader}${req.originalUrl}`);
  return res.status(403).send("HTTPS is required.");
}

function requireIdfcAccess(req, res, next) {
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString();
    const sep = decoded.indexOf(":");
    if (sep > -1) {
      const password = decoded.slice(sep + 1);
      const userOk = safeEqual(decoded.slice(0, sep), IDFC_ACCESS_USER);
      const passOk = password.length <= 256 && safeEqual(password, IDFC_ACCESS_PASSWORD);
      if (userOk && passOk) {
        res.set(IDFC_PRIVATE_HEADERS);
        return next();
      }
    }
  }
  res.set({ ...IDFC_PRIVATE_HEADERS, "WWW-Authenticate": 'Basic realm="IDFC EDF", charset="UTF-8"' });
  return res.status(401).send("Authentication required.");
}

const idfcAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
});

// Old login-page URL (bookmarks/history) now just goes to the protected form.
app.get("/clients/idfc/login", (_req, res) => res.redirect("/clients/idfc/"));

app.use("/clients/idfc", idfcEnabled, requireHttps, idfcAuthLimiter, requireIdfcAccess, express.static(path.join(__dirname, "private", "idfc")));

// Serve the static frontend from the same origin (avoids CORS entirely by default).
app.use(express.static(path.join(__dirname, "..", "frontend")));

// Centralized error handler — never leak stack traces or the API key.
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Smart EDF Autofill server listening on ${FRONTEND_ORIGIN}`);
});
