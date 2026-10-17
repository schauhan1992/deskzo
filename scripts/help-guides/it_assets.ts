import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * IT Assets — written from src/app/(dashboard)/assets (the register, an asset's page, What I'm holding),
 * src/app/(dashboard)/logistics (Consignments, a consignment's page, Transporters), src/components/assets
 * (the add dialog, the asset record and its movements, the consignment board and record),
 * src/components/companies/company-estate.tsx (a customer's IT Assets tab), src/actions/it-asset.ts,
 * consignment.ts and transporter.ts (who may see, add, move and despatch), and src/lib/assets/lifecycle.ts
 * (ownership, status and cover rules, and when a consignment needs an e-way bill).
 */
export const guide: SeedGuide = {
  slug: "help/it-assets",
  title: "IT Assets",
  seo: {
    title: "IT Assets: machines, licences, custody and consignments",
    description: "How to keep an IT asset register in {siteName}: your kit, kit at clients, estates you manage, who holds what, warranty and AMC cover, and consignments.",
    keywords: ["IT asset register", "asset custody", "consignments"],
  },
  guide: {
    module: "it_assets",
    heading: "IT Assets",
    summary: "A register of every machine and licence — yours, yours at a client, and the client estates you look after — with who holds each one, its warranty and AMC cover, its movement history, and the consignments that ship kit about.",
    purpose: [
      p("IT Assets tracks each machine and licence on its own: its tag, serial number, make and model, who has it, where it is, and whether a warranty or AMC still covers it. Every hand-over, return, repair and transfer is recorded as a movement, and the asset's status follows from the last one, so the history always explains the status."),
      p(runs("Each asset says whose it is, under ", { b: "Whose is it?" }, ":")),
      ul(
        runs({ b: "Ours — used internally" }, " — the company's own kit, in the office or with a person."),
        runs({ b: "Ours — at a client" }, " — still yours, standing at a customer's site. It has to come back."),
        runs({ b: "The client's — we manage it" }, " — their property, on your register because you look after it."),
      ),
      note("A client's asset is something you look after, never something you own. It can't be linked to a fixed-asset record and never reaches your balance sheet."),
      p(runs({ b: "Consignments" }, " move kit about: delivering a sale, deploying your kit to a client, sending something for repair, returning to a vendor, moving between your own sites, or collecting from a client. Anything that isn't a sale travels on a delivery challan raised from the consignment. In India, the consignment also says when an e-way bill is needed before it moves.")),
    ],
    access: [
      p(runs("Everybody who can open IT Assets has ", { b: "What I'm holding" }, ": the company equipment on their name, where they confirm a hand-over. It's also what the offboarding checklist reads when somebody leaves.")),
      p("Seeing the whole register — other people's kit and the client estates — takes See every IT asset. Without it, the Assets page shows only what you're holding."),
      p("Adding assets, recording movements, seeing licence keys and running consignments takes Manage IT assets."),
    ],
    permissions: [
      perm("section.itAssets", "Shows IT Assets in the menu and lets people open its pages, including What I'm holding. Every role has it until an admin unticks it for one."),
      perm("assets.manage", "Add assets, record their movements, see licence keys, and open Consignments to create, dispatch, deliver and cancel them and raise their delivery challans. Includes seeing every asset. Purchase has it by default, and the Support lead preset includes it."),
      perm("assets.viewAll", "See the whole register — assets held by other people and the estates you manage for clients — and a customer's IT Assets tab. Management, Support and Purchase have it by default."),
      perm("orders.process", "Besides processing orders, opens Settings › Transporters, since purchase despatches goods too. Purchase and Management have it by default."),
    ],
    setup: [
      p(runs("Somebody who manages IT assets adds what you have with ", { b: "Add an asset" }, " — your own kit and the client estates you look after alike. A client's estate can also be added from the customer's ", { b: "IT Assets" }, " tab with ", { b: "Add to their estate" }, ".")),
      p(runs("Before shipping anything, add your couriers once in ", { b: "Settings › Transporters" }, ", with the GSTIN or TRANSIN an e-way bill needs.")),
      p(runs("An admin gives ", { b: "Manage IT assets" }, " and ", { b: "See every IT asset" }, " to the right roles in ", { b: "Settings › Roles & Permissions" }, ".")),
    ],
    tasks: [
      task(
        "Add an asset",
        ol(
          runs("Open ", { b: "IT Assets › Assets" }, " and select ", { b: "Add an asset" }, "."),
          runs("Choose ", { b: "Whose is it?" }, ". For a client's asset, choose the client under ", { b: "Whose?" }, "."),
          runs("Enter the ", { b: "Asset tag" }, " (what's stuck on the machine), ", { b: "Serial number" }, ", ", { b: "What kind" }, ", ", { b: "Name" }, ", ", { b: "Make" }, " and ", { b: "Model" }, "."),
          runs("For your own kit, say where it's ", { b: "Sitting at" }, " — your office or a client — and ", { b: "Which site" }, ". For a software licence, enter the ", { b: "Licence key" }, " and ", { b: "Seats" }, "."),
          runs("Add ", { b: "Bought on" }, ", ", { b: "Cost" }, ", ", { b: "Warranty ends" }, ", ", { b: "AMC ends" }, ", ", { b: "Bought from" }, " and the ", { b: "Catalogue item" }, " if you have them. For your own kit you can link its ", { b: "Financial record" }, " in the fixed asset register."),
          runs("Select ", { b: "Add" }, "."),
        ),
      ),
      task(
        "Hand an asset to someone, or take it back",
        ol(
          "Open the asset.",
          runs("Under ", { b: "Record a movement" }, ", select ", { b: "Assigned" }, ". Choose ", { b: "When" }, " and ", { b: "To whom" }, ", add a ", { b: "Note" }, " if you like, and confirm."),
          runs("When it comes back, select ", { b: "Returned" }, "."),
        ),
        p(runs("The person is told it's theirs, and it stays on their record until it's returned. The other movements are ", { b: "Sent for repair" }, " (with ", { b: "Where to" }, "), ", { b: "Back from repair" }, ", ", { b: "Transferred" }, " (to a company and site), ", { b: "Scrapped" }, " and ", { b: "Reported lost" }, ". A button that doesn't make sense from where the asset is now is greyed out, and says why when you point at it.")),
      ),
      task(
        "Confirm you have an asset",
        ol(
          runs("Open ", { b: "IT Assets › What I'm holding" }, "."),
          runs("On the asset handed to you, select ", { b: "Yes, I have it" }, "."),
        ),
        p("Only the person it was handed to can confirm. The card then shows the day you confirmed it."),
      ),
      task(
        "Create a consignment",
        ol(
          runs("Open ", { b: "IT Assets › Consignments" }, " and select ", { b: "New consignment" }, "."),
          runs("Choose ", { b: "Why is it moving?" }, ", where to ", { b: "Dispatch from" }, ", who it goes ", { b: "To" }, " and the ", { b: "Site" }, "."),
          runs("Pick the ", { b: "Transporter" }, " and the ", { b: "Expected" }, " day."),
          runs("Under ", { b: "What's going" }, ", tick the assets, filtering by tag, name or serial. Software licences can't be sent — there's nothing to ship."),
          runs("Add ", { b: "Notes" }, " if you like, and select ", { b: "Create" }, "."),
        ),
        p(runs("The consignment starts as ", { b: "Being packed" }, ". For anything that isn't a sale, open it and select ", { b: "Raise the challan" }, " — see ", ["Sales Documents", "/help/sales-documents"], ".")),
      ),
      task(
        "Dispatch and deliver a consignment",
        ol(
          runs("Open the consignment and select ", { b: "Dispatch" }, "."),
          runs("Fill in ", { b: "Dispatched on" }, ", ", { b: "Courier" }, ", ", { b: "Docket number" }, ", ", { b: "LR number" }, ", ", { b: "Vehicle" }, " and, where one is needed, the ", { b: "E-way bill number" }, " and ", { b: "Valid until" }, ". Select ", { b: "Dispatch" }, "."),
          runs("When it arrives, select ", { b: "Mark delivered" }, ", enter ", { b: "Delivered on" }, " and ", { b: "Received by" }, ", tick ", { b: "Installed and working, not just dropped off" }, " if it is, and select ", { b: "Delivered" }, "."),
        ),
        p(runs("To call one off before it's delivered, select ", { b: "Cancel" }, ", say why, and select ", { b: "Cancel it" }, ". Once it's delivered, record a return instead.")),
        note("In India, a consignment that needs an e-way bill can't be dispatched without its number — the goods could be detained in transit. Whether one is needed depends on the goods' value and whether they cross a state line, even when nothing is being sold.", "warning"),
      ),
      task(
        "Look after a client's estate",
        p(runs("On a customer's ", { b: "IT Assets" }, " tab you see everything you look after for them: ", { b: "Theirs, managed" }, ", ", { b: "Ours at their site" }, ", what's ", { b: "On the road" }, " (yours that was at their site and is now in transit or at a repair centre), and whose ", { b: "Cover running out" }, ". Select ", { b: "Add to their estate" }, " to add one of their machines.")),
      ),
      task(
        "Watch warranty and AMC cover",
        p(runs("The Assets page counts the assets whose ", { b: "Cover running out" }, " — within 30 days, or already lapsed. Each asset's ", { b: "Cover" }, " card shows its warranty and AMC end dates; it's covered if either is still live.")),
      ),
    ],
    settings: [
      setting(
        "Transporters",
        "Settings › Transporters",
        p(runs("The couriers and carriers you use, picked on every consignment rather than typed afresh. ", { b: "New transporter" }, ": its ", { b: "Name" }, ", ", { b: "GSTIN or TRANSIN" }, " (15 characters), contact details and ", { b: "Usual mode" }, " — Road, Rail, Air or Ship.")),
        p(runs("A transporter no longer used can be retired, and restored later; ", { b: "Show retired" }, " lists them. Opened by people who manage IT assets or process orders.")),
      ),
      setting(
        "e-Way bills",
        "Settings › e-Way bills",
        p("India only. The connection to the e-way bill portal, and the value threshold for movements inside your own state, which the consignment uses to say whether a bill is needed. Changed by people allowed to change organisation settings."),
      ),
      setting("Whose is it?", "On each asset", p("Ours — used internally, Ours — at a client, or The client's — we manage it. A client's asset has to name the client, and an asset of yours at a client has to name its site.")),
    ],
    faq: [
      qa("The Assets page shows only my own kit.", p("Seeing other people's kit and the client estates takes See every IT asset. Ask an admin.")),
      qa("I can't open Consignments.", p("Dispatching kit takes Manage IT assets. Without it, Consignments isn't in the menu.")),
      qa("Why can't I see the licence key?", p("Licence keys show only to people who manage IT assets.")),
      qa(
        "Why is a movement button greyed out?",
        p("It doesn't make sense from where the asset is now: an asset away for repair has to come back before it can go anywhere else, and a scrapped asset can't be moved at all. Point at the button to see why."),
      ),
      qa("Why can't a client's laptop have a fixed-asset record?", p("It's their property, not yours. Capitalising it would put somebody else's asset on your balance sheet.")),
      qa("Dispatch says the consignment needs an e-way bill.", p("Raise the e-way bill (once the challan exists, its panel is on the consignment) or enter the number of one already raised, then dispatch again.")),
      qa(
        "I don't see IT Assets in the menu.",
        p("Either the module is switched off for your company, or your role has had it hidden. Ask an admin: the switch is in Settings › Modules, and the menu section is in Settings › Roles & Permissions."),
      ),
    ],
    related: ["sales_documents", "companies", "helpdesk", "hr"],
  },
};
