// Last-resort fallback used only when both Gemini extraction tiers fail (e.g. free-tier
// quota exhausted). Extracts raw text locally (no AI, no network call) — real OCR for
// image uploads, embedded text extraction for PDFs — then applies simple regex heuristics
// to fill in whatever fields can be confidently found.
const { createWorker } = require("tesseract.js");
const { PDFParse } = require("pdf-parse");

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function isOcrEligible(mimeType) {
  return IMAGE_MIME_TYPES.has(mimeType) || mimeType === "application/pdf";
}

async function runOcr(buffer, mimeType) {
  if (mimeType === "application/pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const { text } = await parser.getText();
      return text || "";
    } finally {
      await parser.destroy();
    }
  }
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(buffer);
    return data.text || "";
  } finally {
    await worker.terminate();
  }
}

function field(value, rationale) {
  if (!value) return { value: "", status: "missing" };
  return { value, status: "ai_suggested", confidence: 0.35, rationale };
}

function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : "";
}

function toIsoDate(raw) {
  if (!raw) return "";
  const m = raw.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (!m) return raw;
  let [, d, mo, y] = m;
  if (y.length === 2) y = `20${y}`;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Best-effort regex extraction over raw OCR text — intentionally conservative (returns
// "missing" rather than guessing wrong) since there is no AI reasoning behind these matches.
function heuristicParseEDF(rawText) {
  const text = rawText.replace(/\r/g, "");
  const rationale = "Regex-based OCR fallback (AI extraction unavailable)";

  const formNo = firstMatch(text, /form\s*no\.?\s*[:\-]?\s*([A-Z0-9\/\-]{4,})/i);
  const shippingBillNo = firstMatch(text, /shipping\s*bill\s*no\.?\s*[:\-]?\s*([A-Z0-9\/\-]{3,})/i);
  const shippingBillDateRaw = firstMatch(text, /shipping\s*bill[^\n]*?(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i);
  const invoiceNo = firstMatch(text, /invoice\s*no\.?\s*[:\-]?\s*([A-Z0-9\/\-]{3,})/i);
  const invoiceDateRaw = firstMatch(text, /invoice\s*date\.?\s*[:\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i);
  const invoiceCurrency = firstMatch(text, /\b(USD|EUR|GBP|INR|JPY|AUD|CAD|AED|SGD)\b/);
  const invoiceAmount = firstMatch(text, /(?:amount|value|total)[^\n\d]{0,15}([\d,]+\.\d{2})/i);
  const gstin = firstMatch(text, /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d])\b/);
  const pan = firstMatch(text, /\b([A-Z]{5}\d{4}[A-Z])\b/);
  const ieCode = firstMatch(text, /IE\s*Code\s*[:\-]?\s*(\d{7,10})/i);
  const adCode = firstMatch(text, /AD\s*code\s*[:\-]?\s*(\d{5,8})/i);
  const hsnSacCode = firstMatch(text, /(?:HSN|SAC)[^\d]{0,10}([\d.]{4,10})/i);
  const contractNoDate = firstMatch(text, /contract\s*no\.?\s*[:\-]?\s*([A-Z0-9\/\-\s.]{4,40})/i);

  return {
    generalInfo: {
      formNo: field(formNo, rationale),
      shippingBillNo: field(shippingBillNo, rationale),
      shippingBillDate: field(toIsoDate(shippingBillDateRaw), rationale),
      ieCode: field(ieCode, rationale),
      gstin: field(gstin, rationale),
      pan: field(pan, rationale),
      adCode: field(adCode, rationale),
    },
    invoiceDetails: {
      invoiceNo: field(invoiceNo, rationale),
      invoiceDate: field(toIsoDate(invoiceDateRaw), rationale),
      invoiceCurrency: field(invoiceCurrency, rationale),
      invoiceAmount: invoiceAmount ? { value: Number(invoiceAmount.replace(/,/g, "")), status: "ai_suggested", confidence: 0.3, rationale } : { value: "", status: "missing" },
      contractNoDate: field(contractNoDate, rationale),
      hsnSacCode: field(hsnSacCode, rationale),
    },
  };
}

module.exports = { isOcrEligible, runOcr, heuristicParseEDF };
