import express from 'express';
import cors from 'cors';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { Buffer } from 'node:buffer';

const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
if (!WALLET_ADDRESS) throw new Error('WALLET_ADDRESS env var required');

// Circle Gateway middleware — handles 402 negotiation, verification, and settlement
const gateway = createGatewayMiddleware({
  sellerAddress: WALLET_ADDRESS,
  facilitatorUrl: 'https://gateway-api.circle.com',
});

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
// Buffer raw body first so gateway middleware + our handler both see it
app.use(express.raw({ type: '*/*', limit: '1mb' }));
app.use((req, _res, next) => {
  if (Buffer.isBuffer(req.body)) {
    try { req.body = JSON.parse(req.body.toString()); } catch { req.body = {}; }
  }
  next();
});

// Health / discovery
app.get('/api/extract', (_req, res) => {
  res.json({
    service: 'ExtractPDF',
    description: 'Pay-per-use PDF and DOCX text extraction for AI agents',
    price: '$0.01 USDC per call',
    endpoint: 'POST /api/extract',
    accepts_formats: ['pdf', 'docx'],
    docs: 'https://www.extractpdf.xyz',
  });
});

// Paid extraction endpoint — Gateway middleware gates the route
app.post(
  '/api/extract',
  gateway.require('$0.01'),
  async (req, res) => {
    // Body may arrive pre-parsed or as a raw string from some clients
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const { url } = body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Missing required field: url (string, public PDF or DOCX URL)' });
    }

    try {
      const { buf, contentType } = await fetchDocument(url);

      if (isPdf(url, contentType)) {
        const data = await pdfParse(buf);
        return res.json({
          url,
          format: 'pdf',
          text: data.text.slice(0, 50000),
          chars: data.text.length,
          pages: data.numpages,
          info: {
            title: data.info?.Title || null,
            author: data.info?.Author || null,
            subject: data.info?.Subject || null,
          },
          extracted_at: new Date().toISOString(),
        });
      }

      if (isDocx(url, contentType)) {
        const result = await mammoth.extractRawText({ buffer: buf });
        const text = result.value.slice(0, 50000);
        return res.json({
          url,
          format: 'docx',
          text,
          chars: text.length,
          extracted_at: new Date().toISOString(),
        });
      }

      // Plain text / HTML fallback
      const raw = buf.toString('utf8').slice(0, 50000);
      const text = contentType.includes('html') ? stripHtml(raw) : raw;
      return res.json({ url, format: 'text', text, chars: text.length, extracted_at: new Date().toISOString() });

    } catch (err) {
      console.error('Extraction error:', err?.message || String(err));
      const msg = err?.message || '';
      if (msg.includes('Invalid PDF')) return res.status(500).json({ error: 'Extraction failed', detail: 'Invalid PDF structure' });
      if (msg.includes('Fetch failed')) return res.status(500).json({ error: 'Extraction failed', detail: msg });
      return res.status(500).json({ error: 'Extraction failed', detail: msg });
    }
  },
);

export default app;
