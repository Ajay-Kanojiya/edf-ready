// Gemini responseSchema describing every EDF field this app can autofill.
// Each leaf field is wrapped so the model must state how confident/sourced
// each value is (extracted = verbatim from the document, ai_suggested =
// inferred/derived, missing = not available).

const STATUS_ENUM = ["extracted", "ai_suggested", "missing"];

function field(valueSchema) {
  return {
    type: "OBJECT",
    properties: {
      value: valueSchema,
      status: { type: "STRING", enum: STATUS_ENUM },
      confidence: { type: "NUMBER" },
      rationale: { type: "STRING" },
    },
    required: ["value", "status"],
  };
}

const STR = { type: "STRING" };
const NUM = { type: "NUMBER" };
const strField = field(STR);
const numField = field(NUM);
const arrField = field({ type: "ARRAY", items: STR });

const particularRow = {
  type: "OBJECT",
  properties: {
    currency: strField,
    amount: numField,
  },
};

const serviceRow = {
  type: "OBJECT",
  properties: {
    recipientNameAddress: strField,
    country: strField,
    invoiceNo: strField,
    invoiceDate: strField,
    currency: strField,
    amount: numField,
    netRealisableValue: numField,
    contractNoDate: strField,
    descriptionOfServices: strField,
    sacCode: strField,
    remarks: strField,
  },
};

const EDF_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    generalInfo: {
      type: "OBJECT",
      properties: {
        exportType: strField, // "Goods" | "Service"
        formNo: strField,
        shippingBillNo: strField,
        shippingBillDate: strField, // ISO yyyy-mm-dd
        modeOfTransport: arrField, // subset of Air, Land, Sea, Post/Couriers, Internet, others
        exporterCategory: strField, // one of: Custom (DTA units), SEZ, 100% EOU, Warehouse export, others
        exporterCategoryOtherSpecify: strField,
        adCode: strField,
        ieCode: strField,
        gstin: strField,
        pan: strField,
        adNameAddress: strField,
        exportersNameAddress: strField,
        modeOfRealisation: arrField, // subset of L/C, BG, Others
        consigneeNameAddress: strField,
        portOfLoading: strField,
        thirdPartyNameAddress: strField,
        relationshipExporterThirdParty: strField,
        countryOfFinalDestination: strField,
        portOfDischarge: strField,
        dateOfLEO: strField,
        adNameAdCodeForLCBG: strField,
        descriptionOfGoods: strField,
        fobInWords: strField, // computed/derived total FOB value spelled out in words (INR)
      },
    },
    invoiceDetails: {
      type: "OBJECT",
      properties: {
        clientNameAddress: strField,
        invoiceNo: strField,
        invoiceDate: strField,
        invoiceCurrency: strField,
        invoiceAmount: numField,
        contractNoDate: strField,
        natureOfPayment: arrField, // subset of FOB, CIF, C&F, CI, periodical, milestone, advance, others
        hsnSacCode: strField,
      },
    },
    particulars: {
      type: "OBJECT",
      properties: {
        fob: particularRow,
        freight: particularRow,
        insurance: particularRow,
        commission: particularRow,
        discount: particularRow,
        otherDeduction: particularRow,
        packingCharges: particularRow,
      },
    },
    services: { type: "ARRAY", items: serviceRow },
    fpo: {
      type: "OBJECT",
      properties: {
        fpoNameAddress: strField,
        parcelReceiptNoDate: strField,
      },
    },
    declaration: {
      type: "OBJECT",
      properties: {
        declarationDate: strField,
        realisationDeadlineDate: strField,
      },
    },
  },
};

const EXTRACTION_PROMPT = `You are an expert customs/trade-finance clerk filling out an Indian Export Declaration Form (EDF) from a source document (commercial invoice, packing list, or shipping bill) or pasted free text.

Return ONLY JSON matching the provided schema. Do not invent data.

Rules for every leaf field:
- status "extracted": use this only when the value appears verbatim (or near-verbatim) in the source document/text. Do not label an inferred value as extracted.
- status "ai_suggested": use this only when the value is not stated anywhere in the source and must be inferred or derived (e.g. HSN/SAC code guessed from a goods/service description, country inferred from an address, FOB value spelled out in words, AD code looked up from a bank name). Always include a short "rationale" and a "confidence" between 0 and 1 for these.
- Before marking any field "ai_suggested", search the entire uploaded document/text for that value and equivalent formatting. If the value is present anywhere in the source, mark it "extracted" instead. Never show an AI suggestion label for a value that was read from the document.
- status "missing": no reasonable value can be determined. Leave "value" empty and omit confidence/rationale.
- Dates must be formatted as ISO "yyyy-mm-dd" when a date is recognizable.
- Currency values must be plain numbers (no symbols, no thousands separators).
- "modeOfTransport", "modeOfRealisation", and "natureOfPayment" are arrays — only include options that are clearly supported by the document (valid options are listed in the schema description/comments above).
- "services" is an array with one entry per distinct service line item found; omit it entirely if the shipment is goods-only.
- For every service row, populate "sacCode" from the source when stated. If it is not stated but the service description is specific enough, suggest the most appropriate Indian SAC code, mark it "ai_suggested", and include a brief rationale and confidence. Only mark it "missing" when the description is too vague to support a reasonable SAC suggestion.
- Never fabricate an IE Code, GSTIN, PAN, AD code, or signature-related detail that is not present in the source.`;

// Gemini's responseSchema validator rejects EDF_RESPONSE_SCHEMA once it grows past a
// certain size/complexity (observed: fails above ~10KB serialized). As a fallback when
// the strict schema call errors out, we ask for the same JSON shape via plain prompt
// text (schema-less JSON mode) so the form still gets populated with a best-effort result.
function exampleShapeFor(node) {
  if (node.type === "ARRAY") return [exampleShapeFor(node.items)];
  if (node.type === "OBJECT") {
    if (node.properties && node.properties.value && node.properties.status) {
      const valuePlaceholder = node.properties.value.type === "ARRAY" ? ["..."] : node.properties.value.type === "NUMBER" ? 0 : "...";
      return { value: valuePlaceholder, status: "extracted|ai_suggested|missing", confidence: 0.0, rationale: "..." };
    }
    const obj = {};
    Object.entries(node.properties || {}).forEach(([key, child]) => {
      obj[key] = exampleShapeFor(child);
    });
    return obj;
  }
  return "...";
}

const FALLBACK_JSON_SHAPE = JSON.stringify(exampleShapeFor(EDF_RESPONSE_SCHEMA), null, 2);

const FALLBACK_EXTRACTION_PROMPT = `${EXTRACTION_PROMPT}

Return JSON that matches exactly this shape and key names (this is a template, not real data — fill in real values, and use an empty array for "services" if there are none):
${FALLBACK_JSON_SHAPE}`;

module.exports = { EDF_RESPONSE_SCHEMA, EXTRACTION_PROMPT, FALLBACK_EXTRACTION_PROMPT };

