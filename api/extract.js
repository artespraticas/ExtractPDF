import express from 'express';
import cors from 'cors';
import { createPublicClient, createWalletClient, http, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { Buffer } from 'node:buffer';

// Base mainnet RPC — use proxy if available, else public fallback
const BASE_RPC_URL = (() => {
  const proxyBase  = process.env.RPC_PROXY_BASE_URL;
  const proxyToken = process.env.RPC_PROXY_TOKEN;
  const proxyChains = (process.env.RPC_PROXY_CHAINS || '').split(',');
  if (proxyBase && proxyChains.includes('Base')) {
    return `${proxyBase}/api/rpc/Base?_rpc_token=${proxyToken}`; // arc-studio-allow-onchain-literal
  }
  return 'https://mainnet.base.org'; // arc-studio-allow-onchain-literal — public fallback, rate limit unknown
})();

// Chain config (Base mainnet — inline to avoid viem/chains Vercel import issues)
const base = {
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [BASE_RPC_URL] } },
};

// Contract addresses from env (set via Vercel env vars)
const USDC_BASE = process.env.USDC_BASE_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // arc-studio-allow-onchain-literal
const USDC_ARC  = process.env.USDC_ARC_ADDRESS  || '0x3600000000000000000000000000000000000000'; // arc-studio-allow-onchain-literal
const USDC_POLY = process.env.USDC_POLY_ADDRESS  || '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // arc-studio-allow-onchain-literal

const WALLET_ADDRESS     = process.env.WALLET_ADDRESS;
const SETTLER_PRIVATE_KEY = process.env.SETTLER_PRIVATE_KEY;

// ---------------------------------------------------------------------------
// EIP-3009 domain + types
// ---------------------------------------------------------------------------
function eip3009Domain(asset, chainId, name, version) {
  return { name, version, chainId, verifyingContract: asset };
}

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

// ---------------------------------------------------------------------------
// 402 response
// ---------------------------------------------------------------------------
function make402(errorMsg) {
  return {
    x402Version: 2,
    error: errorMsg || 'Payment Required',
    resource: { url: 'https://www.extractpdf.xyz/api/extract', description: 'PDF and document text extraction' },
    accepts: [
      { scheme: 'exact', network: 'eip155:8453', amount: '5000', maxAmountRequired: '5000', asset: USDC_BASE, payTo: WALLET_ADDRESS, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' } },
      { scheme: 'exact', network: 'eip155:5042', amount: '5000', maxAmountRequired: '5000', asset: USDC_ARC,  payTo: WALLET_ADDRESS, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' } },
      { scheme: 'exact', network: 'eip155:137',  amount: '5000', maxAmountRequired: '5000', asset: USDC_POLY, payTo: WALLET_ADDRESS, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' } },
    ],
  };
}

function makePaymentRequiredHeader() {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepts: [make402().accepts[0]] })).toString('base64');
}

// ---------------------------------------------------------------------------
// Verify EIP-3009 signature
// ---------------------------------------------------------------------------
async function verifyPayment(rawHeader) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8')); }
  catch { throw new Error('Invalid base64 payment header'); }

  const network = parsed?.accepted?.network;
  const auth    = parsed?.payload?.authorization;
  const sig     = parsed?.payload?.signature;

  if (!network) throw new Error(`Unsupported network: ${network}`);
  if (!auth || !sig) throw new Error('Missing authorization or signature');

  const chainId = parseInt(network.split(':')[1]);
  if (chainId !== 8453) throw new Error(`Unsupported chain: ${chainId}`);

  const asset = parsed?.accepted?.asset || USDC_BASE;
  const name  = parsed?.accepted?.extra?.name    || 'USD Coin';
  const ver   = parsed?.accepted?.extra?.version || '2';

  const recovered = await recoverTypedDataAddress({
    domain: eip3009Domain(asset, chainId, name, ver),
    types: TRANSFER_WITH_AUTH_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from, to: auth.to,
      value: BigInt(auth.value), validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore), nonce: auth.nonce,
    },
    signature: sig,
  });

  if (recovered.toLowerCase() !== auth.from.toLowerCase())
    throw new Error(`Signature mismatch: recovered ${recovered}, expected ${auth.from}`);

  const now = Math.floor(Date.now() / 1000);
  if (now > Number(auth.validBefore)) throw new Error('Payment authorization expired');
  if (now < Number(auth.validAfter))  throw new Error('Payment authorization not yet valid');

  return { auth, sig, asset, chainId };
}

// ---------------------------------------------------------------------------
// Settle on-chain via receiveWithAuthorization
// ---------------------------------------------------------------------------
const RECEIVE_WITH_AUTH_ABI = [{
  name: 'receiveWithAuthorization', type: 'function', stateMutability: 'nonpayable',
  inputs: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
  ],
  outputs: [],
}];

async function settlePayment(auth, sig, asset) {
  if (!SETTLER_PRIVATE_KEY) { console.error('Settlement skipped: SETTLER_PRIVATE_KEY not set'); return null; }
  try {
    const pk = SETTLER_PRIVATE_KEY.startsWith('0x') ? SETTLER_PRIVATE_KEY : `0x${SETTLER_PRIVATE_KEY}`;
    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC_URL) });
    const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC_URL) });

    const sigHex   = sig.startsWith('0x') ? sig : `0x${sig}`;
    const sigBytes = Buffer.from(sigHex.slice(2), 'hex');
    const r = `0x${sigBytes.slice(0, 32).toString('hex')}`;
    const s = `0x${sigBytes.slice(32, 64).toString('hex')}`;
    const v = sigBytes[64];

    const { request } = await publicClient.simulateContract({
      address: asset, abi: RECEIVE_WITH_AUTH_ABI, functionName: 'receiveWithAuthorization',
      args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, v, r, s],
      account,
    });

    const txHash = await walletClient.writeContract(request);
    console.log('Settlement tx:', txHash);
    return txHash;
  } catch (err) {
    console.error('Settlement error:', err?.shortMessage || err?.message || String(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document extraction
// ---------------------------------------------------------------------------
async function fetchDocument(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ExtractPDF/1.0' } });
  if (!res.ok && res.status !== 300) throw new Error(`Fetch failed: ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
}

function isPdf(url, ct)  { return ct.includes('pdf')  || url.toLowerCase().endsWith('.pdf'); }
function isDocx(url, ct) { return ct.includes('wordprocessingml') || ct.includes('msword') || url.toLowerCase().endsWith('.docx') || url.toLowerCase().endsWith('.doc'); }
function stripHtml(html) { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, Accept',
};
const WWW_AUTH = `MPP realm="ExtractPDF", resource="https://www.extractpdf.xyz/api/extract", price="0.005 USDC", network="base"`;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','X-PAYMENT','PAYMENT-SIGNATURE','Accept'] }));
app.use(express.json());

function send402(res, errorMsg) {
  return res.status(402)
    .set({ ...CORS_HEADERS, 'Payment-Required': makePaymentRequiredHeader(), 'WWW-Authenticate': WWW_AUTH })
    .json(make402(errorMsg));
}

// GET — 402 so AgentCash probe triggers payment flow
app.get('/api/extract', (_req, res) => send402(res, 'Payment Required'));

// OPTIONS
app.options('/api/extract', (_req, res) => res.set(CORS_HEADERS).status(204).end());

// POST — verify, settle, extract
app.post('/api/extract', async (req, res) => {
  const paymentHeader = req.headers['payment-signature'] || req.headers['x-payment'];
  if (!paymentHeader) return send402(res, 'Payment Required');

  let verified;
  try { verified = await verifyPayment(paymentHeader); }
  catch (err) { return send402(res, `Payment verification failed: ${err.message}`); }

  // Blocking settlement — wait for tx so we can return the hash
  const settleTx = await settlePayment(verified.auth, verified.sig, verified.asset);

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const { buf, contentType } = await fetchDocument(url);

    if (isPdf(url, contentType)) {
      const data = await pdfParse(buf);
      return res.json({ url, format: 'pdf', text: data.text, length: data.text.length, pages: data.numpages, info: { title: data.info?.Title || null, author: data.info?.Author || null, subject: data.info?.Subject || null }, scraped_at: new Date().toISOString(), settlement_tx: settleTx });
    }
    if (isDocx(url, contentType)) {
      const result = await mammoth.extractRawText({ buffer: buf });
      return res.json({ url, format: 'docx', text: result.value, length: result.value.length, scraped_at: new Date().toISOString() });
    }
    const text = stripHtml(buf.toString('utf8'));
    return res.json({ url, format: 'text', text, length: text.length, scraped_at: new Date().toISOString() });

  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('Invalid PDF') || msg.includes('bad XRef')) return res.status(500).json({ error: 'Extraction failed', detail: 'Invalid PDF structure' });
    return res.status(500).json({ error: 'Extraction failed', detail: msg });
  }
});

export default app;
