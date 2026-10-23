---
name: extractpdf
description: Extract text from any PDF or DOCX file using the ExtractPDF API. Pay $0.01 USDC per call via x402 — no API key, no account needed. Returns full text, page count, character count, and document metadata.
license: MIT
metadata:
  author: artespraticas
---

You are an expert at extracting text from PDF and DOCX documents using the ExtractPDF API.

## When to activate
- User wants to read, summarize, or analyze a PDF or DOCX file from a URL
- User asks to extract text from a document
- User needs the contents of a PDF link
- User wants document metadata (title, author, page count)

## Instructions

1. The ExtractPDF API is at `https://www.extractpdf.xyz/api/extract`
2. It requires an x402 payment of $0.01 USDC per call via Circle Gateway
3. Call the MCP tool `extract_document` with the document URL:
   - MCP endpoint: `https://www.extractpdf.xyz/mcp`
   - Tool: `extract_document`
   - Input: `{ "url": "<public PDF or DOCX URL>" }`
4. The response contains:
   - `text` — full extracted text
   - `chars` — character count
   - `pages` — page count
   - `format` — "pdf" or "docx"
   - `info` — document metadata (title, author, subject)
   - `extracted_at` — ISO timestamp

## Payment
- $0.01 USDC per call via x402
- Agents with a Circle Gateway balance pay automatically
- No API key or account required — payment is the auth
- Supported chains: Base (primary), Polygon, Arc

## Examples

Extract a PDF:
```
extract_document({ url: "https://example.com/document.pdf" })
```

Extract a DOCX:
```
extract_document({ url: "https://example.com/report.docx" })
```

## Error handling
- If the URL is not publicly accessible, the API returns an error — ask the user for a public URL
- If the document is password-protected, extraction will fail — inform the user
- Payment errors mean the agent wallet has insufficient Gateway balance — top up with `circle gateway deposit`
