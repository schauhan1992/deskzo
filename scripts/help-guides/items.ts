import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Items & Inventory — written from src/app/(dashboard)/items (the list, an item's page, the new and edit
 * forms, Brands & families, Categories), src/components/items (the item fields, the bulk bar, the stock
 * form, the import dialog), src/actions/item.ts (what adding, editing, stock movements, bulk changes,
 * import and export allow), src/actions/brand.ts and src/actions/item-category.ts (who may change the
 * catalogue's lists) and src/lib/hsn.ts (India's HSN/SAC rule).
 */
export const guide: SeedGuide = {
  slug: "help/items-and-inventory",
  title: "Items & Inventory",
  seo: {
    title: "Items & Inventory: your catalogue, prices and stock",
    description: "How to keep your catalogue in {siteName}: goods, services and subscriptions, brands and categories, HSN/SAC codes in India, and stock movements.",
    keywords: ["item catalogue", "inventory tracking", "brands and product families"],
  },
  guide: {
    module: "items",
    heading: "Items & Inventory",
    summary: "Your catalogue of goods, services and subscriptions — each with its SKU, price, GST rate, brand and category — and a running stock count for the goods you choose to track.",
    purpose: [
      p("Items & Inventory is the list of everything you sell or buy. Each item has a name and SKU, a selling price, an optional cost price, a GST rate, a unit, a brand and product family, and a category. When somebody picks a product on an order, a proposal, an invoice or a purchase order, its price and tax come from here."),
      p(runs("An item is either goods or a service. A service can also be ", { b: "managed as a subscription" }, ": it then renews, and every order for it comes up in Renewals before its term ends. This choice is only offered where Renewals is available.")),
      p("For goods, you can keep a stock count. Each movement in or out is recorded on the item's page, and the item shows its stock on hand and a Low stock warning when it falls to its reorder level."),
      p(runs("Stock is kept per ", { b: "warehouse" }, ", and, for items that need it, per ", { b: "batch" }, " (with its expiry date) and per ", { b: "serial number" }, ". Every movement carries its cost, by weighted average or first in, first out, so the stock reports can value what is on hand on any date.")),
      note("Stock moves when somebody records a movement on the item, enters opening stock, or posts a stock voucher — a goods receipt, a transfer, an adjustment, a physical count or a return to a vendor. Issuing tax invoices, vendor bills and credit notes moves it too, once Accounts settings turn that on; until then they don't. Importing items never touches stock."),
      p("In India, every item needs its HSN code (for goods) or SAC code (for services). The code is checked against the GST portal's directory and copied onto every document line. Outside India the code is optional."),
    ],
    access: [
      p("Everybody who can open Items & Inventory can add items, edit them, change many items at once, and import or export the list as a CSV file."),
      p("Stock has permissions of its own, asked again by every page and action behind the menu: seeing stock, receiving it, transferring it, adjusting it, approving adjustments, and setting up warehouses, units and how items are tracked. An adjustment or a count that needs approval is approved by somebody other than the person who wrote it."),
      p("Brands, product families and categories are shared lists that many items point at, so changing them is kept apart. Everybody can read them, but only people allowed to manage brands, families & industries can add, rename or delete one."),
      p("Only active items are offered when somebody picks a product on an order or a document. An inactive item stays on the list and on every record that already uses it."),
    ],
    permissions: [
      perm("section.items", "Shows Items & Inventory and Brands & families in the Accounts menu, and lets people open their pages. Every role has it until an admin unticks it for one."),
      perm("catalog.manage", "Lets someone add, rename and delete brands, product families and item categories. With it, an item import also adds any brand, family or category the file names that isn't on the list yet. No role has it by default — admins do."),
      perm("data.exportCatalog", "Lets someone export the catalogue — items with their brands and product families — from Settings › Import & export. No role has it by default."),
      perm("data.importCatalog", "Lets someone load items from a spreadsheet in Settings › Import & export. No role has it by default."),
      perm("inventory.view", "Shows Stock vouchers, Stock reports, Warehouses and Units of measure, and what each item holds in each warehouse. Accounts, Management, Purchase and Sales have it by default."),
      perm("inventory.receive", "Lets someone receive goods — goods receipts against purchase orders, and stock movements that bring stock in. Purchase, Accounts and Management have it by default."),
      perm("inventory.transfer", "Lets someone send stock from one warehouse to another, and receive it at the other end. Purchase, Accounts and Management have it by default."),
      perm("inventory.adjust", "Lets someone write stock up or down, count it, return it to a vendor, and cancel a stock voucher that has posted. Accounts and Management have it by default."),
      perm("inventory.approveAdjustments", "Lets someone approve somebody else's adjustment or count, which posts it. Never their own. Management has it by default."),
      perm("inventory.manage", "Lets someone set up warehouses and units, and choose whether an item keeps batches, expiry dates and serial numbers. Accounts and Management have it by default."),
      perm("accounts.configure", "Opens Accounts settings: periodic or perpetual inventory, the costing method, negative stock, what moves stock on its own, approvals and voucher numbering. No role has it by default — an admin gives it."),
    ],
    setup: [
      p("Before adding items, somebody who manages the catalogue sets up the lists they pick from:"),
      ul(
        runs({ b: "Brands & families" }, " — who makes the products you sell, and the lines within each brand (Microsoft › Microsoft 365)."),
        runs({ b: "Categories" }, " — what kind of goods or service each item is (Laptops, Software licences, AMC). Reports group by it."),
      ),
      p(runs("Then add items one at a time with ", { b: "New item" }, ", or many at once with ", { b: "Import CSV" }, ".")),
      p(runs("To let more people manage brands and categories, an admin ticks ", { b: "Manage brands, families & industries" }, " for their role in ", { b: "Settings › Roles & Permissions" }, ".")),
    ],
    tasks: [
      task(
        "Add an item",
        ol(
          runs("Open ", { b: "Accounts › Items & Inventory" }, " and select ", { b: "New item" }, "."),
          runs("Enter the ", { b: "Item name" }, " and ", { b: "SKU" }, ". The SKU has to be unique."),
          runs("Under ", { b: "Goods or service" }, ", choose ", { b: "Goods" }, " or ", { b: "Service" }, ". For a service that renews, tick ", { b: "Manage as a subscription" }, "."),
          runs("Pick a ", { b: "Brand" }, ", then one of its ", { b: "Product family" }, " entries, and a ", { b: "Category" }, "."),
          runs("Enter the ", { b: "HSN / SAC code" }, " (required in India), the ", { b: "Selling price" }, " and, if you know them, the ", { b: "Cost price" }, ", ", { b: "GST rate (%)" }, " and ", { b: "Unit" }, "."),
          runs("For goods, keep ", { b: "Track inventory for this item" }, " ticked to count stock, and enter a ", { b: "Reorder level" }, " and ", { b: "Opening stock" }, " if you like."),
          runs("Select ", { b: "Save item" }, "."),
        ),
        p(runs("Fields your company has added for products appear under ", { b: "More details" }, ". Opening stock is recorded as the item's first movement.")),
      ),
      task(
        "Record a stock movement",
        ol(
          "Open the item. Stock movements show only on goods that track inventory.",
          runs("Under ", { b: "Stock movements" }, ", choose a ", { b: "Movement type" }, ": RECEIVED, SOLD, ADJUSTMENT, RETURNED or DAMAGED."),
          runs("For ADJUSTMENT, choose a ", { b: "Direction" }, ": ", { b: "Increase stock" }, " or ", { b: "Decrease stock" }, "."),
          runs("Enter the ", { b: "Quantity" }, " and, if you like, a ", { b: "Reason / note" }, "."),
          runs("Select ", { b: "Record movement" }, "."),
        ),
        p("RECEIVED and RETURNED add to stock; SOLD and DAMAGED take it away. Stock can't go below zero unless Accounts settings allow it. Every movement is listed with its date, its warehouse, its value, its reason and who recorded it."),
      ),
      task(
        "Receive goods against a purchase order",
        ol(
          runs("Open ", { b: "Accounts › Goods receipts (GRN)" }, " and select ", { b: "New goods receipt" }, "."),
          "Choose the purchase order. Its lines come in with what was ordered, what earlier receipts accepted, and what is still to come.",
          "Enter what was accepted and what was rejected on each line, with the batch and expiry date or the serial numbers where the item keeps them.",
          runs("Save, then select ", { b: "Post" }, ". Stock comes into the warehouse at the order's price; the vendor's bill, when it comes, is matched to the receipt and doesn't receive the goods twice."),
        ),
      ),
      task(
        "Move stock between warehouses",
        ol(
          runs("Open ", { b: "Accounts › Stock vouchers" }, " and select ", { b: "New transfer" }, "."),
          "Choose the warehouse it leaves and the one it goes to, and add the items.",
          runs("Select ", { b: "Send" }, ". The stock leaves at once and is in transit."),
          runs("When it arrives, open the transfer and select ", { b: "Receive" }, ". It lands at the same value it left with."),
        ),
      ),
      task(
        "Count stock",
        ol(
          runs("Open ", { b: "Accounts › Stock vouchers" }, " and select ", { b: "New physical count" }, "."),
          runs("Choose the warehouse and load its count sheet, then enter what was ", { b: "counted" }, " on each line."),
          "Save and send it for approval. Whoever approves it posts the difference — the stock is written up or down to the count, at cost, with the reason kept.",
        ),
      ),
      task(
        "Change many items at once",
        ol(
          "On the list, tick the items you want to change (or tick the box at the top to pick the whole page).",
          runs("In the bar that appears, choose what to change: a brand (or ", { b: "Remove brand" }, "), a product family, the type, a category (or ", { b: "Remove category" }, "), an HSN/SAC code, or ", { b: "Mark active" }, " / ", { b: "Mark inactive" }, "."),
          runs("Select ", { b: "Apply to" }, " and the number of items."),
        ),
        p("Anything left on “no change” stays as it is. Moving items to another brand clears their product family, since a family belongs to one brand."),
      ),
      task(
        "Import or export items",
        ol(
          runs("On the list, select ", { b: "Import CSV" }, ", and ", { b: "Download sample CSV" }, " to see the columns."),
          "Fill in one row per item. A row whose SKU already exists updates that item; a new SKU adds one.",
          runs("Choose the file (2 MB at most) and select ", { b: "Import" }, "."),
          "Read the result: how many were created and updated, any brands, families or categories that were added, and each row that was skipped and why.",
        ),
        p(runs({ b: "Export CSV" }, " downloads every item, and the file can be edited and imported straight back. Leave the brand, family or HSN column out entirely and items keep theirs; include the column with a blank cell and that value is cleared.")),
      ),
      task(
        "Keep brands, families and categories",
        ol(
          runs("Open ", { b: "Accounts › Brands & families" }, "."),
          runs("Type a name in ", { b: "Add a brand" }, " and select ", { b: "Add" }, ". Under a brand, type a family name and select ", { b: "Add family" }, "."),
          "Use the pencil to rename a brand or family, and the bin to delete one.",
          runs("For categories, select ", { b: "Categories" }, " at the top of the items list and add, rename or delete them the same way."),
        ),
        p("Renaming a brand, family or category renames it on every item at once. One that still has items can't be deleted until they're moved."),
      ),
      task(
        "Fix HSN/SAC codes (India)",
        ol(
          "When some items have a missing code, the wrong kind (a SAC on goods, an HSN on a service) or one the GST portal doesn't list, the items list says how many.",
          runs("Select ", { b: "Show them" }, " to list just those items."),
          "Open each one to correct its code, or tick several and set one code for all of them from the bar.",
        ),
      ),
      task(
        "Find an item",
        p(runs("Search by name, SKU or item ID (ITM-…), filter by ", { b: "Brand" }, " or ", { b: "Category" }, ", or pick ", { b: "All" }, ", ", { b: "Goods" }, ", ", { b: "Services" }, " or ", { b: "Subscriptions" }, ". Your company's own product fields can be filtered on too.")),
      ),
    ],
    settings: [
      setting("Brands & families", "Accounts › Brands & families", p("The brands you sell and the product families within each. An item picks a brand first, then one of that brand's families. Changed only by people allowed to manage brands, families & industries.")),
      setting("Categories", "Items & Inventory › Categories", p("Your own list of item categories. The item form picks from it, so one kind of thing isn't filed three ways, and reports group by it.")),
      setting(
        "Custom fields",
        "Settings › Custom fields › Products",
        p("Your company's own fields on items — shown under More details on the item form and page, and, when marked to, as columns and filters on the list. Managed by people allowed to manage custom fields."),
      ),
      setting("Wording", "Settings › Wording", p("Your own word for an item — “Product”, say — used in the menu, headings and buttons instead.")),
      setting("Import & export", "Settings › Import & export", p("Moving the whole catalogue in or out, under “Items & catalog”, for people allowed to import or export the catalog.")),
      setting("Active (sellable / orderable)", "On each item", p("Untick it to stop offering an item on new orders and documents. It stays on the list, marked Inactive, and on every record that already uses it.")),
      setting("Accounts settings", "Accounts › Accounts settings", p("Periodic or perpetual inventory, weighted average or FIFO, whether stock may go negative, whether invoices, bills and credit notes move stock, whether orders reserve it, who approves adjustments and vouchers, and how stock vouchers are numbered. For people allowed to change Accounts settings.")),
      setting("Warehouses", "Accounts › Warehouses", p("Where stock is kept. One is the default, used when a document doesn't name another. A warehouse with stock in it can't be closed until it is transferred out.")),
      setting("Units of measure", "Accounts › Units of measure", p("The units quantities are kept in, with how many decimals each takes. An item can also be bought or sold in another unit — a box of 12 — converted to its own unit as it moves.")),
      setting("Track inventory for this item", "On each item (goods only)", p("Turns stock counting on for the item: its page then shows Stock on hand and Stock movements, and a Low stock badge at or below the Reorder level. Services and subscriptions never track stock.")),
      setting(
        "Revenue is recognised",
        "On each item, where revenue recognition is used",
        p("Whether revenue is recognised when invoiced or over the service period. Left on “Automatic (from the item type)”, a subscription is recognised over its service period and anything else when invoiced. Only shown where Revenue & Close is available."),
      ),
    ],
    faq: [
      qa("How do I delete an item?", p("Items aren't deleted, because orders and documents point at them. Untick Active (sellable / orderable) on the item, or tick several on the list and choose Mark inactive. It then stops appearing in the product pickers.")),
      qa("Why didn't stock go down when we invoiced?", p("Issuing an invoice moves stock only once “Tax invoices issue stock” is on in Accounts settings. Until then, record a SOLD movement on the item for what went out.")),
      qa(
        "Why can't I tick Manage as a subscription?",
        p("It's offered only on a service, and only where Renewals is available. Without Renewals nothing would ever renew the item, so a new subscription item is refused."),
      ),
      qa("Why can't I add a brand or category?", p("Changing those lists takes the permission to manage brands, families & industries. Ask an admin, or ask somebody who has it to add what you need.")),
      qa(
        "My import skipped some rows.",
        p("Each skipped row is listed with its reason. The usual ones: the row names a brand, family or category that isn't on the list and you aren't allowed to add to it; or, in India, its HSN/SAC is missing, the wrong kind, or not in the GST portal's directory."),
      ),
      qa("It says “Not enough stock”.", p("A movement can't take stock below zero, and stock another order has reserved isn't available either. Check the quantity and the warehouse, or record the receipt that's missing first. Accounts settings can allow negative stock, though never for items kept in batches.")),
      qa(
        "I don't see Items & Inventory in the menu.",
        p("Either the module is switched off for your company, or your role has had it hidden. Ask an admin: the switch is in Settings › Modules, and the menu section is in Settings › Roles & Permissions."),
      ),
    ],
    related: ["orders", "sales_documents", "purchase_documents", "renewals"],
  },
};
