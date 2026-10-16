// arc-studio-allow-onchain-literal
import express from 'express';
import cors from 'cors';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { Buffer } from 'node:buffer';
import { createPublicClient, createWalletClient, http, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
if (!WALLET_ADDRESS) throw new Error('WALLET_ADDRESS env var required');

// Circle Gateway middleware — handles 402 negotiation, verification, and settlement
const gateway = createGatewayMiddleware({
  sellerAddress: WALLET_ADDRESS,
  facilitatorUrl: 'https://gateway-api.circle.com',
});

// Base chain config for browser EIP-3009 path
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // arc-studio-allow-onchain-literal
const BASE_RPC  = 'https://mainnet.base.org'; // arc-studio-allow-onchain-literal
const BASE_CHAIN = {
  id: 8453, name: 'Base',
  rpcUrls: { default: { http: [BASE_RPC] } },
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};
const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
};
const USDC_ABI = [{
  name: 'transferWithAuthorization', type: 'function', stateMutability: 'nonpayable',
  inputs: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
  ],
  outputs: [],
}];

// ---------------------------------------------------------------------------
// Document extraction helpers
// ---------------------------------------------------------------------------
async function fetchDocument(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'ExtractPDF/1.0' },
  });
  if (!res.ok && res.status !== 300) throw new Error(`Fetch failed: ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
}

function isPdf(url, ct)  { return ct.includes('pdf')  || url.toLowerCase().endsWith('.pdf'); }
function isDocx(url, ct) { return ct.includes('wordprocessingml') || ct.includes('msword') || url.toLowerCase().match(/\.docx?$/); }
function stripHtml(html) { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

async function extractDoc(url) {
  const { buf, contentType } = await fetchDocument(url);
  if (isPdf(url, contentType)) {
    const data = await pdfParse(buf);
    return { url, format: 'pdf', text: data.text.slice(0, 50000), chars: data.text.length, pages: data.numpages, info: { title: data.info?.Title || null, author: data.info?.Author || null, subject: data.info?.Subject || null }, extracted_at: new Date().toISOString() };
  }
  if (isDocx(url, contentType)) {
    const result = await mammoth.extractRawText({ buffer: buf });
    const text = result.value.slice(0, 50000);
    return { url, format: 'docx', text, chars: text.length, extracted_at: new Date().toISOString() };
  }
  const raw = buf.toString('utf8').slice(0, 50000);
  const text = contentType.includes('html') ? stripHtml(raw) : raw;
  return { url, format: 'text', text, chars: text.length, extracted_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Body parsing helper
// ---------------------------------------------------------------------------
function parseBody(rawBody) {
  if (Buffer.isBuffer(rawBody))         { try { return JSON.parse(rawBody.toString()); } catch { return {}; } }
  if (typeof rawBody === 'string')      { try { return JSON.parse(rawBody); }            catch { return {}; } }
  if (rawBody && typeof rawBody === 'object') return rawBody;
  return {};
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
const CORS_OPTS = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-PAYMENT', 'PAYMENT-SIGNATURE', 'PAYMENT-REQUIRED', 'Accept'],
  exposedHeaders: ['PAYMENT-REQUIRED', 'WWW-Authenticate'],
};

app.use(cors(CORS_OPTS));
app.options('*', cors(CORS_OPTS));

// Capture raw body BEFORE gateway middleware
app.use((req, _res, next) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    req.rawBody = raw;
    try { req.body = JSON.parse(raw); } catch { req.body = {}; }
    next();
  });
  req.on('error', next);
});

// ---------------------------------------------------------------------------
// Dual-rail 402 on GET — Circle score probe + MPP discovery
// ---------------------------------------------------------------------------
const PAYMENT_SCHEMA = {
  type: 'object', required: ['url'],
  properties: { url: { type: 'string', description: 'Publicly accessible URL of a PDF or DOCX file' } },
};
const MPP_HEADER = [
  `MPP realm="https://www.extractpdf.xyz"`,
  `payment-type="x402"`, `asset="USDC"`, `network="base"`,
  `pay-to="${WALLET_ADDRESS}"`, `amount="10000"`,
].join(', ');

app.get('/api/extract', (_req, res) => {
  res.status(402).set('WWW-Authenticate', MPP_HEADER).json({
    error: 'Payment required', price: '$0.01 USDC',
    endpoint: 'POST /api/extract',
    schema: PAYMENT_SCHEMA,
    docs: 'https://www.extractpdf.xyz',
    protocols: ['x402', 'mpp'],
    networks: ['eip155:8453', 'eip155:5042', 'eip155:137'],
  });
});

// ---------------------------------------------------------------------------
// Agent endpoint — Circle Gateway (GatewayWalletBatched, gasless, multi-chain)
// ---------------------------------------------------------------------------
app.post('/api/extract', gateway.require('$0.01'), async (req, res) => {
  const body = parseBody(req.body);
  const { url } = body;
  if (!url || typeof url !== 'string')
    return res.status(400).json({ error: 'Missing required field: url (string, public PDF or DOCX URL)' });
  try {
    return res.json(await extractDoc(url));
  } catch (err) {
    console.error('Extraction error:', err?.message);
    const msg = err?.message || '';
    if (msg.includes('Invalid PDF')) return res.status(500).json({ error: 'Extraction failed', detail: 'Invalid PDF structure' });
    return res.status(500).json({ error: 'Extraction failed', detail: msg });
  }
});

// ---------------------------------------------------------------------------
// Browser endpoint — EIP-3009 direct signature from connected wallet
// ---------------------------------------------------------------------------
app.get('/api/extract-web', (_req, res) => {
  res.status(402).set('WWW-Authenticate', MPP_HEADER).json({
    error: 'Payment required', price: '$0.01 USDC',
    docs: 'https://www.extractpdf.xyz',
  });
});

app.post('/api/extract-web', async (req, res) => {
  const body = parseBody(req.body);
  const { url } = body;

  if (!url || typeof url !== 'string')
    return res.status(400).json({ error: 'Missing required field: url' });

  // Read payment from PAYMENT-SIGNATURE or X-PAYMENT header (x402 v2 base64 payload)
  const paymentHeader = req.headers['payment-signature'] || req.headers['x-payment'];
  if (!paymentHeader)
    return res.status(402).json({ error: 'Payment required', price: '$0.01 USDC', network: 'eip155:8453' });

  let paymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid payment header encoding' });
  }

  const { authorization, signature } = paymentPayload?.payload || {};
  if (!authorization || !signature)
    return res.status(400).json({ error: 'Invalid payment: missing authorization or signature' });

  try {
    // Verify EIP-3009 signature
    const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC };
    const recovered = await recoverTypedDataAddress({
      domain, types: TRANSFER_WITH_AUTH_TYPES, primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from, to: authorization.to,
        value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce,
      },
      signature,
    });

    if (recovered.toLowerCase() !== authorization.from.toLowerCase())
      return res.status(402).json({ error: 'Payment verification failed: signer mismatch' });
    if (BigInt(authorization.value) < 10000n)
      return res.status(402).json({ error: 'Payment too small: minimum 10000 units ($0.01)' });
    if (authorization.to.toLowerCase() !== WALLET_ADDRESS.toLowerCase())
      return res.status(402).json({ error: 'Payment recipient mismatch' });

    // Settle on-chain fire-and-forget
    const settlerKey = process.env.SETTLER_PRIVATE_KEY;
    if (settlerKey) {
      const account = privateKeyToAccount(settlerKey);
      const walletClient = createWalletClient({ account, chain: BASE_CHAIN, transport: http() });
      const publicClient = createPublicClient({ chain: BASE_CHAIN, transport: http() });
      const r = signature.slice(0, 66);
      const s = ('0x' + signature.slice(66, 130));
      const v = parseInt(signature.slice(130, 132), 16);
      // Extract first, then settle (both blocking before response)
      const extracted = await extractDoc(url);

      try {
        const { request } = await publicClient.simulateContract({
          address: BASE_USDC, abi: USDC_ABI, functionName: 'transferWithAuthorization',
          args: [authorization.from, authorization.to, BigInt(authorization.value),
                 BigInt(authorization.validAfter), BigInt(authorization.validBefore),
                 authorization.nonce, v, r, s],
          account,
        });
        const tx = await walletClient.writeContract(request);
        console.log('Web settlement tx:', tx);
      } catch (settleErr) {
        console.error('Web settlement error:', settleErr?.shortMessage || settleErr?.message);
      }
    }

    return res.json(extracted);

  } catch (err) {
    console.error('extract-web error:', err?.message);
    return res.status(500).json({ error: 'Extraction failed', detail: err?.message });
  }
});

export default app;
