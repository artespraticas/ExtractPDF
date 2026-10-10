import express from "express";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import { recoverTypedDataAddress, getAddress } from "viem";

const WALLET = (process.env.WALLET_ADDRESS ?? "").toLowerCase();
if (!WALLET) throw new Error("WALLET_ADDRESS env var required");

// Chain registry — identical to Scrape Agent
const CHAINS = {
  "eip155:8453": { chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
  "eip155:5042": { chainId: 5042, usdc: "0x3600000000000000000000000000000000000000", name: "USD Coin", version: "2" },
  "eip155:137":  { chainId: 137,  usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", name: "USD Coin", version: "2" },
};

const AMOUNT = "5000"; // $0.005 — 6-decimal USDC
const RESOURCE_URL = "https://www.extractpdf.xyz/api/extract";

const accepts = Object.entries(CHAINS).map(([network, c]) => ({
  scheme: "exact",
  network,
  amount: AMOUNT,
  maxAmountRequired: AMOUNT,
  asset: c.usdc,
  payTo: process.env.WALLET_ADDRESS ?? "",
  maxTimeoutSeconds: 300,
  extra: { name: c.name, version: c.version, assetTransferMethod: "eip3009" },
}));

// Self-verify EIP-712 TransferWithAuthorization — same pattern as Scrape Agent
async function verifyPayment(header) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "Invalid payment header encoding" };
  }

  // Log full structure (redact signature only)
  const safe = JSON.parse(JSON.stringify(payload));
  if (safe?.payload?.signature) safe.payload.signature = "[redacted]";
  if (safe?.authorization?.signature) safe.authorization.signature = "[redacted]";
  console.log("PAYMENT_DUMP:", JSON.stringify(safe));

  const scheme  = payload.scheme  ?? payload.accepted?.scheme;
  const network = payload.network ?? payload.accepted?.network;
  const p       = payload.payload ?? payload;
  const chain = CHAINS[network];
  if (!chain) return { ok: false, error: `Unsupported network: ${network}` };
  if (scheme !== "exact") return { ok: false, error: `Unsupported scheme: ${scheme}` };

  const { signature, authorization: auth } = p ?? {};
  if (!signature || !auth) return { ok: false, error: "Missing signature or authorization" };

  try {
    const domain = {
      name: chain.name,
      version: chain.version,
      chainId: chain.chainId,
      verifyingContract: getAddress(chain.usdc),
    };
    const types = {
      TransferWithAuthorization: [
        { name: "from",        type: "address" },
        { name: "to",          type: "address" },
        { name: "value",       type: "uint256" },
        { name: "validAfter",  type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce",       type: "bytes32" },
      ],
    };
    const message = {
      from:        getAddress(auth.from),
      to:          getAddress(auth.to),
      value:       BigInt(auth.value),
      validAfter:  BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce:       auth.nonce,
    };

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < message.validAfter)  return { ok: false, error: "Payment not yet valid" };
    if (now > message.validBefore) return { ok: false, error: "Payment expired" };
    if (BigInt(auth.value) < BigInt(AMOUNT)) return { ok: false, error: "Insufficient payment amount" };
    if (auth.to.toLowerCase() !== WALLET) return { ok: false, error: "Wrong payment recipient" };

    const recovered = await recoverTypedDataAddress({
      domain, types, primaryType: "TransferWithAuthorization", message, signature,
    });
    if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
      return { ok: false, error: "Signature mismatch" };
    }

    return { ok: true, from: auth.from, network, amount: auth.value };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// Extraction helpers
async function fetchBuffer(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "ExtractPDF/1.0 (+https://www.extractpdf.xyz)" },
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

  const fmt = format || (
    contentType.includes("pdf") ? "pdf"
    : contentType.includes("word") || contentType.includes("docx") ? "docx"
    : url?.toLowerCase().endsWith(".docx") ? "docx"
    : "pdf"
  );

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

// Pre-built 402 response — shared by GET probe and POST no-payment path
const acceptsForHeader = accepts.filter(a => a.network === "eip155:8453");
const header402 = {
  x402Version: 2,
  resource: { url: RESOURCE_URL, method: "POST", description: "PDF and document text extraction", mimeType: "application/json" },
  accepts: acceptsForHeader,
};
const header402Encoded = Buffer.from(JSON.stringify(header402)).toString("base64");
const paymentRequired = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: RESOURCE_URL, description: "PDF and document text extraction — $0.005 per request", mimeType: "application/json" },
  accepts,
};

// Express app
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, Accept");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// GET always returns 402 so agents discover the payment requirement on probe
app.get("*", (req, res) => {
  res.setHeader("Payment-Required", header402Encoded);
  res.setHeader("WWW-Authenticate", `MPP realm="${RESOURCE_URL}", price="0.005", currency="USD"`);
  return res.status(402).json(paymentRequired);
});

// Paid extraction endpoint
app.post("*", async (req, res) => {
  const paymentHeader = req.headers["x-payment"] ?? req.headers["payment-signature"];

  if (!paymentHeader) {
    res.setHeader("Payment-Required", header402Encoded);
    res.setHeader("WWW-Authenticate", `MPP realm="${RESOURCE_URL}", price="0.005", currency="USD"`);
    return res.status(402).json(paymentRequired);
  }

  const verification = await verifyPayment(paymentHeader);
  if (!verification.ok) {
    return res.status(402).json({
      x402Version: 2,
      error: verification.error,
      resource: { url: RESOURCE_URL, description: "PDF and document text extraction" },
      accepts,
    });
  }

  const { url, base64, format } = req.body || {};
  if (!url && !base64) {
    return res.status(400).json({ error: "Missing required field: url or base64" });
  }

  try {
    const result = await extractContent(url, base64, format);
    return res.json({ url: url || null, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    console.error("Extraction error:", err.message);
    return res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
});

export default app;
