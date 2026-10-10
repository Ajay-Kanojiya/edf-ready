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
        exportType: strField, // "Software" | "Service" | "Goods"
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
- For each service row, rewrite long source text into one meaningful, complete service phrase of no more than 12 words, retaining the core service type and important technical context (for example, "Android and web application development"). Remove boilerplate, repeated wording, addresses, dates, and full paragraphs. Do not simply cut off the first 12 words; understand the source and create a concise summary. Use the short source wording unchanged when it is already concise.
- For each service row, keep "remarks" short and clear: use a brief note of no more than 8 words, remove boilerplate and repeated details, and do not duplicate the service description. Use "No remarks" only when the source explicitly indicates there are none; otherwise leave it missing when no remark is stated.
- For each service row, "netRealisableValue" means the net amount expected to be received after any deductions, fees, discounts, freight, insurance, commission, or other adjustments stated in the source. Calculate it from the invoice amount when possible. If no allowable deduction is stated, use the invoice amount as the NRV. Mark a calculated NRV as "ai_suggested" with a short rationale; never copy explanatory definition text into the value.
- For every service row, determine "sacCode" using this strict order: (1) search the entire source, including headers, line items, notes, tax sections, and footers, for labels such as SAC, Service Accounting Code, or related code columns; when a code is present, copy the exact digits and mark it "extracted"; (2) only when no code is present anywhere, classify the specific service activity described in the source against the most precise applicable Indian SAC category, not a broad or generic IT/business category, and mark that value "ai_suggested" with a rationale tied to the actual service wording; (3) mark it "missing" when the source does not provide a code and the service wording is too vague to distinguish between nearby categories. Never invent a code, guess from the invoice number, or use a code merely because it is common. SAC values should normally be six-digit numeric strings and must not include currency, tax rates, punctuation, or explanatory text.
- For PAN, search the entire source for labels such as "PAN", "Permanent Account Number", or "Income Tax PAN". Extract the exact 10-character PAN when present, allowing OCR-inserted spaces or line breaks between characters, then normalize it to five uppercase letters, four digits, and one uppercase letter. Do not use a GSTIN, IE code, invoice number, or another tax identifier as PAN. Mark a source-present PAN as "extracted"; mark it "missing" if no reliable PAN is present.
- For exporter category, classify a standard software consultant, freelancer, independent developer, regular GST-registered entity, private company, home office, coworking space, or ordinary commercial office as "Custom (DTA units)" unless the source explicitly proves another category. Select "SEZ" only when an SEZ registration or SEZ unit is stated; select "100% EOU" only when formal EOU approval or registration is stated; select "Warehouse export" only for physical goods stored in a customs-bonded warehouse. Do not classify an individual as "Other" merely because they are an individual. Use "others" with "exporterCategoryOtherSpecify" only when the source explicitly identifies a different category that is not one of the listed categories.
- For a software, IT, or online consultancy service, select "Internet" for "modeOfTransport" when the source indicates remote, online, electronic, or digital delivery. If the service is clearly software/IT consultancy and the document does not mention physical shipment or onsite delivery, infer "Internet" as "ai_suggested" with a short rationale asking the user to confirm. Do not select it when onsite or physical delivery is stated. When the source says the contract or payment is monthly, recurring monthly, or a monthly retainer, include "periodical" in "natureOfPayment".
- For "modeOfRealisation", do not choose L/C or BG merely because the exporter provides software or consultancy. If the source explicitly states L/C, choose L/C; if it explicitly states a bank guarantee, choose BG. For ordinary software-service fees, monthly retainers, advance payments, bank transfers, remittances, or other direct payment arrangements where neither L/C nor BG is stated, suggest "Others" with a short rationale and ask the user to confirm.
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

