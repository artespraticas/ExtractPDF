import express from "express";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import {
  recoverTypedDataAddress,
  getAddress,
  createWalletClient,
  createPublicClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── Chain config ─────────────────────────────────────────────────────────────

const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org"; // arc-studio-allow-onchain-literal
const baseChain = {
  id: 8453,
  name: "Base",
  network: "base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [BASE_RPC] } },
};

const CHAINS = {
  "eip155:8453": { chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" }, // arc-studio-allow-onchain-literal
  "eip155:5042": { chainId: 5042, usdc: "0x3600000000000000000000000000000000000000", name: "USD Coin", version: "2" }, // arc-studio-allow-onchain-literal
  "eip155:137":  { chainId: 137,  usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", name: "USD Coin", version: "2" }, // arc-studio-allow-onchain-literal
};

const AMOUNT       = "5000"; // $0.005 USDC (6 decimals)
const RESOURCE_URL = "https://www.extractpdf.xyz/api/extract";
const WALLET       = (process.env.WALLET_ADDRESS ?? "").toLowerCase();

// ── 402 response objects ─────────────────────────────────────────────────────

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

// AgentCash reads Payment-Required header — Base only in header, all chains in body
const headerAccepts = accepts.filter(a => a.network === "eip155:8453");
const paymentRequiredHeader = Buffer.from(JSON.stringify({
  x402Version: 2,
  resource: { url: RESOURCE_URL, method: "POST", description: "PDF and document text extraction", mimeType: "application/json" },
  accepts: headerAccepts,
})).toString("base64");

const paymentRequiredBody = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: RESOURCE_URL, description: "PDF and document text extraction — $0.005 per request", mimeType: "application/json" },
  accepts,
};

function send402(res) {
  res.setHeader("Payment-Required", paymentRequiredHeader);
  res.setHeader("WWW-Authenticate", `MPP realm="${RESOURCE_URL}", price="0.005", currency="USD"`);
  return res.status(402).json(paymentRequiredBody);
}

// ── Payment verification (EIP-3009 self-verify with viem) ────────────────────

async function verifyPayment(header) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "Invalid payment header encoding" };
  }

  // AgentCash sends: { x402Version, scheme, network, payload: {authorization, signature}, accepted, resource }
  const scheme  = payload.scheme  ?? payload.accepted?.scheme;
  const network = payload.network ?? payload.accepted?.network;
  const inner   = payload.payload ?? {};
  const auth    = inner.authorization ?? payload.authorization;
  const sig     = inner.signature     ?? payload.signature;

  const chain = CHAINS[network];
  if (!chain)  return { ok: false, error: `Unsupported network: ${network}` };
  if (scheme !== "exact") return { ok: false, error: `Unsupported scheme: ${scheme}` };
  if (!sig || !auth) return { ok: false, error: "Missing signature or authorization" };

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
    if (WALLET && auth.to.toLowerCase() !== WALLET) return { ok: false, error: "Wrong payment recipient" };

    const recovered = await recoverTypedDataAddress({
      domain, types, primaryType: "TransferWithAuthorization", message, signature: sig,
    });
    if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
      return { ok: false, error: "Signature mismatch" };
    }

    return { ok: true, network, auth, sig };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── On-chain settlement (receiveWithAuthorization on Base USDC) ──────────────

const USDC_BASE_ABI = [{
  name: "receiveWithAuthorization",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
    { name: "v",           type: "uint8"   },
    { name: "r",           type: "bytes32" },
    { name: "s",           type: "bytes32" },
  ],
  outputs: [],
}];

async function settlePayment(auth, sig) {
  const pk = process.env.SETTLER_PRIVATE_KEY;
  if (!pk) {
    console.warn("SETTLER_PRIVATE_KEY not set — skipping settlement");
    return { skipped: true };
  }

  const account = privateKeyToAccount(pk);
  const transport = http(BASE_RPC);
  const walletClient = createWalletClient({ account, chain: baseChain, transport });
  const publicClient = createPublicClient({ chain: baseChain, transport });

  // Split compact 65-byte hex signature into v/r/s
  const hexSig = sig.startsWith("0x") ? sig : `0x${sig}`;
  const r = `0x${hexSig.slice(2, 66)}`;
  const s = `0x${hexSig.slice(66, 130)}`;
  const v = parseInt(hexSig.slice(130, 132), 16);

  const usdcAddress = getAddress(CHAINS["eip155:8453"].usdc);

  const { request } = await publicClient.simulateContract({
    address: usdcAddress,
    abi: USDC_BASE_ABI,
    functionName: "receiveWithAuthorization",
    args: [
      getAddress(auth.from),
      getAddress(auth.to),
      BigInt(auth.value),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce,
      v, r, s,
    ],
    account,
  });

  const txHash = await walletClient.writeContract(request);
  console.log("Settlement tx:", txHash);
  return { tx: txHash, network: "base" };
}

// ── PDF / DOCX extraction ────────────────────────────────────────────────────

async function fetchBuffer(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "ExtractPDF/1.0 (+https://www.extractpdf.xyz)" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
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

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, Accept");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// GET: agents probe with GET first — always return 402 so they discover payment requirement
app.get("*", (_req, res) => send402(res));

// POST: paid extraction
app.post("*", async (req, res) => {
  const paymentHeader = req.headers["payment-signature"] ?? req.headers["x-payment"];
  if (!paymentHeader) return send402(res);

  // 1. Verify signature
  const verification = await verifyPayment(paymentHeader);
  if (!verification.ok) {
    console.error("Verification failed:", verification.error);
    return res.status(402).json({
      x402Version: 2,
      error: `Payment verification failed: ${verification.error}`,
      resource: { url: RESOURCE_URL, description: "PDF and document text extraction" },
      accepts,
    });
  }

  // 2. Settle on-chain (Base only — fire-and-forget so extraction isn't delayed)
  let settlement = { skipped: true };
  if (verification.network === "eip155:8453") {
    settlePayment(verification.auth, verification.sig)
      .then(r => { settlement = r; console.log("Settled:", JSON.stringify(r)); })
      .catch(e => console.error("Settlement error:", e.message));
  }

  // 3. Extract content
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
