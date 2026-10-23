import { appRoute } from "@/lib/app/handler";
import { appContacts, throughApp } from "@/lib/app/sales";
import { createContactApi } from "@/lib/api/v1/companies";

/** Contacts in the Deskzo app. GET `?search=&page=`. POST `{ company, name, … }`: a new contact at a company. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appContacts);
export const POST = appRoute({}, throughApp("companies", createContactApi));
