import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { EMBEDDED_FONTS } from "../../supabase/functions/creative-engine/fonts.generated";
import { agreementPrice, serviceLine, type Contract } from "./agreements";

// Embedded OFL fonts also used by the Creative Engine. The exact snapshot,
// both signatures, and the signing evidence become an immutable PDF artifact.
export async function buildAgreementPdf(c: Contract) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const source =
    EMBEDDED_FONTS.find((f) => f.weight === 400) ?? EMBEDDED_FONTS[0];
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
  const line = (text: string, size = 10) => {
    if (y < 55) {
      page = doc.addPage([612, 792]);
      y = 742;
    }
    page.drawText(text, { x: 50, y, size, font, color: rgb(0.08, 0.13, 0.22) });
    y -= size * 1.5;
  };
  const para = (text: string, size = 10) => {
    for (const paragraph of text.replace(/\r\n/g, "\n").split("\n")) {
      let row = "";
      for (const word of paragraph.split(/\s+/)) {
        const next = row ? `${row} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= 512) {
          row = next;
          continue;
        }
        if (row) line(row, size);
        row = "";
        // Split only a token longer than the full line, such as a long URL.
        for (const char of word) {
          if (font.widthOfTextAtSize(row + char, size) > 512) {
            line(row, size);
            row = "";
          }
          row += char;
        }
      }
      line(row, size);
    }
    y -= 8;
  };
  const s = c.snapshot;
  para(s.issuer_name, 15);
  para(c.title, 19);
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
  para(s.terms);
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
  pages.forEach((p, n) =>
    p.drawText(`Compass Agreements | ${n + 1} / ${pages.length}`, {
      x: 50,
      y: 28,
      size: 8,
      font,
    }),
  );
  doc.setTitle(c.title);
  doc.setAuthor(s.issuer_name);
  doc.setCreationDate(new Date(c.signed_at ?? c.created_at));
  doc.setModificationDate(new Date(c.signed_at ?? c.created_at));
  return doc.save();
}
