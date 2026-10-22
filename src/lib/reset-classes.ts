/**
 * What "Keep my setup" keeps and what it removes (owner, 22 Oct 2026 — src/lib/workspace-reset.ts, the engine
 * in src/lib/data-reset.ts): every table of a workspace is one or the other, named here by its Prisma model.
 *
 * **Setup** is kept: the people and what they may do, the organisation, how documents are numbered, the
 * catalogue, how selling, the books and HR are set up, employees' profiles and salary structures, templates,
 * connections, automations. **Records** go: customers, leads, orders, documents, payments, tickets, tasks,
 * stock, the ledger's entries, HR history (attendance, leave taken, payslips, expense claims, letters), chat,
 * logs. Numbering starts again from 1 — the counters are records, the formats are setup.
 *
 * A table in neither list fails check:data-reset, so a new one can't be wiped, or kept, by accident.
 */

export const SETUP_MODELS = {
  "People and access": [
    "User", "Role", "RolePermission", "RoleAccessLevel", "UserPermission", "UserAccessLevel", "RoleFieldPolicy",
    "UserFieldPolicy", "RoleUnmaskLimit", "UserUnmaskLimit", "RoleAccessPolicy", "UserAccessPolicy", "IpRule",
    "SecurityPolicy", "SecuritySettings", "SignInRule", "WorkplaceSettings", "UserDevice", "AppDevice", "UserPhoto",
    "TablePreference", "PageLayout", "NotificationPreference", "DigitalCard",
  ],
  "The organisation": [
    "OrganisationSettings", "BrandingSettings", "TerminologySettings", "SystemModule", "MaintenanceMode", "Branch",
    "Department", "Designation", "GstRegistration", "OrganisationBankAccount", "HelpDesk", "HelpLink",
  ],
  "Documents and their numbering (the formats — the counters restart)": [
    "DocumentNumberSetting", "DocumentSeries", "DocumentApprovalPolicy", "DocumentMailSettings",
    "DocumentEmailTemplate",
  ],
  "The catalogue (owner, 22 Oct 2026: kept)": [
    "ItemCategory", "Brand", "ProductFamily", "Item", "ItemUnit", "UnitOfMeasure", "Warehouse", "Transporter",
  ],
  "How selling is set up": [
    "Industry", "CustomerCategory", "CustomFieldDefinition", "LeadPipeline", "LeadStage", "PipelineAutomation",
    "OrderStep", "LeadAssignmentRule", "LeadCaptureKey", "ForecastStageWeight", "SalesCelebrationSettings",
    "ActivityAwardSettings", "Target", "IncentiveScheme", "IncentiveSlab", "ProjectType",
    "ProjectTemplateMilestone", "BookingPage",
  ],
  "How the books are set up": [
    "LedgerAccount", "AccountsSettings", "BankAccount", "ExpenseSettings", "RevenueCloseSettings",
    "CloseTaskTemplate",
  ],
  "HR: profiles and policies (owner, 22 Oct 2026: kept; their history goes)": [
    "EmployeeProfile", "EmploymentHistory", "EmployeeDocument", "EmployeeFileVisibility", "SalaryStructure",
    "SalaryComponent", "SalarySplitRules", "LeaveType", "LeaveBalance", "Holiday", "AttendanceSettings",
    "ShortLeavePolicy", "LetterTemplate", "BiometricDevice", "FeedbackQuota",
  ],
  "Mail, calendars, signatures and cards": [
    "MailConnection", "CalendarAccount", "CalendarFeed", "SupportMailSettings", "CustomerEmailSettings",
    "NotificationEmailType", "SignatureTemplate", "SignatureBanner", "SignatureMailbox", "SignatureRule",
    "SignatureSettings", "SignatureOutlook", "CardTemplate",
  ],
  "Marketing set-up": [
    "MessagingProvider", "MarketingTemplate", "MarketingAsset", "Audience", "Journey", "JourneyStep", "InboundForm",
    "FormAccessGrant",
  ],
  "Automations (the workflows, not their runs)": [
    "AutomationWorkflow", "AutomationVersion", "AutomationTrigger", "AutomationConnection", "AutomationWebhook",
    "AutomationTemplate", "AutomationSettings",
  ],
  "Chat, AI, the portal, devices and keys": [
    "ChatSettings", "WordFilter", "CopilotSettings", "PortalSettings", "ApiKey", "VisitorKiosk", "TvScreen",
    "CredentialTag",
  ],
  "Backups, and the record of the reset itself": [
    "Backup", "BackupSchedule", "WorkspaceReset",
  ],
} as const;

export const RECORD_MODELS = [
  "AccountVoucher", "AccountVoucherLine", "AccountingSchedule", "AccountingScheduleLine", "AccountsCounter",
  "Activity", "ActivityAward", "ActivityLog", "Announcement", "ApiIdempotency", "AppCallRequest", "AppPairing",
  "ApprovalRequest", "Asset", "AssetMovement", "AttendanceDay", "AttendanceException", "AttendanceLocation",
  "AttendanceRegularisation", "AuditLog", "AutomationEffect", "AutomationEvent", "AutomationEventWait",
  "AutomationRun", "AutomationRunStep", "AutomationUsage", "BankReconciliation", "BankStatementLine",
  "BiometricPunch", "Booking", "CalendarEvent", "CallLog", "Campaign", "Candidate", "CardCampaign",
  "CardCampaignMember", "CardContact", "CardEvent", "Celebration", "CelebrationSeen", "Chat", "ChatAttachment",
  "ChatMember", "ChatMessage", "ChatPin", "ChatPresence", "ChatReaction", "CloseMonth", "CloseTask",
  "CloseTaskAttachment", "CommissionPartyAccount", "CommissionPartyLink", "Company", "CompanyBankAccount",
  "CompanyDuplicateDismissal", "CompanyLocation", "CompanyLock", "CompanyMerge", "CompanyProduct", "Consignment",
  "Contact", "ContactConsent", "ContactVerification", "CopilotConversation", "CopilotMessage", "CopilotProposal",
  "CopilotUsage", "CredentialReveal", "CreditDecision", "CreditNoteApplication", "DailyJobRun",
  "DepreciationCharge", "DeskzoDocumentMail", "DocumentCounter", "DocumentRenderGrant", "DomainProfile",
  "EmployeeLetter", "EwayBill", "Expense", "FeedbackRequest", "FeedbackResponse", "FinalSettlement",
  "FiscalYearClose", "FixedAsset", "FluxNote", "ForecastCommit", "FormInvite", "FormSubmission", "Handover",
  "HandoverLine", "IncentiveEarning", "InternalFeedback", "ItemBatch", "ItemSerial", "JournalCounter",
  "JournalEntry", "JournalLine", "JourneyEnrolment", "Lead", "LeadRequirement", "LeaveRequest", "LedgerLock",
  "MarketingList", "MarketingListMember", "MarketingMessage", "MarketingTick", "MessageEvent", "NetworkAddress",
  "Notification", "NotificationEmailClaim", "OrderExpense", "OrderPriceChange", "OrderRebate", "OrderStepChange",
  "PasswordResetToken", "Payment", "PaymentAllocation", "PaymentFollowUp", "PayrollRun", "Payslip",
  "PermissionChange", "PortalLogin", "PortalRequest", "Prize", "PrizeAnnouncement", "PrizeWinner", "Project",
  "ProjectBillingMilestone", "ProjectCredential", "ProjectDocument", "ProjectMilestone", "ProjectRisk",
  "ProjectStakeholder", "ProjectUpdate", "Proposal", "PurchaseSaving", "RebateAllocation", "RebateProgramme",
  "RecurringBilling", "RecurringBillingPeriod", "ResellerItemPrice", "ResellerProfile", "RevenueSchedule",
  "RevenueScheduleAdjustment", "RevenueScheduleLine", "ScreenshotAllowance", "ShortLeaveRequest", "SignIn",
  "SignatureClick", "SignatureSync", "StickyNote", "StockBalance", "StockCostLayer", "StockDocument",
  "StockDocumentLine", "StockMovement", "StockReservation", "SupportEmail", "SupportEmailAttachment", "Suppression",
  "Survey", "SurveyAnswer", "SurveyParticipation", "SurveyQuestion", "SurveyResponse", "SurveyTarget", "Task",
  "TaskAttachment", "TaskChallenge", "TaskChecklistItem", "TaskComment", "TaskReminder", "TaskStar", "TaskTimeLog",
  "TaxDeclaration", "Ticket", "TicketComment", "TradeDocument", "TradeDocumentLine", "TvPairing", "UnmaskEvent",
  "UnmaskUsage", "UserDailyActivity", "VaultCredential", "VaultPin", "VaultReveal", "VaultShare", "VendorCredit",
  "VendorCreditApplication", "VendorStatement", "VendorStatementLine", "VendorStatementMapping", "Visit",
  "VisitorCompanion", "VisitorCompany", "VisitorEntry", "VisitorInvite", "Wish", "Workbook", "WorkbookAssignee",
  "WorkbookRecord",
] as const;

/** Every setup model, flat. */
export const SETUP_MODEL_NAMES: readonly string[] = Object.values(SETUP_MODELS).flat();
