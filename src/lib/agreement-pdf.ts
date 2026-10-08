import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EMBEDDED_FONTS } from "../../supabase/functions/creative-engine/fonts.generated";
import { agreementPrice, agreementTermBlocks, serviceLine, type Contract } from "./agreements";

// Embedded OFL fonts also used by the Creative Engine. The exact snapshot,
// both signatures, and the signing evidence become an immutable PDF artifact.
export async function buildAgreementPdf(c: Contract) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const source = EMBEDDED_FONTS.reduce((lightest, candidate) =>
    candidate.weight < lightest.weight ? candidate : lightest,
  );
  const font = await doc.embedFont(Buffer.from(source.base64, "base64"), {
    subset: true,
  });
  const supported = new Set(font.getCharacterSet());
  const text =
    JSON.stringify(c.snapshot) +
    c.title +
    c.recipient_name +
    (c.signer_name ?? "") +
    (c.provider_name ?? "");
  for (const character of text) {
    if (!supported.has(character.codePointAt(0)!))
      throw new Error(
        "Agreement contains a character the PDF font cannot render.",
      );
  }
  let page = doc.addPage([612, 792]);
  let y = 742;
  const newPage = () => {
    page = doc.addPage([612, 792]);
    page.drawText(c.snapshot.issuer_name, { x: 50, y: 757, size: 8, font, color: rgb(0.35, 0.4, 0.46) });
    page.drawLine({ start: { x: 50, y: 747 }, end: { x: 562, y: 747 }, thickness: 0.7, color: rgb(0.87, 0.89, 0.92) });
    y = 725;
  };
  const line = (text: string, size = 10) => {
    if (y < 55) {
      newPage();
    }
    page.drawText(text, { x: 50, y, size, font, color: rgb(0.08, 0.13, 0.22) });
    y -= size * 1.5;
  };
  const rows = (text: string, size = 10) => {
    const result: string[] = [];
    for (const paragraph of text.replace(/\r\n/g, "\n").split("\n")) {
      let row = "";
      for (const word of paragraph.split(/\s+/)) {
        const next = row ? `${row} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= 512) {
          row = next;
          continue;
        }
        if (row) result.push(row);
        row = "";
        // Split only a token longer than the full line, such as a long URL.
        for (const char of word) {
          if (font.widthOfTextAtSize(row + char, size) > 512) {
            result.push(row);
            row = "";
          }
          row += char;
        }
      }
      result.push(row);
    }
    return result;
  };
  const para = (text: string, size = 10) => {
    const wrapped = rows(text, size);
    const height = wrapped.length * size * 1.5 + 8;
    if (height <= 670 && y - height < 55) newPage();
    for (const row of wrapped) line(row, size);
    y -= 8;
  };
  const s = c.snapshot;
  if (s.issuer_name === "Compass Marketing Advisors LLC") {
    const logo = await doc.embedPng(await readFile(join(process.cwd(), "public", "compass-agreement-logo.png")));
    page.drawImage(logo, { x: 266, y: 678, width: 80, height: 80 * logo.height / logo.width });
    y = 657;
  }
  const centered = (text: string, size: number) => {
    const width = font.widthOfTextAtSize(text, size);
    if (width > 512) return para(text, size);
    page.drawText(text, { x: (612 - width) / 2, y, size, font, color: rgb(0.08, 0.13, 0.22) });
    y -= size * 1.5 + 8;
  };
  centered(s.issuer_name, 10);
  centered(c.title, 20);
  page.drawLine({ start: { x: 50, y: y + 7 }, end: { x: 562, y: y + 7 }, thickness: 1.5, color: rgb(0.95, 0.43, 0.08) });
  y -= 12;
  para(
    `Customer: ${s.scope.client_name}\nRecipient: ${c.recipient_name} <${c.recipient_email}>\nAgreement ID: ${c.id}`,
  );
  para(
    `Fee: ${agreementPrice(s.scope)}\nService start: ${s.scope.plan.start_date ?? "Not recorded"}\nTerm: ${s.scope.plan.term_months ? `${s.scope.plan.term_months} months` : "Month-to-month"}`,
  );
  para("Included services", 13);
  para(s.scope.services.map(serviceLine).join("\n"));
  if (s.scope.plan.managed_ad_budget_cents)
    para(
      `Managed advertising budget: ${s.scope.plan.managed_ad_budget_cents / 100} ${s.scope.plan.currency.toUpperCase()}`,
    );
  para("Agreement terms", 13);
  const blocks = agreementTermBlocks(s.terms);
  for (const [index, block] of blocks.entries()) {
    if (block.heading) {
      const headingHeight = rows(block.text, 12).length * 18 + 8;
      const followingHeight = rows(blocks[index + 1]?.text ?? "", 10).length * 15 + 8;
      if (y - headingHeight - Math.min(followingHeight, 150) < 55) newPage();
    }
    para(block.text, block.heading ? 12 : 10);
  }
  if (y < 285) newPage();
  para("Electronic signatures and record", 13);
  para(
    `Provider: ${c.provider_name ?? ""}\nProvider signed (UTC): ${c.provider_signed_at ?? ""}\nCustomer: ${c.signer_name ?? ""}\nCustomer signed (UTC): ${c.signed_at ?? ""}\nVerified email: ${c.recipient_email}`,
  );
  para(c.consent_text ?? "");
  para(
    `Content SHA-256: ${c.content_hash ?? ""}\nObserved IP: ${c.signer_ip ?? "Unavailable"}\nBrowser: ${c.signer_agent ?? "Unavailable"}`,
    8,
  );
  para(
    "Payment authorization is collected separately by the payment processor. This document is an electronically signed record, not a certificate-based digital signature.",
    8,
  );
  const pages = doc.getPages();
  pages.forEach((p, n) => {
    p.drawLine({ start: { x: 50, y: 42 }, end: { x: 562, y: 42 }, thickness: 0.7, color: rgb(0.87, 0.89, 0.92) });
    p.drawText(`Compass Agreements | ${n + 1} / ${pages.length}`, {
      x: 50,
      y: 28,
      size: 8,
      font,
    });
  });
  doc.setTitle(c.title);
  doc.setAuthor(s.issuer_name);
  doc.setCreationDate(new Date(c.signed_at ?? c.created_at));
  doc.setModificationDate(new Date(c.signed_at ?? c.created_at));
  return doc.save();
}
