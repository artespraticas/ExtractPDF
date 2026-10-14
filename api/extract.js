import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { paymentMiddlewareFromConfig } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/http';

// ---------------------------------------------------------------------------
// CDP Ed25519 JWT builder — creates an auth header for the CDP facilitator
// ---------------------------------------------------------------------------
function buildCdpJwt(keyId, pemSecret, path) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', kid: keyId, typ: 'JWT', nonce: crypto.randomBytes(16).toString('hex') };
  const payload = {
    iss: 'cdp',
    sub: keyId,
    nbf: now,
    exp: now + 120,
    uris: [`POST api.cdp.coinbase.com/platform/x402/v1/${path}`],
  };

  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;

  // Normalise PEM — Vercel stores multiline as literal \n
  const pem = pemSecret.replace(/\\n/g, '\n');
  const keyObj = crypto.createPrivateKey({ key: pem, format: 'pem' });
  const sig = crypto.sign(null, Buffer.from(signingInput), keyObj);
  return `${signingInput}.${sig.toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Facilitator client pointing at CDP (Base mainnet)
// ---------------------------------------------------------------------------
const cdpKeyId = process.env.CDP_API_KEY_ID;
const cdpSecret = process.env.CDP_API_KEY_SECRET;
const payTo = process.env.WALLET_ADDRESS;

if (!payTo) throw new Error('WALLET_ADDRESS env var required');

const facilitator = new HTTPFacilitatorClient({
  url: 'https://api.cdp.coinbase.com/platform/x402/v1',
  createAuthHeaders: async (path) => {
    if (!cdpKeyId || !cdpSecret) return { headers: {} };
    const jwt = buildCdpJwt(cdpKeyId, cdpSecret, path);
    return { headers: { Authorization: `Bearer ${jwt}` } };
  },
});

// ---------------------------------------------------------------------------
// Payment middleware — Base mainnet only (what AgentCash supports)
// ---------------------------------------------------------------------------
const paymentRoutes = [
  {
    path: '/api/extract',
    method: 'POST',
    price: '$0.005',
    payTo,
    network: 'base',
    description: 'PDF and DOCX text extraction',
  },
];

const paymentMiddleware = paymentMiddlewareFromConfig(paymentRoutes, [facilitator]);

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------
async function fetchDocument(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ExtractPDF/1.0' } });
  if (!res.ok && res.status !== 300) throw new Error(`Fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  return { buf: Buffer.from(buf), contentType: res.headers.get('content-type') || '' };
}

function isPdf(url, contentType) {
  return contentType.includes('pdf') || url.toLowerCase().endsWith('.pdf');
}

function isDocx(url, contentType) {
  return (
    contentType.includes('wordprocessingml') ||
    contentType.includes('msword') ||
    url.toLowerCase().endsWith('.docx') ||
    url.toLowerCase().endsWith('.doc')
  );
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-PAYMENT', 'PAYMENT-SIGNATURE', 'Accept'],
}));

app.use(express.json());

// Apply x402 payment middleware
app.use(paymentMiddleware);

// Health / discovery on GET — middleware returns 402 automatically
app.get('/api/extract', (req, res) => {
  res.json({ service: 'ExtractPDF', price: '$0.005', networks: ['base'] });
});

// Paid extraction endpoint
app.post('/api/extract', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const { buf, contentType } = await fetchDocument(url);

    if (isPdf(url, contentType)) {
      const data = await pdfParse(buf);
      return res.json({
        url,
        format: 'pdf',
        text: data.text,
        length: data.text.length,
        pages: data.numpages,
        info: {
          title: data.info?.Title || null,
          author: data.info?.Author || null,
          subject: data.info?.Subject || null,
        },
        scraped_at: new Date().toISOString(),
      });
    }

    if (isDocx(url, contentType)) {
      const result = await mammoth.extractRawText({ buffer: buf });
      return res.json({
        url,
        format: 'docx',
        text: result.value,
        length: result.value.length,
        scraped_at: new Date().toISOString(),
      });
    }

    // Fallback: treat as HTML/text
    const text = stripHtml(buf.toString('utf8'));
    return res.json({
      url,
      format: 'text',
      text,
      length: text.length,
      scraped_at: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('Invalid PDF') || msg.includes('bad XRef')) {
      return res.status(500).json({ error: 'Extraction failed', detail: 'Invalid PDF structure' });
    }
    return res.status(500).json({ error: 'Extraction failed', detail: msg });
  }
});

export default app;
