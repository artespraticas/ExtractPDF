import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import express from "express";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";

const WALLET = process.env.WALLET_ADDRESS;
if (!WALLET) throw new Error("WALLET_ADDRESS env var is required");

// Lazy-init the x402 server (Vercel serverless: init once per cold start)
let x402Server = null;
let middleware = null;

async function getMiddleware() {
  if (middleware) return middleware;
  x402Server = await createX402Server({
    routes: {
      "POST /api/extract": {
        price: "$0.005",
        description: "PDF and document text extraction — $0.005 per request",
        mimeType: "application/json",
      },
    },
    payToConfig: {
      type: "address",
      evm: WALLET,
    },
    // CDP credentials read from env: CDP_API_KEY_ID, CDP_API_KEY_SECRET
  });
  middleware = paymentMiddlewareFromHTTPServer(x402Server);
  return middleware;
}

// --- Extraction helpers ---
async function fetchBuffer(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "ExtractPDF/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
  const buf = await r.arrayBuffer();
  return { buffer: Buffer.from(buf), contentType: r.headers.get("content-type") || "" };
}

async function extractContent(url, base64Content, format) {
  let buffer, contentType = "";

  if (base64Content) {
    buffer = Buffer.from(base64Content, "base64");
  } else {
    const result = await fetchBuffer(url);
    buffer = result.buffer;
    contentType = result.contentType;
  }

  const fmt = format || (contentType.includes("pdf") ? "pdf"
    : contentType.includes("word") || contentType.includes("docx") ? "docx"
    : url?.toLowerCase().endsWith(".docx") ? "docx"
    : "pdf");

  if (fmt === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    return { format: "docx", text, length: text.length };
  }

  const data = await pdfParse(buffer);
  return {
    format: "pdf",
    text: data.text.trim().slice(0, 50000),
    length: data.text.trim().length,
    pages: data.numpages,
    info: {
      title: data.info?.Title || null,
      author: data.info?.Author || null,
      subject: data.info?.Subject || null,
    },
  };
}

// --- Express app ---
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, Accept");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Payment middleware (async init)
app.use(async (req, res, next) => {
  try {
    const mw = await getMiddleware();
    mw(req, res, next);
  } catch (e) {
    console.error("x402 middleware init error:", e.message);
    next(e);
  }
});

// Health check (free)
app.get("/api/extract", (req, res) => {
  res.json({
    service: "ExtractPDF",
    description: "PDF and document text extraction for AI agents",
    price: "$0.005 USDC per request",
    usage: 'POST /api/extract with {"url":"https://..."} or {"base64":"...","format":"pdf|docx"}',
  });
});

// Paid extraction endpoint
app.post("*", async (req, res) => {
  const { url, base64, format } = req.body || {};
  if (!url && !base64) {
    return res.status(400).json({ error: "Missing required field: url or base64" });
  }
  try {
    const result = await extractContent(url, base64, format);
    return res.json({
      url: url || null,
      ...result,
      scraped_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Extraction error:", err.message);
    return res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
});

export default app;
