# Sub-processors

> **Draft for review by counsel.** The hosting provider and mail provider are not chosen yet; fill them in before the first customer, and give 30 days' notice of any change afterwards (DPA §6).

## Wroffy's sub-processors

| Sub-processor | What it does | Personal data it sees | Where |
|---|---|---|---|
| *Hosting provider — to be chosen* | Runs the servers, databases and backups | Everything in every workspace (encrypted at rest where the provider offers it; workspace secrets additionally encrypted by the platform) | India (region to be confirmed) |
| *Mail provider — to be chosen* (`PLATFORM_SMTP_URL`) | Sends the platform's own mail: signup codes, workspace-ready notices, billing reminders, staff password links | Recipients' email addresses and names | To be confirmed |
| Stripe, Inc. / Stripe Payments Europe | Charges workspaces outside India; collects tax numbers; works out tax | Workspace owner's name, billing email, address, tax number, card details (held by Stripe, never by Wroffy) | USA / EU |
| Razorpay Software Pvt. Ltd. | Charges workspaces in India | Workspace owner's name, billing email, phone, payment method (held by Razorpay) | India |

## Not sub-processors

Connected by a customer to its own workspace, with its own credentials, on its own instructions — acting for the customer:

- the customer's own mail provider (marketing sends, document emails) and Microsoft 365 (single sign-on, sending from a person's mailbox);
- the AI provider the customer configures for the copilot (Anthropic, OpenAI or Google, with the customer's own key);
- the government's e-invoice and e-way bill portals (India), through the customer's own credentials.

Used by the platform, but receiving no personal data:

- data.gov.in (India's PIN code directory) and GeoNames (world places) — reference data downloaded into the platform; nothing is sent to them about anybody.
