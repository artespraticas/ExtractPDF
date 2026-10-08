// ExtractPDF — pay-per-use PDF/DOCX extraction for AI agents
// Payment: $0.005 USDC via x402, Circle Gateway settlement
// Chains: Base (eip155:8453), Arc (eip155:5042), Polygon (eip155:137)

import { recoverTypedDataAddress } from "viem";

const WALLET = process.env.WALLET_ADDRESS;
const AMOUNT = "5000"; // $0.005 USDC (6 decimals)

// Chain registry — USDC addresses and Gateway verifying contracts per chain
const CHAINS = {
  "eip155:8453": {
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
    chainId: 8453,
  },
  "eip155:5042": {
    asset: "0x3600000000000000000000000000000000000000",
    name: "USD Coin",
    version: "2",
    chainId: 5042,
  },
  "eip155:137": {
    asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    name: "USD Coin",
    version: "2",
    chainId: 137,
  },
};

const accepts = Object.entries(CHAINS).map(([network, c]) => ({
  scheme: "exact",
  network,
  amount: AMOUNT,
  maxAmountRequired: AMOUNT,
  asset: c.asset,
  payTo: WALLET,
  maxTimeoutSeconds: 300,
  extra: { name: c.name, version: c.version },
}));

// Verify EIP-3009 TransferWithAuthorization signature
async function verifyPayment(paymentHeader) {
  let p;
  try {
    p = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  } catch {
    return { valid: false, reason: "Invalid base64 payment header" };
  }

  const chain = CHAINS[p.network];
  if (!chain) return { valid: false, reason: `Unsupported network: ${p.network}` };

  const auth = p.payload?.authorization;
  if (!auth) return { valid: false, reason: "Missing authorization" };

  // Verify amount
  if (BigInt(auth.value ?? 0) < BigInt(AMOUNT)) {
    return { valid: false, reason: `Amount too low: ${auth.value} < ${AMOUNT}` };
  }

  // Verify payTo
  if ((auth.to ?? "").toLowerCase() !== (WALLET ?? "").toLowerCase()) {
    return { valid: false, reason: "Wrong payTo address" };
  }

  // Verify timing
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(auth.validAfter ?? 0)) {
    return { valid: false, reason: "Authorization not yet valid" };
  }
  if (now > Number(auth.validBefore ?? 0)) {
    return { valid: false, reason: "Authorization expired" };
  }

  // Recover signer from EIP-712 signature
  try {
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: chain.name,
        version: chain.version,
        chainId: chain.chainId,
        verifyingContract: chain.asset,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: p.payload.signature,
    });

    if (recovered.toLowerCase() !== (auth.from ?? "").toLowerCase()) {
      return { valid: false, reason: "Signature does not match from address" };
    }
  } catch (e) {
    return { valid: false, reason: `Signature recovery failed: ${e.message}` };
  }

  return { valid: true, network: p.network, from: auth.from };
}

// PDF extraction
async function extractPdf(buffer) {
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const data = await pdfParse(buffer);
  return {
    text: data.text.trim().slice(0, 50000),
    pages: data.numpages,
    chars: data.text.length,
    title: data.info?.Title || "",
    author: data.info?.Author || "",
    format: "pdf",
  };
}

// DOCX extraction
async function extractDocx(buffer) {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim().slice(0, 50000);
  return { text, pages: null, chars: text.length, title: "", author: "", format: "docx" };
}

// Plain text fallback
function extractText(buffer) {
  const text = buffer.toString("utf-8").trim().slice(0, 50000);
  return { text, pages: null, chars: text.length, title: "", author: "", format: "text" };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, Accept");
  if (req.method === "OPTIONS") return res.status(204).end();

  const host = req.headers.host || "www.extractpdf.xyz";
  const resourceUrl = `https://${host}/api/extract`;

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      service: "ExtractPDF",
      description: "Pay-per-use PDF and document extraction for AI agents",
      price: "$0.005 USDC per extraction",
      endpoint: "POST /api/extract",
      accepts_formats: ["pdf", "docx", "txt"],
      chains: ["Base (eip155:8453)", "Arc (eip155:5042)", "Polygon (eip155:137)"],
      docs: "https://www.extractpdf.xyz",
    });
  }

  // Payment gate
  const paymentHeader = req.headers["x-payment"];
  if (!paymentHeader) {
    res.setHeader("WWW-Authenticate", `MPP realm="${resourceUrl}", price="0.005", currency="USD"`);
    return res.status(402).json({
      x402Version: 1,
      error: "Payment required",
      resource: {
        url: resourceUrl,
        description: "PDF and document text extraction — $0.005 per request",
        mimeType: "application/json",
      },
      accepts,
    });
  }

  // Verify payment signature
  const verification = await verifyPayment(paymentHeader);
  if (!verification.valid) {
    return res.status(402).json({
      x402Version: 1,
      error: `Payment verification failed: ${verification.reason}`,
      resource: { url: resourceUrl, description: "PDF and document text extraction" },
      accepts,
    });
  }

  // Extract document
  const body = req.method === "POST" ? req.body : null;
  const url = (body && body.url) || req.query.url;
  if (!url) return res.status(400).json({ error: "Missing required field: url" });

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "ExtractPDF/1.0 (+https://www.extractpdf.xyz)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return res.status(422).json({ error: "Failed to fetch document", detail: `HTTP ${response.status}` });
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());

    let extracted;
    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      extracted = await extractPdf(buffer);
    } else if (contentType.includes("wordprocessingml") || url.toLowerCase().endsWith(".docx")) {
      extracted = await extractDocx(buffer);
    } else {
      extracted = extractText(buffer);
    }

    console.log(`[ExtractPDF] paid extraction from ${verification.from} on ${verification.network} — ${url}`);
    return res.status(200).json({ url, ...extracted, extracted_at: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
}
