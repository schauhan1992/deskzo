import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Email Signatures — written from src/app/(dashboard)/signatures (My email signature, and Email
 * signatures with its People, Templates, Banners, Clicks, Who gets which and Connection tabs),
 * src/components/signatures (the template, banner, rules and shared-mailbox editors, the clicks report,
 * the connection panel, the copy buttons), src/actions/signature.ts (everything but your own signature
 * needs signatures.manage), src/lib/signatures/person.ts (who gets which template) and sync.ts (keeping
 * Gmail and Zoho Mail in step). Only the user-visible steps of the Google, Zoho and Outlook set-ups.
 */
export const guide: SeedGuide = {
  slug: "help/email-signatures",
  title: "Email Signatures",
  seo: {
    title: "Email Signatures: one design in every mailbox",
    description: "How to design the company's email signatures, decide who gets which, and put them into everybody's Gmail, Zoho Mail or Outlook — kept up to date.",
    keywords: ["email signatures", "company email signature", "Outlook signature add-in"],
  },
  guide: {
    module: "signatures",
    heading: "Email Signatures",
    summary: "The company's email signatures: designed once, each person's details filled in from their record, and put into everybody's Gmail, Zoho Mail or Outlook — kept in step when a title or a number changes.",
    purpose: [
      p("Email Signatures gives everybody the same signature design with their own details in it — name, job title, department, work phone, email, office address and photo — taken from their record. Change somebody's title and their signature changes with it."),
      p("You design templates, decide which department, branch, role or person gets which, and put a banner under the signatures for an event or an offer. A Clicks report counts clicks on banners and buttons, without knowing who clicked."),
      p("How a signature reaches the mailbox depends on your mail:"),
      ul(
        runs({ b: "Google Workspace (Gmail)" }, " or ", { b: "Zoho Mail" }, " — connected once, then each person's signature is put into their mailbox and kept in step."),
        runs({ b: "Microsoft 365 (Outlook)" }, " — an add-in your Microsoft 365 administrator deploys puts the signature into each new message as it is written."),
        "Without either, everybody copies their signature from the app and pastes it into their mail program.",
      ),
    ],
    access: [
      p(runs("Everybody can open ", { b: "My work › My email signature" }, ": their own signature, whether it is in their mailbox yet, and buttons to copy it.")),
      p(runs("People allowed to manage email signatures also see ", { b: "My work › Email signatures" }, ", where the templates, banners, clicks, who gets which and the mail connection are.")),
    ],
    permissions: [
      perm("section.signatures", "Shows Email Signatures in the menu and lets people open its pages, My email signature included. Every role has it until an admin unticks it for one."),
      perm(
        "signatures.manage",
        "Lets somebody design the templates and banners, decide who gets which, connect Google Workspace or Zoho Mail, turn on the Outlook add-in, put signatures into everybody's mailbox and read the clicks report. Management has it by default, as do admins.",
      ),
    ],
    setup: [
      p("Somebody allowed to manage signatures does this once:"),
      ol(
        runs("Design the company's template in ", { b: "My work › Email signatures › Templates" }, " — see below."),
        runs("If some people need another one, add rules under ", { b: "Who gets which" }, "."),
        runs("Connect your mail on the ", { b: "Connection" }, " tab, following the steps it shows for your suite."),
      ),
      p("The connection steps, in short:"),
      ul(
        runs({ b: "Google Workspace" }, " — in Google Cloud, turn on the Gmail API for a project of your company's and make a service account with a JSON key. In the Google Admin console, give that service account domain-wide delegation with the scope the screen names. Paste the key under ", { b: "Service account key (JSON)" }, ", give a Google Workspace administrator's address under ", { b: "Try it as" }, ", and select ", { b: "Connect Google Workspace" }, "."),
        runs({ b: "Zoho Mail" }, " — the Zoho app has to be set up first in ", { b: "Settings › Security & data protection" }, ", under Email & sign-in. A Zoho Mail administrator then selects ", { b: "Connect Zoho Mail" }, " and approves. If asked, give the ", { b: "Organisation ID" }, " from the Zoho Mail Admin Console."),
        runs({ b: "Outlook" }, " — select ", { b: "Turn on the Outlook add-in" }, ", then ", { b: "Download the add-in file" }, ". A Microsoft 365 administrator uploads it in the Microsoft 365 admin center, under Settings › Integrated apps › Upload custom apps, as an Office Add-in, and deploys it to everybody or to some groups."),
      ),
      note("Outlook can take a few hours to pick up a newly deployed add-in — Microsoft allows up to a day — and people may need to restart Outlook."),
    ],
    tasks: [
      task(
        "Design a signature template",
        ol(
          runs("Open ", { b: "My work › Email signatures" }, ", the ", { b: "Templates" }, " tab, and select ", { b: "New template" }, " — or ", { b: "Edit" }, " beside one."),
          runs("Pick a ", { b: "Layout" }, ", and set the ", { b: "Name" }, ", ", { b: "Font" }, " and ", { b: "Colour" }, "."),
          runs("Under ", { b: "From each person's record" }, ", choose what to show: photo, job title, department, work phone, email, office address."),
          runs("Under ", { b: "Logo" }, ", leave the address empty to use the logo in ", { b: "Settings › Branding" }, ", or give one starting https://."),
          runs("Under ", { b: "The same for everybody" }, ", add the ", { b: "Website" }, ", social profiles, a button (", { b: "Button text" }, " and ", { b: "Button link" }, "), a ", { b: "Sign-off" }, " and a ", { b: "Disclaimer" }, "."),
          runs("Check the ", { b: "Preview" }, ", then select ", { b: "Save" }, ". The button says how many signatures change."),
        ),
        p(runs("Every link must start https://. ", { b: "Make default" }, " sets the template everybody gets unless a rule says otherwise; a template can't be deleted while it is the default.")),
      ),
      task(
        "Decide who gets which signature",
        ol(
          runs("Open the ", { b: "Who gets which" }, " tab."),
          runs("Under ", { b: "Who" }, ", choose ", { b: "A person" }, ", ", { b: "A department" }, ", ", { b: "A branch" }, " or ", { b: "A role" }, ", then which one under ", { b: "Which" }, "."),
          runs("Under ", { b: "Gets" }, ", choose the template, and select ", { b: "Add" }, "."),
        ),
        p("When several rules fit somebody, a rule for the person wins, then their department's, their branch's and their role's. Everybody else gets the default."),
      ),
      task(
        "Put signatures into everybody's mailbox",
        p(runs("With Gmail or Zoho Mail connected, the ", { b: "People" }, " tab shows each person's template and whether their signature is ", { b: "In their mailbox" }, ", ", { b: "Changed — goes out next" }, ", ", { b: "Waiting to go out" }, ", ", { b: "Failed" }, " or has ", { b: "No mailbox" }, ". Select ", { b: "Sync everybody now" }, " to put them in straight away. A failed one is tried again on its own.")),
        p("With the Outlook add-in there is nothing to sync: Outlook asks for each person's signature as they start a message, so a change reaches their next one."),
      ),
      task(
        "Put a banner under the signatures",
        ol(
          runs("Open the ", { b: "Banners" }, " tab and select ", { b: "New banner" }, ". You can ", { b: "Start from a sample" }, "."),
          runs("Give it a ", { b: "Name" }, " — only for you, it isn't shown in emails."),
          runs("For the ", { b: "Picture" }, ", ", { b: "Upload a picture" }, " (PNG, JPEG or GIF, 1 MB at most) or ", { b: "Use an https:// address" }, "."),
          runs("Fill in ", { b: "Links to (https://)" }, ", ", { b: "What it says" }, " (shown where pictures are blocked), and the ", { b: "Width (pixels)" }, "."),
          runs("Set the days it ", { b: "Starts" }, " and ", { b: "Ends" }, ", or leave them empty to run until you pause it."),
          runs("Under ", { b: "Under whose signature" }, ", choose ", { b: "Everybody's" }, " or the signatures of some templates, and select ", { b: "Save banner" }, "."),
        ),
        p(runs("A signature carries one banner at a time: one meant for its template wins over one for everybody. ", { b: "Pause" }, " stops a banner for now; removing one leaves emails already sent with its picture and link.")),
      ),
      task(
        "See how many people clicked",
        p(runs("Open the ", { b: "Clicks" }, " tab and choose the last 7, 30 or 90 days. Pick a banner or button to see its clicks by day, by team, and whose signatures were clicked. Clicks are counted only while ", { b: "Count clicks on banners and buttons" }, " is ticked. Who clicked is never known or kept, and some mail programs check links before the reader sees them, so treat the numbers as a little high.")),
      ),
      task(
        "Give a shared mailbox its own signature in Outlook",
        ol(
          runs("On the ", { b: "Who gets which" }, " tab, under ", { b: "Shared mailboxes (Outlook)" }, ", select ", { b: "Add a mailbox" }, "."),
          runs("Give its ", { b: "Address" }, " — sales@ or support@ — the name it is ", { b: "Signed as" }, ", its ", { b: "Phone" }, " and its ", { b: "Template" }, "."),
          runs("Select ", { b: "Save mailbox" }, "."),
        ),
        p("When somebody sends from that mailbox in Outlook, the add-in puts in the mailbox's signature instead of theirs. This needs the Outlook add-in on."),
      ),
      task(
        "Copy your own signature",
        ol(
          runs("Open ", { b: "My work › My email signature" }, "."),
          runs("Select ", { b: "Copy signature" }, " — or ", { b: "Copy HTML" }, " for a mail program that wants the code."),
          runs("Paste it into your mail program's signature settings. ", { b: "Pasting it in yourself" }, " has the steps for Outlook, Gmail and Apple Mail."),
        ),
        p("The top of the page says whether your signature is already in your Gmail, Zoho Mail or Outlook. Where the template has a shorter one for replies and forwards, it is shown separately to copy too."),
      ),
    ],
    settings: [
      setting(
        "Keep everybody's signature in step on its own",
        "My work › Email signatures › Connection",
        p("With it ticked, a changed title or phone goes out to Gmail or Zoho Mail within minutes. Untick it and signatures go out only when you select Sync everybody now."),
      ),
      setting("Disconnect", "My work › Email signatures › Connection", p("Stops putting signatures into Gmail or Zoho Mail. Signatures already in mailboxes stay there.")),
      setting(
        "Outlook add-in",
        "My work › Email signatures › Connection",
        p(runs({ b: "Turn on the Outlook add-in" }, " or turn it off. ", { b: "Turn off people's own Outlook signature, so a message never carries two" }, " removes a person's own signature as the add-in puts the company's in. While the add-in is on, anybody who knows a person's work address can ask for that person's signature — what every email they send shows anyway.")),
      ),
      setting("Count clicks on banners and buttons", "My work › Email signatures › Clicks", p("While on, banner and button links go through your workspace's own short address, which counts the click and sends the reader straight on. The logo, website and social profiles always link directly. Turning it on or off changes every signature, so all of them go out again.")),
      setting(
        "On replies and forwards",
        "In each template",
        p("The whole signature, a short one (name, title, company and phone), or none, on replies and forwards. Only Outlook's add-in can tell a reply from a new message; Gmail and Zoho Mail keep one signature for both."),
      ),
      setting("Zoho app", "Settings › Security & data protection", p("Under Email & sign-in. Connecting Zoho Mail for signatures uses the same Zoho app people connect their Zoho Mail through, so it has to be set up there first.")),
    ],
    faq: [
      qa(
        "I don't see Email signatures in the menu.",
        p("My email signature is there for everybody unless the module is switched off (Settings › Modules) or your role has had the section hidden (Settings › Roles & Permissions). Email signatures, for managing everybody's, also needs the permission to manage email signatures."),
      ),
      qa("My job title or phone is wrong in my signature.", p("It comes from your record. Change it there — or ask whoever keeps the records — and your signature follows; with Gmail or Zoho Mail connected it goes out to your mailbox within minutes.")),
      qa("It says my signature failed.", p("The reason is shown beside it, on your page and on the People tab. It is tried again on its own. If the connection itself stopped, the Connection tab says why.")),
      qa("It says No mailbox, or Not for Zoho Mail.", p("Zoho Mail has no account at your work address, so there is nowhere to put the signature. Copy it from My email signature and paste it into the mail program you use.")),
      qa("Outlook doesn't put my signature in.", p("The add-in can take a few hours to reach you after it is deployed — up to a day — and Outlook may need a restart. Your page says when Outlook last fetched your signature.")),
      qa("My Outlook messages carry two signatures.", p("Ask whoever manages signatures to tick Turn off people's own Outlook signature, on the Connection tab. Or remove your own in Outlook's signature settings.")),
      qa("Does the clicks report show who clicked?", p("No. It counts clicks on banners and buttons, by day and by whose signature it was — never who clicked.")),
    ],
    related: ["cards", "hr", "companies"],
  },
};
