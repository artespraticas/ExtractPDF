import express from "express";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import { createPrivateKey, sign } from "crypto";

const WALLET = process.env.WALLET_ADDRESS;
const CDP_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

if (!WALLET) throw new Error("WALLET_ADDRESS env var required");

// CDP Facilitator endpoints
const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/x402/v1";

// Payment requirements for all 3 mainnet chains
const CHAINS = [
  { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
  { network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", name: "USD Coin", version: "2" },
  { network: "eip155:137", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", name: "USD Coin", version: "2" },
];

const AMOUNT = "5000"; // $0.005 USDC in 6-decimal units
const RESOURCE_URL = "https://www.extractpdf.xyz/api/extract";

const accepts = CHAINS.map(c => ({
  scheme: "exact",
  network: c.network,
  amount: AMOUNT,
  maxAmountRequired: AMOUNT,
  asset: c.asset,
  payTo: WALLET,
  maxTimeoutSeconds: 300,
  extra: { name: c.name, version: c.version, assetTransferMethod: "eip3009" },
}));

// Build CDP API JWT — Ed25519 (the only algorithm CDP issues)
function buildCdpJwt(method, path) {
  if (!CDP_KEY_ID || !CDP_KEY_SECRET) return null;
  const now = Math.floor(Date.now() / 1000);
  const nonce = Math.random().toString(36).slice(2, 10);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: CDP_KEY_ID, nonce })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "cdp",
    sub: CDP_KEY_ID,
    nbf: now,
    exp: now + 120,
    iat: now,
    uri: `${method} api.cdp.coinbase.com${path}`,
  })).toString("base64url");
  const msg = Buffer.from(`${header}.${payload}`);
  // CDP_API_KEY_SECRET may have literal \n (Vercel env) or real newlines — normalize both
  const pem = CDP_KEY_SECRET
    .replace(/\\n/g, "\n")   // literal backslash-n → real newline
    .replace(/\r\n/g, "\n"); // CRLF → LF
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  const sigBuf = sign(null, msg, privateKey); // null = use key's own algorithm (Ed25519)
  return `${header}.${payload}.${sigBuf.toString("base64url")}`;
}

// Call CDP facilitator to verify payment
async function verifyWithCdp(paymentHeader) {
  const jwt = buildCdpJwt("POST", "/platform/x402/v1/verify");
  const headers = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  let paymentPayload;
  try {
    const decoded = Buffer.from(paymentHeader, "base64").toString("utf8");
    paymentPayload = JSON.parse(decoded);
  } catch {
    return { valid: false, reason: "Invalid base64 payment header" };
  }

  const res = await fetch(`${CDP_FACILITATOR}/verify`, {
    method: "POST",
    headers,
    body: JSON.stringify({ paymentPayload, paymentRequirements: accepts }),
    signal: AbortSignal.timeout(8000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.isValid === false) {
    return { valid: false, reason: data.invalidReason || data.error || "Verification failed" };
  }
  return { valid: true, paymentPayload };
}

// Call CDP facilitator to settle payment (non-blocking — best effort)
async function settleWithCdp(paymentPayload) {
  const jwt = buildCdpJwt("POST", "/platform/x402/v1/settle");
  const headers = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  fetch(`${CDP_FACILITATOR}/settle`, {
    method: "POST",
    headers,
    body: JSON.stringify({ paymentPayload, paymentRequirements: accepts }),
    signal: AbortSignal.timeout(10000),
  }).catch(e => console.error("Settle error:", e.message));
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

// Health check (free)
app.get("*", (req, res) => {
  res.json({
    service: "ExtractPDF",
    description: "PDF and document text extraction for AI agents",
    price: "$0.005 USDC per request",
    usage: 'POST /api/extract with {"url":"https://..."} or {"base64":"...","format":"pdf|docx"}',
  });
});

// Paid extraction endpoint
app.post("*", async (req, res) => {
  const paymentHeader = req.headers["x-payment"] || req.headers["payment-signature"];

  // No payment — return 402
  if (!paymentHeader) {
    const paymentRequired = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepts,
      error: "Payment required",
      resource: { url: RESOURCE_URL, description: "PDF and document text extraction — $0.005 per request", mimeType: "application/json" },
    })).toString("base64");
    res.setHeader("Payment-Required", paymentRequired);
    res.setHeader("WWW-Authenticate", `MPP realm="${RESOURCE_URL}", price="0.005", currency="USD"`);
    return res.status(402).json({
      x402Version: 2,
      error: "Payment required",
      resource: { url: RESOURCE_URL, description: "PDF and document text extraction — $0.005 per request", mimeType: "application/json" },
      accepts,
    });
  }

  // Verify payment via CDP facilitator
  const verification = await verifyWithCdp(paymentHeader).catch(e => ({ valid: false, reason: e.message }));
  if (!verification.valid) {
    return res.status(402).json({
      x402Version: 2,
      error: `Payment verification failed: ${verification.reason}`,
      resource: { url: RESOURCE_URL, description: "PDF and document text extraction" },
      accepts,
    });
  }

  // Extract content
  const { url, base64, format } = req.body || {};
  if (!url && !base64) {
    return res.status(400).json({ error: "Missing required field: url or base64" });
  }

  try {
    const result = await extractContent(url, base64, format);
    // Settle payment non-blocking
    settleWithCdp(verification.paymentPayload);
    return res.json({ url: url || null, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    console.error("Extraction error:", err.message);
    return res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
});

export default app;
