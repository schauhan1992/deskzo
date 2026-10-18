# Deskzo AI — setting up the provider

Deskzo AI (src/lib/ai) runs the copilot and Automate's "Draft with AI" on Deskzo's own provider account,
paid for by workspaces in credits. Workspaces bring no key. This page is for whoever sets up that account
in **console › Settings › AI**. The first provider (owner, 17 Oct 2026) is **Claude on Amazon Bedrock,
India**: requests are processed only in Mumbai (ap-south-1) and Hyderabad (ap-south-2).

AWS renames console pages from time to time. If a page below has moved, search for it in the AWS
console's search bar.

## 1. In AWS

### Turn on the Claude models

1. Sign in to the AWS console with an account that can manage IAM and billing.
2. Switch the region (top right) to **Asia Pacific (Mumbai) — ap-south-1**.
3. Open **Amazon Bedrock › Model catalog** (older consoles: **Model access**). Enable **Claude Sonnet 5**,
   **Claude Opus 5** and **Claude Haiku 4.5**.
   - The first time, AWS asks for a short use-case form for Anthropic's models. Answer it as the company:
     "an AI assistant inside our business software, for our customers' staff".
   - Enabling may subscribe the account to the models through AWS Marketplace. That's done once, by the
     person enabling them, not by Deskzo's key.
4. Check the India inference profiles exist: **Amazon Bedrock › Cross-region inference** (or
   **Inference profiles**) in ap-south-1 should list `in.anthropic.claude-sonnet-5`,
   `in.anthropic.claude-opus-5` and `in.anthropic.claude-haiku-4-5-20251001-v1:0`. If the names differ,
   use the ones listed there as each model's "Name at the provider" in step 3 below.

### Make the key Deskzo uses

**Recommended: an IAM user with only this permission.**

1. **IAM › Policies › Create policy › JSON**. Paste the policy below, with your 12-digit AWS account ID in
   place of `ACCOUNT_ID`, and name it `DeskzoBedrockIndia`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "DeskzoInvokeClaudeInIndia",
         "Effect": "Allow",
         "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
         "Resource": [
           "arn:aws:bedrock:ap-south-1:ACCOUNT_ID:inference-profile/in.anthropic.*",
           "arn:aws:bedrock:ap-south-1::foundation-model/anthropic.*",
           "arn:aws:bedrock:ap-south-2::foundation-model/anthropic.*"
         ]
       }
     ]
   }
   ```

   An inference profile needs permission on the profile in the region requests are sent from, and on the
   model in every region it routes to. Here that's Mumbai and Hyderabad.

2. **IAM › Users › Create user**. Name it something like `deskzo-bedrock`, with no console access. Attach
   the `DeskzoBedrockIndia` policy and nothing else.
3. Open the user › **Security credentials › Create access key** › "Application running outside AWS".
   Copy the **Access key ID** (`AKIA…`) and the **Secret access key**. AWS shows the secret once, so if
   you lose it, make a new key.

**Alternative: a Bedrock API key.** In **Amazon Bedrock › API keys**, generate a **long-term API key** and
choose when it expires. It goes in the key field, with Access key ID left empty. It's quicker, but it
expires: put a reminder in the calendar to renew it. AWS suggests IAM credentials for anything long-lived.

### Watch the cost

- Check the per-token prices for the India profiles on **aws.amazon.com/bedrock/pricing** (Anthropic,
  Asia Pacific (Mumbai)). The rates Deskzo suggests assume list prices at ₹90 to the dollar; set each
  model's rates and costs in the console to match (step 3 below).
- Set an **AWS Budgets** alert on the account, so a surprise is an email rather than an invoice.

## 2. Add the account in the console

**console › Settings › AI › Add account**:

| Field | Value |
|---|---|
| Provider | Claude on Amazon Bedrock |
| Name in the console | Bedrock India |
| Where it processes requests | India (Mumbai and Hyderabad) |
| AWS region | ap-south-1 |
| Access key ID | the IAM user's `AKIA…` (empty with a Bedrock API key) |
| Secret access key, or Bedrock API key | the secret. It's sealed when saved and never shown again; only an owner can save it |
| No training | tick it once you have read AWS's Bedrock data terms (prompts and answers aren't used to train models or shared with the model's maker) |
| On | ticked |

## 3. Models, rates and routing

1. On the account: **Add suggested models** adds the three India profiles with suggested rates (credits
   for a million tokens; a credit is ₹1) and costs (paise for a million tokens, used only for the margin
   table). Change them to match Bedrock's price page.
2. **Routing**: Copilot chat → Claude Sonnet 5; Automate: drafting a workflow → Claude Haiku 4.5 (or
   Sonnet 5 for better drafts). Save.
3. **Test** on the account asks its first model for one word. It costs a few tokens and is charged to no
   workspace. The result is kept on the account.

Until a feature is routed, workspaces see "Deskzo AI isn't available right now" for it. The rest of the
app — Automate's workflows included — works the same without AI.

## When the test fails

| What it says | What it usually means |
|---|---|
| `AccessDeniedException` … not authorized to perform `bedrock:InvokeModel` | The policy is missing, attached to another user, or has the wrong account ID. |
| `AccessDeniedException` … don't have access to the model | The model isn't enabled in ap-south-1 (step 1.3), or the use-case form is still pending. |
| `ValidationException` … model identifier / inference profile is invalid | The "Name at the provider" doesn't match the profile listed in ap-south-1 (step 1.4). |
| The security token included in the request is invalid | The access key ID and secret don't belong together, or the key was deleted or rotated. |
| `ThrottlingException` | The account's per-minute quota for the model; ask AWS for more under **Service Quotas › Amazon Bedrock**. |

## Changing the key

Make a new access key on the IAM user and save it on the account with **Edit**. A blank key field keeps
the saved one. Then press **Test**, and delete the old key in IAM. Nothing in the workspaces changes.

## Other providers

The Add account dialog says where each one's key comes from. In short:

- **Azure OpenAI**: a resource in Central or South India, with Standard (regional) deployments. The
  deployment's name is the model's "Name at the provider".
- **Gemini on Vertex AI**: a service account with Vertex AI User and a JSON key, location `asia-south1`
  (never `global`).
- **Anthropic or OpenAI direct**, and **Google AI Studio**: an API key from their console. Processing is
  in the United States.
- **OpenAI-compatible** (vLLM, Ollama, Deskzo's own GPU later): the server's `/v1` base URL. Plain http
  is accepted only on the private network.
