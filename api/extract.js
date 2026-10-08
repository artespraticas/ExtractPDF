import { facilitator } from "@coinbase/x402";

const WALLET = process.env.WALLET_ADDRESS;

// $0.005 USDC = 5000 raw units (6 decimals)
const AMOUNT = "5000";

const inputSchema = {
  type: "object",
  required: ["url"],
  properties: {
    url: {
      type: "string",
      format: "uri",
      description: "Public URL of a PDF or DOCX document to extract text from"
    },
    pages: {
      type: "string",
      description: "Optional page range e.g. '1-5' or 'all' (default: all)"
    }
  }
};

const outputSchema = {
  type: "object",
  required: ["url", "text", "pages", "chars", "extracted_at"],
  properties: {
    url: { type: "string" },
    text: { type: "string", description: "Extracted plain text" },
    pages: { type: "number", description: "Total pages (PDF only)" },
    chars: { type: "number" },
    title: { type: "string" },
    author: { type: "string" },
    format: { type: "string", enum: ["pdf", "docx", "text"] },
    extracted_at: { type: "string", format: "date-time" }
  }
};

const accepts = [
  {
    scheme: "exact",
    network: "eip155:8453",
    amount: AMOUNT,
    maxAmountRequired: AMOUNT,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: WALLET,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    outputSchema: { input: inputSchema, output: outputSchema }
  },
  {
    scheme: "exact",
    network: "eip155:5042",
    amount: AMOUNT,
    maxAmountRequired: AMOUNT,
    asset: "0x3600000000000000000000000000000000000000",
    payTo: WALLET,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    outputSchema: { input: inputSchema, output: outputSchema }
  },
  {
    scheme: "exact",
    network: "eip155:137",
    amount: AMOUNT,
    maxAmountRequired: AMOUNT,
    asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    payTo: WALLET,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    outputSchema: { input: inputSchema, output: outputSchema }
  }
];

async function extractPdf(buffer) {
  // dynamic import to avoid ESM issues with pdf-parse
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const data = await pdfParse(buffer);
  return {
    text: data.text.trim().slice(0, 50000),
    pages: data.numpages,
    chars: data.text.length,
    title: data.info?.Title || "",
    author: data.info?.Author || "",
    format: "pdf"
  };
}

async function extractDocx(buffer) {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim().slice(0, 50000);
  return {
    text,
    pages: null,
    chars: text.length,
    title: "",
    author: "",
    format: "docx"
  };
}

async function extractText(buffer) {
  const text = buffer.toString("utf-8").trim().slice(0, 50000);
  return {
    text,
    pages: null,
    chars: text.length,
    title: "",
    author: "",
    format: "text"
  };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, Accept");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Health check
  if (req.method === "GET" && !req.headers["x-payment"]) {
    return res.status(200).json({
      service: "ExtractPDF",
      description: "Pay-per-use PDF and document extraction for AI agents",
      price: "$0.005 USDC per extraction",
      endpoint: "POST /api/extract",
      accepts_formats: ["pdf", "docx", "txt"],
      chains: ["Base (eip155:8453)", "Arc (eip155:5042)", "Polygon (eip155:137)"],
      docs: "https://extractpdf.xyz"
    });
  }

  const host = req.headers.host || "extractpdf.xyz";
  const resourceUrl = `https://${host}/api/extract`;

  // Payment gate
  const paymentHeader = req.headers["x-payment"];
  if (!paymentHeader) {
    res.setHeader(
      "WWW-Authenticate",
      `MPP realm="${resourceUrl}", price="0.005", currency="USD"`
    );
    return res.status(402).json({
      x402Version: 1,
      error: "Payment required",
      resource: {
        url: resourceUrl,
        description: "PDF and document text extraction — $0.005 per request",
        mimeType: "application/json"
      },
      accepts
    });
  }

  // Verify payment
  try {
    const payment = JSON.parse(paymentHeader);
    const verifyResult = await facilitator.verify(payment, { accepts });
    if (!verifyResult.valid) {
      return res.status(402).json({
        x402Version: 1,
        error: "Invalid payment: " + verifyResult.invalidReason,
        resource: { url: resourceUrl, description: "PDF and document text extraction" },
        accepts
      });
    }
    await facilitator.settle(payment, { accepts });
  } catch (e) {
    console.error("Payment error:", e.message);
    return res.status(402).json({
      x402Version: 1,
      error: "Payment processing failed: " + e.message,
      resource: { url: resourceUrl, description: "PDF and document text extraction" },
      accepts
    });
  }

  // Extract document
  const body = req.method === "POST" ? req.body : null;
  const url = (body && body.url) || req.query.url;

  if (!url) {
    return res.status(400).json({ error: "Missing required field: url" });
  }

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "ExtractPDF/1.0 (+https://extractpdf.xyz)" },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return res.status(422).json({
        error: "Failed to fetch document",
        detail: `HTTP ${response.status} from ${url}`
      });
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());

    let extracted;
    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      extracted = await extractPdf(buffer);
    } else if (
      contentType.includes("wordprocessingml") ||
      url.toLowerCase().endsWith(".docx")
    ) {
      extracted = await extractDocx(buffer);
    } else {
      // fallback: plain text
      extracted = await extractText(buffer);
    }

    return res.status(200).json({
      url,
      ...extracted,
      extracted_at: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
}
