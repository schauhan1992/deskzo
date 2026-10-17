import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Digital Cards — written from src/app/(dashboard)/cards (My card, Digital cards, Card events, an event
 * and its capture page), src/components/cards (the people table, templates editor, my-card editor, share
 * panel, event editor, booth links, capture form, public card), src/actions/card.ts (issuing, switching
 * off, addresses, templates, events, capture, export — all but the holder's own choices need cards.manage),
 * src/lib/cards (holder.ts for when a card is live, capture.ts for share-backs becoming leads, events.ts
 * for the week after an event) and src/lib/modules.ts (My card and Card events shown only to some people).
 */
export const guide: SeedGuide = {
  slug: "help/digital-cards",
  title: "Digital Cards",
  seo: {
    title: "Digital Cards: business cards with a QR code and a link",
    description: "How to issue digital business cards, design the company's card templates, share your card by QR or link, and count the people met at an event.",
    keywords: ["digital business card", "QR business card", "event lead capture"],
  },
  guide: {
    module: "cards",
    heading: "Digital Cards",
    summary: "Digital business cards for the people the company chooses: their details from their record, the design from a company template, a QR code and a link that save the contact in one tap — and whoever opens one can share their details back.",
    purpose: [
      p("A digital card is a page with somebody's name, photo, job title, department, company, work phone, work email and office address, laid out by the company's card template. Its QR code and its link open it on any phone, and Save contact puts the person straight into the phone's contacts. The details come from the holder's record, so a new title or number is on the card as soon as the record changes."),
      p("Whoever opens a card can share their own details back, if the template asks them to. They land in the holder's Contacts and — where your workspace has Leads — become a lead in the holder's name."),
      p("For trade shows and conferences there are card events: the team that works the stand, a booth form people fill in, scanning the cards of people you meet, and how many you met against the goal and what each one cost."),
      note("Nobody has a card until somebody issues one. Having a card isn't a permission — HR or an admin issues them to the people the company chooses."),
    ],
    access: [
      p("What you see depends on what is true of you:"),
      ul(
        runs({ b: "A cardholder" }, " — somebody with a live card — sees ", { b: "My card" }, " in the menu: their card, its link and QR code, how it's doing this week, the record fields they may leave off, their own links, and everybody who shared details back from it."),
        runs("People allowed to manage digital cards see ", { b: "Digital cards" }, ": everybody's cards, the templates, and every contact shared back. They make and run card events too."),
        runs("The team of a card event sees ", { b: "Card events" }, " until a week after it ends: the event's numbers, and the people they met themselves."),
      ),
      p("A card is live while it is switched on and its holder's account is active. Once a recorded last working day has passed, the card goes dark by itself. A card that isn't live still answers at its address, but shows the company's details instead of the person's — so a saved contact or a printed QR code keeps pointing at the company."),
    ],
    permissions: [
      perm("section.cards", "Shows Digital Cards in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm(
        "cards.manage",
        "Lets somebody issue cards and switch them off, change a card's address, design the card templates, make and run card events and export the people met, and see every card's numbers and everybody who shared details back. Management, HR and HR head have it by default, as do admins.",
      ),
    ],
    setup: [
      p(runs("Somebody allowed to manage cards opens ", { b: "My work › Digital cards" }, ". The first time a card is issued, a default template is made from your branding — your colour and logo — or you can make one first under ", { b: "Templates" }, ".")),
      p(runs("A card's details come from each person's record and branch, so keep job titles, departments and work numbers up to date. The logo is the one in ", { b: "Settings › Branding" }, ".")),
      p("Then issue cards to the people who should have one — see below. Each new cardholder then finds My card in their menu."),
    ],
    tasks: [
      task(
        "Issue cards",
        ol(
          runs("Open ", { b: "My work › Digital cards" }, ", on the ", { b: "People" }, " tab."),
          runs("Under ", { b: "Template" }, ", leave ", { b: "The default, or theirs" }, ", or choose a template."),
          runs("Under ", { b: "Issue to" }, ", choose ", { b: "A department" }, ", ", { b: "A branch" }, ", ", { b: "A role" }, " or ", { b: "Everybody active" }, ", then which one."),
          runs("Select ", { b: "Issue cards" }, "."),
        ),
        p(runs("To issue to particular people, tick them in the table and select ", { b: "Issue or move" }, ". Somebody who already has a card keeps it as it is, unless you chose a template — then theirs moves onto it. A card that was switched off is switched back on, with its old address.")),
      ),
      task(
        "Switch a card off",
        ol(runs("On the ", { b: "People" }, " tab, tick the people."), runs("Select ", { b: "Switch off" }, ".")),
        p("Their card's address then shows the company's details instead. Issuing the card again switches it back on."),
      ),
      task(
        "Design a card template",
        ol(
          runs("Open the ", { b: "Templates" }, " tab and select ", { b: "New template" }, ", or ", { b: "Edit" }, " beside one."),
          runs("Set its ", { b: "Name" }, ", ", { b: "Colour" }, " and ", { b: "Layout" }, " — ", { b: "Classic — photo at the side" }, " or ", { b: "Centred — photo above the name" }, " — and whether to ", { b: "Show the company logo" }, "."),
          runs("Under ", { b: "From each person's record" }, ", choose which fields to ", { b: "Show" }, " and in what order. ", { b: "Locked" }, " ones can't be left off by the person."),
          runs("Under ", { b: "On every card" }, ", add what is the same for everybody, such as the website or the head-office number."),
          runs("Tick ", { b: "People may add their own links and numbers" }, " to let holders add LinkedIn, WhatsApp, a booking link and the like."),
          runs("Tick ", { b: "Ask whoever opens the card to share their details back" }, " for the share-back form. Name, email or phone, company and job title are always asked; add questions of your own and mark any as ", { b: "Required" }, "."),
          runs("Select ", { b: "Save" }, "."),
        ),
        p(runs("Every card drawn from the template changes the moment you save, and the button says how many. Their holders are told what changed. ", { b: "Make default" }, " sets the template new cards get; a template can only be deleted while no card uses it and it isn't the default.")),
      ),
      task(
        "Share your card",
        ol(
          runs("Open ", { b: "My work › My card" }, "."),
          runs("Select ", { b: "Copy link" }, " to send it, ", { b: "Download QR" }, " to print or show the code, or ", { b: "Open card" }, " to see it as others do."),
        ),
        p("On your phone, open your card's page and add it to your home screen, so the QR code is one tap away. You can also write the link to an NFC card or sticker with any NFC app, so a tap opens your card."),
      ),
      task(
        "Choose what your card shows",
        ol(
          runs("On ", { b: "My work › My card" }, ", under ", { b: "From your record" }, ", untick any field you'd rather leave off. Fields the template has locked stay on."),
          runs("Under ", { b: "Your own links and numbers" }, ", add what you'd hand somebody — if your company's template allows it."),
          runs("Select ", { b: "Save" }, ". Your card shows it at once."),
        ),
        p("Your name, title, phone and photo come from your record. To change them, change the record."),
      ),
      task(
        "See who shared their details back",
        p(runs("Open the ", { b: "Contacts" }, " tab on ", { b: "My card" }, " — or on ", { b: "Digital cards" }, " for everybody's. Each person shows what they wrote and, when one was made, a link to their lead. Select ", { b: "Add a note" }, " to keep your own note on them. You are also notified when somebody shares their details from your card.")),
      ),
      task(
        "Set up a card event",
        ol(
          runs("Open ", { b: "My work › Card events" }, " and select ", { b: "New event" }, "."),
          runs("Fill in its ", { b: "Name" }, ", ", { b: "Venue" }, ", ", { b: "First day" }, " and ", { b: "Last day" }, ", and, if you like, ", { b: "Goal — people to meet" }, " and ", { b: "What it cost" }, "."),
          runs("Under ", { b: "The team" }, ", pick the people working the stand. Anybody active can be on it, but only people with a live card get a booth form."),
          runs("Add any ", { b: "Booth form questions" }, ", then select ", { b: "Create event" }, "."),
        ),
        p(runs("While the event runs, each holder's booth form link and QR code are on the event's page. The ", { b: "Results" }, " tab shows the people met against the goal, the leads made, the cost per person, and the numbers by person and by day. For people who manage cards, ", { b: "Export CSV" }, " downloads everybody met.")),
      ),
      task(
        "Add somebody you met at an event",
        ol(
          runs("Open the event and select ", { b: "Add someone you met" }, "."),
          runs("Select ", { b: "Scan their card's QR" }, ", or paste a card's link or contact text and select ", { b: "Read" }, " — or type their details in."),
          runs("Check the details, add ", { b: "Your note" }, ", and select ", { b: "Save" }, "."),
        ),
        p("They need an email address or a phone number. People can be added from the first day of the event until a week after the last. The same person twice at one event is refused."),
      ),
    ],
    settings: [
      setting("Template", "My work › Digital cards › Templates", p("Each template's colour, layout, logo, which record fields show and which are locked, the fields on every card, whether holders may add their own, and whether the card asks for details back. A change reaches every card on the template at once.")),
      setting(
        "Card address",
        "My work › Digital cards › People",
        p("Each card's link ends in an address made from the holder's name. A manager can change it: 3 to 40 lower-case letters and digits, with single hyphens between. The old address stops working — and printed QR codes and NFC tags with it."),
      ),
      setting("Event settings", "The event's Settings tab", p("An event's name, venue, days, goal, cost, team and booth form questions, for people who manage cards. An event can be deleted only while nobody has been met at it.")),
    ],
    faq: [
      qa(
        "I don't see My card in the menu.",
        p("My card shows only to somebody with a live card. HR or an admin issues them. If cards are issued but nobody sees any of it, the module may be switched off (Settings › Modules) or the section hidden for your role (Settings › Roles & Permissions)."),
      ),
      qa("I don't see Digital cards or Card events.", p("Digital cards needs the permission to manage digital cards. Card events shows to those people, and to the team of an event until a week after it ends.")),
      qa("My card says it's switched off.", p("Somebody who manages cards switched it off, or a last working day recorded for you has passed. Until it's live again, your link shows the company's details instead of yours.")),
      qa(
        "Somebody shared their details, but no lead was made.",
        p("Their details are always kept in Contacts. A lead is made only where your workspace has Leads; the contact then says No lead. A share-back that couldn't become a lead still notifies you."),
      ),
      qa("Can I change my job title on my card?", p("Not on the card. It comes from your record — change it there, or ask whoever keeps the records, and your card follows.")),
      qa("I can't add people at an event.", p("Either the event hasn't started yet, or it ended more than a week ago. And if the same email or phone number is already in for that event, it says who has them.")),
      qa("It says this browser can't read QR codes.", p("Scan the code with your phone's camera instead, copy the link it finds, and paste it into the box on the page — or type the details in.")),
    ],
    related: ["leads", "hr", "signatures"],
  },
};
