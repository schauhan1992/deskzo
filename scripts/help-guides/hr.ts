import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * People (HR) — written from src/app/(dashboard)/people (My HR, People, a person's record and its
 * handover, Hiring and a candidate, Leave and opening balances, Holidays, Attendance, Celebrations,
 * Biometric, letters), src/components/hr and src/components/people, src/actions/hr.ts, leave.ts,
 * leave-openings.ts, attendance.ts, regularisation.ts, candidate.ts, employee-docs.ts, celebration.ts,
 * biometric.ts and handover.ts, src/lib/hr (calendar, onboarding, letters), and the HR, HR head and
 * Recruiter roles (src/lib/authz/presets.ts and their migrations).
 */
export const guide: SeedGuide = {
  slug: "help/people-hr",
  title: "People (HR)",
  seo: {
    title: "People (HR): employee records, leave, attendance and hiring",
    description: "How to keep employee records, hire and onboard people, apply for and approve leave, track attendance and biometric punches, and set holidays in {siteName}.",
    keywords: ["HR software", "leave management", "attendance tracking"],
  },
  guide: {
    module: "hr",
    heading: "People (HR)",
    summary: "Employee records, hiring and joining, the holiday calendar, leave with balances and approvals, and daily attendance — clocked in on screen or sent by a biometric terminal. Everyone has My HR for their own leave and attendance; HR runs the rest.",
    purpose: [
      p("People (HR) is where the company keeps who works here and on what terms. Everyone with a login has an employee record: their employment details, personal and emergency contacts, statutory and bank details, documents, previous employment and the letters the company has issued them."),
      p(runs("It is also where the day-to-day happens. People apply for leave, clock in and out, and ask for a day's attendance to be corrected. Their manager decides, and the balances and the attendance grid update themselves. ", { b: "My HR" }, " puts your own attendance, leave, corrections and payslips on one page.")),
      p("Hiring sits here too. A candidate has no login while they are being hired: you send them a link to fill in their own details, draft their offer letter, and convert them on their joining day. Converting creates their login and their employee record, and raises the onboarding tasks."),
      note(runs("Pay isn't in this module. Salary structures, the monthly run and payslips are in Payroll, behind a permission of their own — see ", ["Payroll", "/help/payroll"], ".")),
    ],
    access: [
      p("Everybody in the workspace can use My HR, Leave and Attendance for themselves. What else you see depends on who you are:"),
      ul(
        runs({ b: "Everyone" }, " sees the People directory — each colleague's name, designation, team and who they report to — and their own full record. You can edit your own personal, address, emergency, statutory and bank details. Your employment terms (code, designation, joining and probation dates) are HR's to set."),
        runs({ b: "Managers" }, " — anyone with people reporting to them, directly or through someone else — open those people's records, see their leave and attendance, and decide their leave requests and attendance corrections. Who reports to whom is the ", { b: "Reporting manager" }, " in ", { b: "Settings › Users" }, "."),
        runs({ b: "HR" }, " — people allowed to manage people records — see and edit everyone's record, record exits, keep the holiday calendar and leave types, issue letters, post celebrations and look after biometric terminals."),
      ),
      p("Nobody can approve their own leave or their own attendance correction. A record you aren't allowed to open shows as a page that doesn't exist. Admins hold every permission."),
    ],
    permissions: [
      perm("section.hr", "Shows People (HR) in the menu — My HR, People, Leave and Attendance — and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm(
        "hr.manage",
        "The HR administrator's permission: edit anyone's record, record exits, keep the holiday calendar, leave types, opening balances and office hours, issue letters, convert hired candidates, and see everyone's attendance and leave. Shows Letters, Celebrations and Biometric in the menu. It doesn't show anyone's pay. Management has it by default; the built-in HR and HR head roles start with it.",
      ),
      perm(
        "files.view",
        "Shows File manager in the menu: your own salary slips, salary certificates, offer and joining letters (the letter of intent too), other letters and documents, in folders — the ones an admin has switched on. Nobody has it by role; only an admin or the super admin can give it.",
      ),
      perm(
        "hiring.manage",
        "Shows Hiring in the menu. Add candidates, record offers sent, accepted or declined, send intake links, draft offer letters and file candidates' documents, without opening employee records. Converting a candidate into an employee needs Manage people records. Management has it by default; the built-in HR, HR head and Recruiter roles start with it.",
      ),
      perm(
        "hr.viewAll",
        "See everyone's attendance and leave rather than only your own and your team's, and open everyone's employee record to read it. Management has it by default; the built-in HR and HR head roles start with it.",
      ),
      perm(
        "hr.approveLeave",
        "Decide anyone's leave request or attendance correction, not only those of people who report to you — for whoever covers while a manager is away. Never your own. Management has it by default; the built-in HR and HR head roles start with it.",
      ),
      perm(
        "people.handover",
        "Shows Hand over work on a person's record, to move their accounts, leads, tickets, open quotes, equipment and reports to colleagues. It never changes their own attendance, leave or pay records. Management has it by default; the built-in HR and HR head roles start with it.",
      ),
      perm("data.importPeople", "Bring employee records and candidates in from a file, in Settings › Import & export. No role has it by default; the built-in HR head role starts with it."),
      perm("data.exportPeople", "Export employee records, attendance, leave, documents and candidates from Settings › Import & export. No role has it by default; the built-in HR and HR head roles start with it."),
    ],
    setup: [
      p("Someone allowed to manage people records does this once, with an admin for the first step:"),
      ol(
        runs("Make sure everyone has a login with a ", { b: "Department" }, " and a ", { b: "Reporting manager" }, " — an admin sets both in ", { b: "Settings › Users" }, ". The reporting manager is who decides that person's leave."),
        runs("Add the year's holidays and your leave types in ", { b: "Settings › Holidays & leave" }, ". Until there is at least one leave type, nobody can apply for leave."),
        runs("Fill in each person's employee record: open ", { b: "People › People" }, ", open the person and select ", { b: "Edit record" }, ". The ", { b: "No HR record" }, " count at the top shows logins that don't have one yet."),
        runs("If you are moving from another system partway through the year, enter what people carried in and had already taken on ", { b: "People › Leave" }, " › ", { b: "Opening balances →" }, "."),
        runs("If you want late, left early and overtime marked, set the office hours on ", { b: "People › Attendance" }, ". If you have biometric terminals, register them in ", { b: "Settings › Biometric terminals" }, "."),
      ),
      p(runs("To bring many employee records in at once, use ", { b: "Settings › Import & export" }, ". To give somebody HR's permissions, an admin gives them the built-in HR role, or ticks the permissions for their role in ", { b: "Settings › Roles & Permissions" }, ".")),
    ],
    tasks: [
      task(
        "Apply for leave",
        ol(
          runs("Open ", { b: "People › Leave" }, " and select ", { b: "Apply for leave" }, "."),
          runs("Choose the ", { b: "Type" }, ". The form shows how many days you have left."),
          runs("Pick the ", { b: "From" }, " and ", { b: "To" }, " dates. Tick ", { b: "Second half only" }, " or ", { b: "First half only" }, " for a half day at either end."),
          "Check the number of days the form says will come off your balance. Weekends and company holidays inside the dates cost nothing.",
          runs("Write a ", { b: "Reason" }, " and select ", { b: "Submit" }, "."),
        ),
        p("Your manager is notified. Days already waiting for approval count against your balance, so you can't book the same days twice. An unpaid leave type has no balance — those days come off your salary instead."),
        p(runs("To take a request back, select ", { b: "Withdraw" }, " on it under ", { b: "Your requests" }, ". You can do this until the leave starts, whether it is pending or approved.")),
      ),
      task(
        "Ask for a short leave",
        ol(
          runs("Open ", { b: "People › Leave" }, " and select ", { b: "Short leave" }, " — the button beside ", { b: "Apply for leave" }, ", or the tab of the same name."),
          runs("Select ", { b: "Ask for a short leave" }, ", pick the ", { b: "Day" }, ", the ", { b: "From" }, " and ", { b: "To" }, " times inside office hours, and write a ", { b: "Reason" }, "."),
          "Send it. Your manager is notified, and decides it as they do leave.",
        ),
        p("A short leave is a couple of hours off on one working day — coming in late, leaving early, or stepping out in between. It uses no leave balance, up to the number a month and the length your company allows; the tab says how many you've used. An approved one clears the Late or Left early mark it covers on the attendance grid. People › My HR shows this month's count too."),
        p(runs("Managers decide them under ", { b: "Waiting on you" }, " on the same tab, and HR sees everybody's there, filterable by status, team, person and date. HR sets the length and how many a month under ", { b: "Rules" }, ".")),
      ),
      task(
        "Approve leave and attendance corrections",
        ol(
          runs("Leave requests waiting for you are under ", { b: "Waiting on you" }, " on ", { b: "People › Leave" }, ". Corrections are under ", { b: "Attendance corrections waiting on you" }, " on ", { b: "People › My HR" }, "."),
          "Add a note if you want to — the person sees it.",
          runs("Select ", { b: "Approve" }, " or ", { b: "Reject" }, "."),
        ),
        p("Approving leave takes the days off the balance and marks them On leave (or Half day) on the attendance grid. The person is notified either way."),
      ),
      task(
        "Clock in and out, and ask for a correction",
        ol(
          runs("On ", { b: "People › My HR" }, " or ", { b: "People › Attendance" }, ", select ", { b: "Clock in" }, " when you start and ", { b: "Clock out" }, " when you finish."),
          runs("If a day is wrong — you forgot to punch out, or the terminal missed you — open ", { b: "People › My HR" }, " and, under ", { b: "Attendance corrections" }, ", select ", { b: "Ask for a correction" }, "."),
          runs("Fill in ", { b: "Which day" }, ", ", { b: "Should have been" }, ", the times if you know them, and ", { b: "What happened" }, "."),
          runs("Select ", { b: "Send request" }, "."),
        ),
        p("Nothing changes until your manager approves it. Leave isn't corrected here: withdraw the leave request instead."),
      ),
      task(
        "Keep an employee record up to date",
        ol(
          runs("Open ", { b: "People › People" }, ", search by name, email, code or designation, and open the person."),
          runs("Select ", { b: "Edit record" }, ", change what you need and select ", { b: "Save record" }, "."),
          runs("To file a document, select ", { b: "Upload" }, " on the ", { b: "Documents" }, " card, choose the file, name it and select ", { b: "Add to file" }, ". HR can untick ", { b: "The employee can see this" }, " for something filed about the person rather than for them."),
          runs("To issue a letter, pick it under ", { b: "Letters" }, " — a built-in one, or one of yours under ", { b: "Our templates" }, " — and select ", { b: "Draft" }, ". Edit the wording, tick or untick ", { b: "Add digital signature" }, ", select ", { b: "Save changes" }, ", then ", { b: "Issue" }, " and ", { b: "Print" }, "."),
        ),
        p(runs("An issued letter's wording is fixed because its number has been given out. To change it, select ", { b: "Revoke" }, " — it stays on record as withdrawn — and draft another. A letter is dated the day it's issued, and keeps the signature it was issued with.")),
      ),
      task(
        "Give somebody the file manager, and choose what they see",
        ol(
          runs("As an admin or the super admin, open ", { b: "People › File manager" }, " and choose ", { b: "Employees" }, "."),
          runs("Switch the file manager on beside each person who should have it, or select ", { b: "Give everyone" }, "."),
          runs("Choose a name to see their files in folders: ", { b: "Salary slips" }, ", ", { b: "Salary certificates" }, ", ", { b: "Offer & joining letters" }, ", ", { b: "Other letters" }, " and ", { b: "Documents" }, "."),
          runs("Open a folder and switch each file on or off, or select ", { b: "Show all" }, " or ", { b: "Hide all" }, " for the folder."),
        ),
        p("A file switched off is kept from the person everywhere — My HR, Payroll and their Letters card too — until it's switched back on. HR and payroll still see it. Each person sees only their own files, and a draft or withdrawn letter never."),
      ),
      task(
        "Make a letter template of your own",
        ol(
          runs("Open ", { b: "People › Letters" }, " and choose ", { b: "Our templates" }, ". Select ", { b: "New template" }, "."),
          runs("Give it a ", { b: "Name" }, " and a ", { b: "Code" }, " of 2 to 5 letters — the code goes in the letter number, like WRF/BON/2026/001."),
          runs("Write the ", { b: "Subject" }, " and the ", { b: "Letter" }, ". Click a field on the right to put it in — ", { b: "{{employee.name}}" }, ", the CTC, the joining date — and it's filled in from the person's record when a letter is drafted."),
          runs("Select ", { b: "Save template" }, ". It's offered under ", { b: "Our templates" }, " on everybody's Letters card."),
        ),
        p("A field with nothing on someone's record leaves a blank line on the draft to fill in. A template with letters drafted from it is switched off rather than deleted; the letters keep their own text."),
      ),
      task(
        "Sign letters digitally",
        ol(
          runs("Open ", { b: "People › Letters" }, " and choose ", { b: "Signature" }, "."),
          runs("Select ", { b: "Upload an image" }, " for a scan of the signatory's signature, or ", { b: "Sign here" }, " to sign with a mouse or a finger and select ", { b: "Save signature" }, "."),
          runs("Leave ", { b: "Sign new letters" }, " ticked for letters to start out signed. Each draft still has its own ", { b: "Add digital signature" }, " switch."),
        ),
        p("The signature is printed above the signatory's name. With none of its own, signed letters carry the stamp from Settings › Organisation. It's a picture of the signature, not an Aadhaar eSign or a DSC."),
      ),
      task(
        "Hire someone and convert them on joining",
        ol(
          runs("Open ", { b: "People › Hiring" }, " and select ", { b: "Add candidate" }, ". Fill in their name and email, and the offer: team, reporting manager, ", { b: "Access role on joining" }, ", ", { b: "Offered CTC (annual)" }, " and ", { b: "Expected joining" }, ". Select ", { b: "Add" }, "."),
          runs("Open the candidate and select ", { b: "Issue intake link" }, ". Copy the link and send it to them — they fill in their own address, PAN and bank details. The link lasts 14 days."),
          runs("Draft their offer letter from the ", { b: "Letters" }, " card (the offered CTC must be set first), and select ", { b: "Mark offer sent" }, "."),
          runs("When they say yes, select ", { b: "Offer accepted" }, ". If they turn it down, select ", { b: "They declined" }, " and record why."),
          runs("On their joining day, select ", { b: "Convert to employee" }, ", check the ", { b: "Joining date" }, ", ", { b: "Employee code" }, " and ", { b: "Probation (months)" }, ", and select ", { b: "Create their record" }, "."),
        ),
        p(runs("Converting creates their login and emails them a link to choose a password, moves their details, documents and letters onto the new record, and raises onboarding tasks for IT, HR and their manager (see ", ["Tasks", "/help/tasks"], "). Set their salary straight afterwards.")),
      ),
      task(
        "Record an exit and hand over work",
        ol(
          runs("Open the person's record and select ", { b: "Record exit" }, "."),
          runs("Fill in the ", { b: "Last working day" }, ", ", { b: "How" }, " they left and any ", { b: "Notes" }, "."),
          runs("Leave ", { b: "Deactivate their login now" }, " ticked unless they are serving notice and still need access, and select ", { b: "Record exit" }, "."),
          runs("Select ", { b: "Hand over work" }, ". Choose who takes over each area, or use ", { b: "Send everything to" }, " to fill every row with one person and then change any of them."),
          runs("Add ", { b: "Why (optional)" }, " and select the ", { b: "Hand over" }, " button."),
        ),
        p(runs("Recording the exit raises the offboarding tasks — revoking access, collecting the laptop, the settlement, the relieving letters — and the record's ", { b: "Offboarding" }, " card shows what is still outstanding. Everyone who receives work in a handover is notified.")),
      ),
      task(
        "Check and correct the attendance grid",
        ol(
          runs("Open ", { b: "People › Attendance" }, ". Pick the month, or step with the arrows."),
          runs("Use ", { b: "Show" }, " to narrow it to ", { b: "Had an absence" }, ", ", { b: "Days not recorded" }, " or ", { b: "Took leave" }, ", and ", { b: "Team" }, " or ", { b: "Person" }, " to narrow who."),
          runs("To correct a day, select it, choose the ", { b: "Status" }, ", add a ", { b: "Note" }, " saying why, and select ", { b: "Save" }, "."),
        ),
        p("A dashed square is a working day nobody has recorded — not an absence. Corrections are stamped with your name. A day covered by approved leave can't be changed here."),
      ),
      task(
        "Post a celebration",
        ol(
          runs("Open ", { b: "People › Celebrations" }, " and select ", { b: "Post something" }, "."),
          runs("Choose ", { b: "What kind" }, " and ", { b: "Who sees it" }, ": ", { b: "Everyone" }, ", ", { b: "One team" }, " or ", { b: "One person" }, "."),
          runs("Write a ", { b: "Title" }, " and ", { b: "Message" }, ", pick ", { b: "Who it's about" }, " if it is about someone, and set ", { b: "Shows from" }, " and ", { b: "Until" }, "."),
          runs("Pick a colour or add an image if you like, and select ", { b: "Post it" }, "."),
        ),
        p("Birthdays, work anniversaries and holidays appear on their own from the employee records and the holiday calendar — there is nothing to enter for them."),
      ),
    ],
    settings: [
      setting(
        "Holidays & leave",
        "Settings › Holidays & leave",
        p(runs("Opens ", { b: "Holidays & leave types" }, " for the year you pick. Type a holiday's name and date and select ", { b: "Add" }, "; select the bin to remove one. Tick ", { b: "Restricted (optional) holiday" }, " for a day the office stays open — taking it costs a day of leave. A holiday inside a leave request costs nothing.")),
        p("Everyone else sees the same page as a read-only holiday calendar, with the leave they can take."),
      ),
      setting(
        "Leave types",
        "Settings › Holidays & leave",
        p(runs("Each type has a ", { b: "Code" }, " and ", { b: "Name" }, ", ", { b: "Days a year" }, ", and when it is ", { b: "Credited" }, ": ", { b: "All at once, in April" }, " or ", { b: "A twelfth each month" }, ". Untick ", { b: "Paid" }, " for unpaid leave, and tick ", { b: "Carries into next year" }, " with a maximum to carry unused days over. Balances run on the April to March year.")),
        p(runs("Check the figures before you select ", { b: "Add leave type" }, ": this screen lists leave types but has no way to edit one.")),
      ),
      setting(
        "Biometric terminals",
        "Settings › Biometric terminals (also People › Biometric)",
        p(runs("For eSSL and other ZKTeco-based terminals. The page shows the server address and port to enter on the terminal, under Menu → Comm → Cloud Server / ADMS. Select", { b: "Register terminal" }, " and enter its ", { b: "Serial number" }, " and a ", { b: "Name" }, " — a terminal that isn't registered has its uploads refused.")),
        p(runs("Under ", { b: "Unmapped enrolment numbers" }, ", choose who each number belongs to and select ", { b: "Map" }, "; punches already collected for that number are recovered. The first punch of a day becomes the check-in and the last the check-out. ", { b: "Import a file" }, " takes a terminal's exported file for a site it can't reach the server from, and ", { b: "Reprocess" }, " rebuilds the days from the punches.")),
        note("These terminals' protocol carries no authentication. Keep the server reachable only from the office network or over a VPN.", "warning"),
      ),
      setting(
        "Office hours",
        "People › Attendance",
        p(runs("Select ", { b: "Set office hours" }, " (or ", { b: "Change" }, "), enter when the day ", { b: "Starts" }, " and ", { b: "Ends" }, " and the ", { b: "Grace (minutes)" }, ", and select ", { b: "Save" }, ". The grid then marks late, left early and overtime, and totals hours worked against hours expected. ", { b: "Clear office hours" }, " turns this off.")),
      ),
      setting(
        "Opening balances",
        "People › Leave › Opening balances",
        p(runs("For each person and leave type, type what they ", { b: "Carried in" }, " from your old system and what they had ", { b: "Taken before" }, " using {siteName}. A carried figure left empty is worked out from last year as usual. ", { b: "Paste from your old system" }, " fills the sheet from lines of email, leave code, carried in, taken. Note ", { b: "Where these came from" }, " and save.")),
      ),
      setting(
        "Department, Reporting manager and Works at",
        "Settings › Users",
        p("Set on each person's login by an admin. The reporting manager decides that person's leave and corrections and sees their records. The department is the team used in filters, celebrations and forms."),
      ),
    ],
    faq: [
      qa(
        "I can't see People (HR), or one of its pages, in the menu.",
        p("Either the module is switched off for your company in Settings › Modules, or your role has had the section hidden in Settings › Roles & Permissions. Hiring also needs Run hiring, and Letters, Celebrations and Biometric need Manage people records. Ask an admin."),
      ),
      qa(
        "Why does the leave form say I don't have enough days?",
        p("Days in requests still waiting for approval are counted against your balance, so they can't be booked twice. Weekends and company holidays inside the dates don't count. If you need more, ask HR about your balance."),
      ),
      qa(
        "Who approves my leave?",
        p("Your reporting manager, anyone above them in the reporting line, or someone allowed to approve leave for anyone. If you have no reporting manager set, nobody is notified when you apply — ask an admin to set one in Settings › Users."),
      ),
      qa(
        "Can I cancel leave I've already been given?",
        p("Yes, until it starts: select Withdraw on the request. Approved days go back on your balance and come off the attendance grid. Once the first day has arrived, Withdraw is no longer offered."),
      ),
      qa(
        "My attendance shows a dashed square. Was I marked absent?",
        p("No. A dashed square is a working day nobody recorded, which is not the same as absent. Ask for a correction from My HR if it should say something else."),
      ),
      qa(
        "Why won't it let me clock in?",
        p("Either you've already clocked in today, or you're on approved leave today. If you are working after all, withdraw the leave first."),
      ),
      qa(
        "Punches from our biometric terminal aren't showing.",
        p("Check the terminal is registered and enabled on the Biometric page, and that the person's enrolment number is mapped — unmapped punches are kept and recovered when you map the number. Days with leave or a manual correction are never overwritten by punches."),
      ),
      qa(
        "Who can see my personal and bank details?",
        p("You, the people above you in the reporting line, and HR. Other colleagues see only what the directory shows — your name, designation, team, employment type and who you report to — and can't open your record."),
      ),
    ],
    related: ["payroll", "tasks", "visitors", "engagement"],
  },
};
