/**
 * No real email provider is wired up yet (see ROADMAP known gaps — same gap as password-reset
 * delivery). This stub exists so every notification call site already fires the "send an email
 * too" hook and won't need to change when a real provider (Resend/SendGrid) is added later —
 * only this function's body does.
 */
export async function sendEmailNotification(params: { userId: string; subject: string; body: string }) {
  console.log(`[email stub] would notify user ${params.userId}: ${params.subject} — ${params.body}`);
}
