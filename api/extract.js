import express from "express";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, Accept");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ── x402 payment middleware (CDP facilitator — verifies AND settles on-chain) ─

const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
if (!WALLET_ADDRESS) throw new Error("WALLET_ADDRESS env var required");

// createX402Server is async — we initialise once and reuse across warm invocations
let x402Middleware;
async function getMiddleware() {
  if (x402Middleware) return x402Middleware;
  const server = await createX402Server({
    cdpApiKeyId:     process.env.CDP_API_KEY_ID,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
    environment: "production", // Base mainnet
    payToConfig: {
      type: "address",
      evm: WALLET_ADDRESS,
    },
    routes: {
      "POST /api/extract": {
        price: "$0.005",
        networks: ["eip155:8453"], // Base mainnet
        description: "PDF and DOCX text extraction — $0.005 per request",
        mimeType: "application/json",
      },
    },
  });
  x402Middleware = paymentMiddlewareFromHTTPServer(server);
  return x402Middleware;
}

// Lazy-init middleware — runs once on first request, reused on warm Lambda
app.use(async (req, res, next) => {
  // Always let OPTIONS and GET through to our own handlers
  if (req.method === "OPTIONS" || req.method === "GET") return next();
  try {
    const mw = await getMiddleware();
    mw(req, res, next);
  } catch (err) {
    console.error("x402 middleware init error:", err.message);
    return res.status(500).json({ error: "Payment middleware unavailable", detail: err.message });
  }
});

// ── PDF / DOCX extraction ─────────────────────────────────────────────────────

async function fetchBuffer(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "ExtractPDF/1.0 (+https://www.extractpdf.xyz)" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  // Accept any 2xx or 300 (w3.org Multiple Choices returns the PDF body)
  if (!r.ok && r.status !== 300) throw new Error(`Fetch failed: ${r.status}`);
  const buf = await r.arrayBuffer();
  return { buffer: Buffer.from(buf), contentType: r.headers.get("content-type") ?? "" };
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

  const fmt = format
    ?? (contentType.includes("pdf") ? "pdf"
      : contentType.includes("word") || contentType.includes("docx") ? "docx"
      : url?.toLowerCase().endsWith(".docx") ? "docx"
      : "pdf");

  if (fmt === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    return { format: "docx", text, length: text.length };
  }

  const data = await pdfParse(buffer);
  const text = data.text.trim();
  return {
    format: "pdf",
    text: text.slice(0, 50000),
    length: text.length,
    pages: data.numpages,
    info: {
      title:   data.info?.Title   ?? null,
      author:  data.info?.Author  ?? null,
      subject: data.info?.Subject ?? null,
    },
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET: return 402 so AgentCash probe discovers payment requirement
app.get("*", async (req, res) => {
  try {
    const mw = await getMiddleware();
    // Trick: run middleware on a fake POST to get the 402 response shape, then return it
    // Simpler: just return a static 402 with WWW-Authenticate for score/probe purposes
    const RESOURCE_URL = "https://www.extractpdf.xyz/api/extract";
    res.setHeader("WWW-Authenticate", `MPP realm="${RESOURCE_URL}", price="0.005", currency="USD"`);
    return res.status(402).json({
      x402Version: 2,
      error: "Payment required",
      resource: { url: RESOURCE_URL, description: "PDF and DOCX text extraction" },
      accepts: [{
        scheme: "exact",
        network: "eip155:8453",
        amount: "5000",
        maxAmountRequired: "5000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // arc-studio-allow-onchain-literal
        payTo: WALLET_ADDRESS,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      }],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST: x402 middleware handles payment gate; if it passes, extract content
app.post("*", async (req, res) => {
  const { url, base64, format } = req.body ?? {};
  if (!url && !base64) {
    return res.status(400).json({ error: "Missing required field: url or base64" });
  }
  try {
    const result = await extractContent(url, base64, format);
    return res.json({ url: url ?? null, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    console.error("Extraction error:", err.message);
    return res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
});

export default app;
