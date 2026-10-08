import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, PAYMENT-REQUIRED, Accept");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Health check (no payment required)
app.get("*", (req, res, next) => {
  if (req.headers["x-payment"] || req.headers["payment-required"]) return next();
  return res.status(200).json({
    service: "ExtractPDF",
    description: "Pay-per-use PDF and document extraction for AI agents",
    price: "$0.005 USDC per extraction",
    endpoint: "POST /api/extract",
    accepts_formats: ["pdf", "docx", "txt"],
    docs: "https://www.extractpdf.xyz",
    openapi: "https://www.extractpdf.xyz/openapi.json"
  });
});

// Circle Gateway middleware — auto-discovers supported networks
const gateway = createGatewayMiddleware({
  sellerAddress: process.env.WALLET_ADDRESS,
  facilitatorUrl: "https://gateway-api.circle.com",
});

// PDF extraction helpers
async function extractPdf(buffer) {
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const data = await pdfParse(buffer);
  return {
    text: data.text.trim().slice(0, 50000),
    pages: data.numpages,
    chars: data.text.length,
    title: data.info?.Title || "",
    author: data.info?.Author || "",
    format: "pdf"
  };
}

async function extractDocx(buffer) {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim().slice(0, 50000);
  return { text, pages: null, chars: text.length, title: "", author: "", format: "docx" };
}

async function extractText(buffer) {
  const text = buffer.toString("utf-8").trim().slice(0, 50000);
  return { text, pages: null, chars: text.length, title: "", author: "", format: "text" };
}

// Protected extraction endpoint — $0.005 USDC per call
app.post("*", gateway.require("$0.005"), async (req, res) => {
  const url = req.body?.url || req.query.url;

  if (!url) {
    return res.status(400).json({ error: "Missing required field: url" });
  }

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "ExtractPDF/1.0 (+https://www.extractpdf.xyz)" },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return res.status(422).json({
        error: "Failed to fetch document",
        detail: `HTTP ${response.status} from ${url}`
      });
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());

    let extracted;
    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      extracted = await extractPdf(buffer);
    } else if (contentType.includes("wordprocessingml") || url.toLowerCase().endsWith(".docx")) {
      extracted = await extractDocx(buffer);
    } else {
      extracted = await extractText(buffer);
    }

    return res.status(200).json({
      url,
      ...extracted,
      extracted_at: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
});

export default app;
