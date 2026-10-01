import { authenticator } from "otplib";
import QRCode from "qrcode";

authenticator.options = { window: 1 };

export function generateTotpSecret() {
  return authenticator.generateSecret();
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return authenticator.check(code.trim(), secret);
  } catch {
    return false;
  }
}

export async function totpQrCodeDataUrl(email: string, secret: string) {
  const uri = authenticator.keyuri(email, "Deskzo One", secret);
  return QRCode.toDataURL(uri);
}
