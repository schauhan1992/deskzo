import { randomBytes } from "node:crypto";
import type { MarketingTopic } from "@prisma/client";
import { db } from "@/lib/db";
import { fieldsUsed } from "@/lib/marketing/merge";
import { ASSET_PATH, removedInCleaning, sanitizeEmailHtml } from "@/lib/marketing/html";
import { extractInlineImages, normalisePath, readTemplateUpload, rewriteImageRefs, type UploadedImage } from "@/lib/marketing/template-upload";

/**
 * An uploaded template, stored: its pictures hosted, its references pointed at them, its HTML
 * cleaned, all in one transaction — so a template that fails its checks leaves no orphaned
 * pictures behind, and one that passes never points at a picture that isn't there.
 */

const newId = () => `ma${randomBytes(12).toString("hex")}`;

export async function storeUploadedTemplate(input: {
  userId: string;
  id?: string;
  name: string;
  topic: MarketingTopic;
  subject: string | null;
  preheader: string | null;
  fileName: string;
  bytes: Buffer;
}): Promise<{ ok: true; data: { id: string; warnings: string[]; body: string } } | { ok: false; error: string }> {
  if (!input.name.trim()) return { ok: false, error: "Give the template a name." };
  const read = await readTemplateUpload(input.fileName, input.bytes);
  if (!read.ok) return read;

  // Pictures written inline become uploads of their own, beside the HTML they came from.
  const base = normalisePath(read.htmlPath)?.split("/").slice(0, -1).join("/") ?? "";
  const inline = extractInlineImages(read.html);
  const images: UploadedImage[] = [
    ...read.images,
    ...inline.images.map((img) => ({ ...img, path: base ? `${base}/${img.path}` : img.path })),
  ];

  const ids = new Map(images.map((img) => [img.path, newId()]));
  const url = (img: UploadedImage) => `${ASSET_PATH}${ids.get(img.path)}/${encodeURIComponent(img.fileName)}`;
  const byPath = new Map(images.map((img) => [img.path, url(img)]));
  const rewritten = rewriteImageRefs(inline.html, read.htmlPath, (path) => byPath.get(path) ?? null);
  const body = sanitizeEmailHtml(rewritten.html);
  if (!body.replace(/<[^>]+>/g, "").trim() && !/<img\b/i.test(body)) return { ok: false, error: "Nothing is left in that template once it's cleaned — is it really an email?" };

  const used = fieldsUsed(`${input.subject ?? ""} ${input.preheader ?? ""} ${body}`);
  if (used.unknown.length > 0) {
    return { ok: false, error: `No such merge field: ${used.unknown.map((u) => `{{${u}}}`).join(", ")} — fix it in the file and upload again.` };
  }

  // Only the pictures the HTML actually uses are kept.
  const usedImages = images.filter((img) => body.includes(`${ASSET_PATH}${ids.get(img.path)}/`));
  const warnings: string[] = [];
  const removed = removedInCleaning(rewritten.html, body);
  if (removed.length) warnings.push(`Removed for safety: ${removed.join(", ")}.`);
  if (rewritten.missing.length) {
    warnings.push(`${rewritten.missing.length} picture${rewritten.missing.length === 1 ? " wasn't" : "s weren't"} in the upload and won't show: ${rewritten.missing.slice(0, 5).join(", ")}${rewritten.missing.length > 5 ? "…" : ""}. Upload a .zip with them, or use web links.`);
  }
  for (const s of read.skipped.slice(0, 5)) warnings.push(`Left out: ${s}.`);
  if (Buffer.byteLength(body) > 100 * 1024) warnings.push("Over 100 KB of HTML — Gmail cuts messages that long off with a \"View entire message\" link.");
  if (!input.subject?.trim()) warnings.push("No subject line yet.");

  const data = {
    name: input.name.trim(),
    channel: "EMAIL" as const,
    topic: input.topic,
    subject: input.subject?.trim() || null,
    preheader: input.preheader?.trim() || null,
    body,
    format: "HTML" as const,
    sourceFileName: input.fileName.slice(0, 200),
    active: true,
  };

  const id = await db.$transaction(async (tx) => {
    const template = input.id
      ? await tx.marketingTemplate.update({ where: { id: input.id }, data, select: { id: true } })
      : await tx.marketingTemplate.create({ data: { ...data, createdById: input.userId }, select: { id: true } });
    if (usedImages.length) {
      await tx.marketingAsset.createMany({
        data: usedImages.map((img) => ({
          id: ids.get(img.path)!,
          templateId: template.id,
          fileName: img.fileName.slice(0, 200),
          mimeType: img.mimeType,
          size: img.data.length,
          data: new Uint8Array(img.data),
          createdById: input.userId,
        })),
      });
    }
    return template.id;
  });

  return { ok: true, data: { id, warnings, body } };
}
