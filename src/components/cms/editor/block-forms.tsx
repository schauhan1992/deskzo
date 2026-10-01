"use client";

import type { ReactNode } from "react";
import type {
  BlockPropsMap,
  BlockType,
  ComparisonTableProps,
  ContactFormProps,
  CtaProps,
  FaqProps,
  FeatureGridProps,
  HeroProps,
  ImageTextProps,
  LogoCloudProps,
  ModuleGridProps,
  ModuleHighlightsProps,
  PageHeaderProps,
  PricingTableProps,
  ProductPreviewsProps,
  RelatedLinksProps,
  RichTextProps,
  SecurityHighlightsProps,
  SignupFormProps,
  SiteBlock,
  StatsProps,
  TestimonialProps,
  WorkspaceSigninProps,
} from "@/components/site/blocks/types";
import { PREVIEW_KINDS } from "@/components/site/blocks/types";
import {
  ActionField,
  AnchorField,
  ChoiceField,
  DateField,
  HrefField,
  IconField,
  ImageField,
  LinesField,
  LinkField,
  ListField,
  MarkField,
  MediaField,
  PREVIEW_LABELS,
  SelectField,
  TextField,
} from "@/components/cms/editor/fields";
import { RichTextField } from "@/components/cms/editor/rich-text-field";
import { MODULE_REGISTRY } from "@/lib/modules";

/**
 * One hand-written form per block type, producing exactly the props in
 * src/components/site/blocks/types.ts, with the same limits the server checks (src/lib/cms/validate.ts:
 * headings 200, labels 80, short titles 120, bodies 1,000, long text 2,000).
 */

const HEADING = 200;
const LABEL = 80;
const SHORT = 120;
const BODY = 1000;
const LONG = 2000;

type FormProps<K extends BlockType> = { props: BlockPropsMap[K]; onChange: (next: BlockPropsMap[K]) => void };

function Row({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h4 className="text-xs font-semibold tracking-wide text-subtle uppercase">{title}</h4>
      {children}
    </section>
  );
}

type Head = { anchor?: string; eyebrow?: string; heading: string; intro?: string };

/** The eyebrow, heading, introduction and anchor most sections share. */
function SectionHeadFields<P extends Head>({ props, onChange }: { props: P; onChange: (next: P) => void }) {
  return (
    <>
      <Row>
        <TextField label="Eyebrow" name="eyebrow" value={props.eyebrow} onChange={(eyebrow) => onChange({ ...props, eyebrow })} max={LABEL} hint="A short line above the heading." />
        <AnchorField value={props.anchor} onChange={(anchor) => onChange({ ...props, anchor })} />
      </Row>
      <TextField label="Heading" name="heading" value={props.heading} onChange={(heading) => onChange({ ...props, heading })} max={HEADING} required />
      <TextField label="Introduction" name="intro" value={props.intro} onChange={(intro) => onChange({ ...props, intro })} max={BODY} multiline rows={2} />
    </>
  );
}

// ─── Top of page ─────────────────────────────────────────────────────────────────────────────────

function HeroForm({ props, onChange }: FormProps<"hero">) {
  const set = <K extends keyof HeroProps>(key: K, value: HeroProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <Section title="Words">
        <TextField label="Eyebrow" name="eyebrow" value={props.eyebrow} onChange={(v) => set("eyebrow", v)} max={LABEL} hint="The small pill above the headline." />
        <TextField label="Headline" name="heading" value={props.heading} onChange={(v) => set("heading", v)} max={HEADING} required hint="The page's main title (its h1)." />
        <TextField label="Subheading" name="subheading" value={props.subheading} onChange={(v) => set("subheading", v)} max={600} multiline rows={3} />
      </Section>
      <Section title="Buttons">
        <ActionField label="First button" name="primary" value={props.primary} onChange={(v) => set("primary", v)} />
        <ActionField label="Second button" name="secondary" value={props.secondary} onChange={(v) => set("secondary", v)} />
        <TextField label="Note under the buttons (signup open)" name="note" value={props.note} onChange={(v) => set("note", v)} max={300} hint="Shown while anyone can sign up, e.g. “Free for {trialDays} days”." />
        <TextField label="Note under the buttons (invitation only)" name="noteInviteOnly" value={props.noteInviteOnly} onChange={(v) => set("noteInviteOnly", v)} max={300} hint="Shown while signup is by invitation." />
      </Section>
      <Section title="Picture">
        <MediaField label="Under the headline" name="media" value={props.media} onChange={(v) => set("media", v)} />
      </Section>
    </>
  );
}

function PageHeaderForm({ props, onChange }: FormProps<"pageHeader">) {
  const set = <K extends keyof PageHeaderProps>(key: K, value: PageHeaderProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <TextField label="Eyebrow" name="eyebrow" value={props.eyebrow} onChange={(v) => set("eyebrow", v)} max={LABEL} />
      <TextField label="Heading" name="heading" value={props.heading} onChange={(v) => set("heading", v)} max={HEADING} required hint="The page's main title (its h1)." />
      <TextField label="Introduction" name="intro" value={props.intro} onChange={(v) => set("intro", v)} max={BODY} multiline rows={3} />
      {props.notice ? (
        <fieldset className="space-y-3 rounded-lg border border-line p-3">
          <legend className="-ml-1 px-1 text-[13px] font-medium text-muted">Notice</legend>
          <ChoiceField
            label="Tone"
            name="notice.tone"
            value={props.notice.tone}
            onChange={(tone) => set("notice", { ...props.notice!, tone })}
            options={[
              { value: "info", label: "Information" },
              { value: "warning", label: "Warning" },
            ]}
          />
          <TextField label="Notice" name="notice.text" value={props.notice.text} onChange={(text) => set("notice", { ...props.notice!, text })} max={600} multiline rows={2} required />
          <button type="button" className="text-xs font-medium text-danger hover:underline" onClick={() => set("notice", undefined)}>
            Remove the notice
          </button>
        </fieldset>
      ) : (
        <button type="button" className="text-sm font-medium text-brand hover:underline" onClick={() => set("notice", { tone: "info", text: "" })}>
          + Add a notice (a draft warning, a caveat)
        </button>
      )}
    </>
  );
}

// ─── Sections ────────────────────────────────────────────────────────────────────────────────────

type Feature = FeatureGridProps["items"][number];

function FeatureGridForm({ props, onChange }: FormProps<"featureGrid">) {
  return (
    <>
      <SectionHeadFields props={props} onChange={onChange} />
      <ChoiceField
        label="Columns on a wide screen"
        name="columns"
        value={props.columns ?? 3}
        onChange={(columns) => onChange({ ...props, columns })}
        options={[
          { value: 2, label: "2" },
          { value: 3, label: "3" },
          { value: 4, label: "4" },
        ]}
      />
      <ListField<Feature>
        label="Cards"
        name="items"
        items={props.items}
        onChange={(items) => onChange({ ...props, items })}
        newItem={() => ({ icon: "sparkles", title: "", body: "" })}
        itemNoun="card"
        itemTitle={(item) => item.title}
        maxItems={24}
        render={(item, set) => (
          <>
            <Row>
              <TextField label="Title" name="title" value={item.title} onChange={(title) => set({ ...item, title })} max={SHORT} required />
              <IconField name="icon" value={item.icon} onChange={(icon) => set({ ...item, icon })} />
            </Row>
            <TextField label="Words" name="body" value={item.body} onChange={(body) => set({ ...item, body })} max={BODY} multiline rows={3} required />
            <LinesField label="Bullet points" name="bullets" value={item.bullets} onChange={(bullets) => set({ ...item, bullets: bullets.length ? bullets : undefined })} max={200} maxItems={12} itemNoun="point" />
            <LinkField label="Link" name="link" value={item.link} onChange={(link) => set({ ...item, link })} />
          </>
        )}
      />
    </>
  );
}

type ModuleGroup = ModuleGridProps["groups"][number];
type ModuleItem = ModuleGroup["modules"][number];
const MODULE_OPTIONS = MODULE_REGISTRY.map((m) => ({ value: m.key, label: m.label }));

function ModuleGridForm({ props, onChange }: FormProps<"moduleGrid">) {
  return (
    <>
      <SectionHeadFields props={props} onChange={onChange} />
      <ListField<ModuleGroup>
        label="Groups"
        name="groups"
        items={props.groups}
        onChange={(groups) => onChange({ ...props, groups })}
        newItem={() => ({ icon: "layers", title: "", modules: [{ label: "", blurb: "" }] })}
        itemNoun="group"
        itemTitle={(g) => g.title}
        maxItems={16}
        render={(group, setGroup) => (
          <>
            <Row>
              <TextField label="Group title" name="title" value={group.title} onChange={(title) => setGroup({ ...group, title })} max={SHORT} required />
              <IconField name="icon" value={group.icon} onChange={(icon) => setGroup({ ...group, icon: icon ?? "layers" })} required />
            </Row>
            <TextField label="Summary" name="summary" value={group.summary} onChange={(summary) => setGroup({ ...group, summary })} max={600} />
            <ListField<ModuleItem>
              label="Modules"
              name="modules"
              items={group.modules}
              onChange={(modules) => setGroup({ ...group, modules })}
              newItem={() => ({ label: "", blurb: "" })}
              itemNoun="module"
              itemTitle={(m) => m.label}
              maxItems={30}
              render={(m, setModule) => (
                <>
                  <Row>
                    <TextField label="Name" name="label" value={m.label} onChange={(label) => setModule({ ...m, label })} max={LABEL} required />
                    <SelectField
                      label="Product module"
                      name="key"
                      value={m.key}
                      onChange={(key) => setModule({ ...m, key })}
                      options={MODULE_OPTIONS}
                      required={false}
                      emptyLabel="Not linked"
                      hint="Linked modules get the “sold in one country” badge automatically."
                    />
                  </Row>
                  <TextField label="What it does" name="blurb" value={m.blurb} onChange={(blurb) => setModule({ ...m, blurb })} max={300} multiline rows={2} required />
                </>
              )}
            />
          </>
        )}
      />
      <TextField label="Footnote" name="footnote" value={props.footnote} onChange={(footnote) => onChange({ ...props, footnote })} max={600} multiline rows={2} />
    </>
  );
}

function RichTextForm({ props, onChange }: FormProps<"richText">) {
  const set = <K extends keyof RichTextProps>(key: K, value: RichTextProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <Row>
        <TextField label="Heading" name="heading" value={props.heading} onChange={(v) => set("heading", v)} max={HEADING} />
        <AnchorField value={props.anchor} onChange={(v) => set("anchor", v)} />
      </Row>
      <RichTextField label="Text" name="content" value={props.content} onChange={(content) => set("content", content)} />
    </>
  );
}

function ImageTextForm({ props, onChange }: FormProps<"imageText">) {
  const set = <K extends keyof ImageTextProps>(key: K, value: ImageTextProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <SectionHeadFields props={props} onChange={onChange} />
      <LinesField label="Paragraphs" name="body" value={props.body} onChange={(v) => set("body", v.length ? v : undefined)} max={LONG} maxItems={10} multiline itemNoun="paragraph" />
      <LinesField label="Bullet points" name="bullets" value={props.bullets} onChange={(v) => set("bullets", v.length ? v : undefined)} max={200} maxItems={12} itemNoun="point" />
      <ActionField label="Button" name="action" value={props.action} onChange={(v) => set("action", v)} />
      <MediaField label="Picture" name="media" value={props.media} onChange={(v) => set("media", v ?? { kind: "preview", preview: "pipeline" })} required />
      <ChoiceField
        label="Picture on a wide screen"
        name="mediaSide"
        value={props.mediaSide ?? "right"}
        onChange={(v) => set("mediaSide", v)}
        options={[
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ]}
      />
    </>
  );
}

type Stat = StatsProps["items"][number];

function StatsForm({ props, onChange }: FormProps<"stats">) {
  return (
    <>
      <Row>
        <TextField label="Heading" name="heading" value={props.heading} onChange={(heading) => onChange({ ...props, heading })} max={HEADING} />
        <AnchorField value={props.anchor} onChange={(anchor) => onChange({ ...props, anchor })} />
      </Row>
      <ListField<Stat>
        label="Figures"
        name="items"
        items={props.items}
        onChange={(items) => onChange({ ...props, items })}
        newItem={() => ({ value: "", label: "" })}
        itemNoun="figure"
        itemTitle={(s) => [s.value, s.label].filter(Boolean).join(" ")}
        maxItems={8}
        hint="Only figures you can stand behind — they are read as claims."
        render={(item, set) => (
          <Row>
            <TextField label="Figure" name="value" value={item.value} onChange={(value) => set({ ...item, value })} max={40} required placeholder="99.9%" />
            <TextField label="What it counts" name="label" value={item.label} onChange={(label) => set({ ...item, label })} max={SHORT} required />
          </Row>
        )}
      />
    </>
  );
}

type Question = FaqProps["items"][number];

function FaqForm({ props, onChange }: FormProps<"faq">) {
  return (
    <>
      <SectionHeadFields props={props} onChange={onChange} />
      <ListField<Question>
        label="Questions"
        name="items"
        items={props.items}
        onChange={(items) => onChange({ ...props, items })}
        newItem={() => ({ question: "", answer: [""] })}
        itemNoun="question"
        itemTitle={(q) => q.question}
        maxItems={40}
        render={(item, set) => (
          <>
            <TextField label="Question" name="question" value={item.question} onChange={(question) => set({ ...item, question })} max={300} required />
            <LinesField label="Answer" name="answer" value={item.answer} onChange={(answer) => set({ ...item, answer })} max={LONG} maxItems={10} multiline required itemNoun="paragraph" />
          </>
        )}
      />
    </>
  );
}

function CtaForm({ props, onChange }: FormProps<"cta">) {
  const set = <K extends keyof CtaProps>(key: K, value: CtaProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <Row>
        <ChoiceField
          label="Look"
          name="variant"
          value={props.variant ?? "band"}
          onChange={(v) => set("variant", v)}
          options={[
            { value: "band", label: "Brand band" },
            { value: "panel", label: "Quiet panel" },
          ]}
        />
        <AnchorField value={props.anchor} onChange={(v) => set("anchor", v)} />
      </Row>
      <TextField label="Heading" name="heading" value={props.heading} onChange={(v) => set("heading", v)} max={HEADING} required />
      <TextField label="Words" name="body" value={props.body} onChange={(v) => set("body", v)} max={BODY} multiline rows={2} />
      <ActionField label="First button" name="primary" value={props.primary} onChange={(v) => set("primary", v)} />
      <ActionField label="Second button" name="secondary" value={props.secondary} onChange={(v) => set("secondary", v)} />
    </>
  );
}

function PricingTableForm({ props, onChange }: FormProps<"pricingTable">) {
  const set = <K extends keyof PricingTableProps>(key: K, value: PricingTableProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <p className="rounded-md border border-info/30 bg-info-bg px-3 py-2 text-xs text-info">The plans and prices come live from the platform for the visitor&apos;s country. These are the words around them.</p>
      <Row>
        <TextField label="Beside the country picker" name="countryLabel" value={props.countryLabel} onChange={(v) => set("countryLabel", v)} max={LABEL} required />
        <AnchorField value={props.anchor} onChange={(v) => set("anchor", v)} />
      </Row>
      <TextField label="Plans heading" name="editionsHeading" value={props.editionsHeading} onChange={(v) => set("editionsHeading", v)} max={HEADING} required />
      <TextField label="Add-ons heading" name="extrasHeading" value={props.extrasHeading} onChange={(v) => set("extrasHeading", v)} max={HEADING} required />
      <TextField label="Add-ons introduction" name="extrasIntro" value={props.extrasIntro} onChange={(v) => set("extrasIntro", v)} max={BODY} multiline rows={2} />
      <TextField label="Trial note" name="trialNote" value={props.trialNote} onChange={(v) => set("trialNote", v)} max={300} hint="E.g. “Every plan starts with a {trialDays}-day free trial.”" />
      <TextField label="Footnote (what every plan includes)" name="footnote" value={props.footnote} onChange={(v) => set("footnote", v)} max={600} multiline rows={2} />
      <Section title="When nothing is on sale in a country">
        <TextField label="Heading" name="emptyHeading" value={props.emptyHeading} onChange={(v) => set("emptyHeading", v)} max={HEADING} required />
        <TextField label="Words" name="emptyBody" value={props.emptyBody} onChange={(v) => set("emptyBody", v)} max={BODY} multiline rows={2} required />
        <ActionField label="Button" name="emptyAction" value={props.emptyAction} onChange={(v) => set("emptyAction", v)} />
      </Section>
    </>
  );
}

type Highlight = SecurityHighlightsProps["items"][number];

function SecurityHighlightsForm({ props, onChange }: FormProps<"securityHighlights">) {
  return (
    <>
      <SectionHeadFields props={props} onChange={onChange} />
      <ListField<Highlight>
        label="Highlights"
        name="items"
        items={props.items}
        onChange={(items) => onChange({ ...props, items })}
        newItem={() => ({ icon: "shield", title: "", body: "" })}
        itemNoun="highlight"
        itemTitle={(h) => h.title}
        maxItems={24}
        render={(item, set) => (
          <>
            <Row>
              <TextField label="Title" name="title" value={item.title} onChange={(title) => set({ ...item, title })} max={SHORT} required />
              <IconField name="icon" value={item.icon} onChange={(icon) => set({ ...item, icon: icon ?? "shield" })} required />
            </Row>
            <TextField label="Words" name="body" value={item.body} onChange={(body) => set({ ...item, body })} max={BODY} multiline rows={2} required />
          </>
        )}
      />
      <LinkField label="Link" name="link" value={props.link} onChange={(link) => onChange({ ...props, link })} />
    </>
  );
}

type Aside = NonNullable<ContactFormProps["aside"]>[number];

function ContactFormForm({ props, onChange }: FormProps<"contactForm">) {
  const set = <K extends keyof ContactFormProps>(key: K, value: ContactFormProps[K]) => onChange({ ...props, [key]: value });
  const topic = (key: keyof ContactFormProps["topics"], value: string) => set("topics", { ...props.topics, [key]: value });
  return (
    <>
      <Row>
        <TextField label="Form heading" name="heading" value={props.heading} onChange={(v) => set("heading", v)} max={HEADING} required />
        <AnchorField value={props.anchor} onChange={(v) => set("anchor", v)} />
      </Row>
      <TextField label="Introduction" name="intro" value={props.intro} onChange={(v) => set("intro", v)} max={BODY} multiline rows={2} />
      <Section title="Topics people choose from">
        <Row>
          <TextField label="Demo" name="topics.demo" value={props.topics.demo} onChange={(v) => topic("demo", v)} max={60} required />
          <TextField label="Sales" name="topics.sales" value={props.topics.sales} onChange={(v) => topic("sales", v)} max={60} required />
          <TextField label="Support" name="topics.support" value={props.topics.support} onChange={(v) => topic("support", v)} max={60} required />
          <TextField label="Anything else" name="topics.other" value={props.topics.other} onChange={(v) => topic("other", v)} max={60} required />
        </Row>
      </Section>
      <Section title="Sending">
        <TextField label="Send button" name="submitLabel" value={props.submitLabel} onChange={(v) => set("submitLabel", v)} max={60} required />
        <TextField label="After sending: heading" name="successHeading" value={props.successHeading} onChange={(v) => set("successHeading", v)} max={HEADING} required />
        <TextField label="After sending: words" name="successBody" value={props.successBody} onChange={(v) => set("successBody", v)} max={BODY} multiline rows={2} required />
      </Section>
      <Section title="Beside the form">
        <TextField label="Heading" name="asideHeading" value={props.asideHeading} onChange={(v) => set("asideHeading", v)} max={HEADING} />
        <ListField<Aside>
          label="Other ways in"
          name="aside"
          items={props.aside}
          onChange={(aside) => set("aside", aside.length ? aside : undefined)}
          newItem={() => ({ title: "", body: "" })}
          itemNoun="entry"
          itemTitle={(a) => a.title}
          maxItems={6}
          required={false}
          hint="An entry whose words are just an email address becomes a mail link."
          render={(item, setItem) => (
            <>
              <TextField label="Title" name="title" value={item.title} onChange={(title) => setItem({ ...item, title })} max={SHORT} required />
              <TextField label="Words" name="body" value={item.body} onChange={(body) => setItem({ ...item, body })} max={BODY} multiline rows={2} required />
              <LinkField label="Link" name="link" value={item.link} onChange={(link) => setItem({ ...item, link })} />
            </>
          )}
        />
      </Section>
    </>
  );
}

type Logo = LogoCloudProps["items"][number];

function LogoCloudForm({ props, onChange }: FormProps<"logoCloud">) {
  return (
    <>
      <Row>
        <TextField label="Heading" name="heading" value={props.heading} onChange={(heading) => onChange({ ...props, heading })} max={HEADING} />
        <AnchorField value={props.anchor} onChange={(anchor) => onChange({ ...props, anchor })} />
      </Row>
      <ListField<Logo>
        label="Logos"
        name="items"
        items={props.items}
        onChange={(items) => onChange({ ...props, items })}
        newItem={() => ({ name: "" })}
        itemNoun="logo"
        itemTitle={(l) => l.name}
        maxItems={24}
        hint="Real customers only, with their permission. Without an image the name is shown."
        render={(item, set) => (
          <>
            <TextField label="Customer name" name="name" value={item.name} onChange={(name) => set({ ...item, name })} max={SHORT} required />
            <ImageField label="Logo" name="imageUrl" value={item.imageUrl} onChange={(imageUrl) => set({ ...item, imageUrl })} />
            <HrefField label="Their website" name="href" value={item.href} onChange={(href) => set({ ...item, href: href || undefined })} />
          </>
        )}
      />
    </>
  );
}

function TestimonialForm({ props, onChange }: FormProps<"testimonial">) {
  const set = <K extends keyof TestimonialProps>(key: K, value: TestimonialProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <TextField label="Their words" name="quote" value={props.quote} onChange={(v) => set("quote", v)} max={BODY} multiline rows={4} required hint="Exactly as they said it, with their permission." />
      <Row>
        <TextField label="Name" name="name" value={props.name} onChange={(v) => set("name", v)} max={SHORT} required />
        <TextField label="Role" name="role" value={props.role} onChange={(v) => set("role", v)} max={SHORT} />
        <TextField label="Company" name="company" value={props.company} onChange={(v) => set("company", v)} max={SHORT} />
        <AnchorField value={props.anchor} onChange={(v) => set("anchor", v)} />
      </Row>
      <ImageField label="Photo" name="imageUrl" value={props.imageUrl} onChange={(v) => set("imageUrl", v)} />
    </>
  );
}

type Preview = ProductPreviewsProps["items"][number];

function ProductPreviewsForm({ props, onChange }: FormProps<"productPreviews">) {
  return (
    <>
      <SectionHeadFields props={props} onChange={onChange} />
      <ListField<Preview>
        label="Screens"
        name="items"
        items={props.items}
        onChange={(items) => onChange({ ...props, items })}
        newItem={() => ({ preview: "pipeline", title: "", body: "" })}
        itemNoun="screen"
        itemTitle={(p) => p.title || PREVIEW_LABELS[p.preview]}
        maxItems={6}
        render={(item, set) => (
          <>
            <Row>
              <SelectField label="Screen" name="preview" value={item.preview} onChange={(preview) => set({ ...item, preview: preview ?? "pipeline" })} options={PREVIEW_KINDS.map((k) => ({ value: k, label: PREVIEW_LABELS[k] }))} />
              <TextField label="Title" name="title" value={item.title} onChange={(title) => set({ ...item, title })} max={SHORT} required />
            </Row>
            <TextField label="Words" name="body" value={item.body} onChange={(body) => set({ ...item, body })} max={BODY} multiline rows={2} required />
          </>
        )}
      />
    </>
  );
}

function WorkspaceSigninForm({ props, onChange }: FormProps<"workspaceSignin">) {
  const set = <K extends keyof WorkspaceSigninProps>(key: K, value: WorkspaceSigninProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <Section title="Go to a workspace by name">
        <TextField label="Heading" name="goHeading" value={props.goHeading} onChange={(v) => set("goHeading", v)} max={HEADING} required />
        <TextField label="Words" name="goBody" value={props.goBody} onChange={(v) => set("goBody", v)} max={BODY} multiline rows={2} />
      </Section>
      <Section title="Find my workspaces by email">
        <TextField label="Heading" name="findHeading" value={props.findHeading} onChange={(v) => set("findHeading", v)} max={HEADING} required />
        <TextField label="Words" name="findBody" value={props.findBody} onChange={(v) => set("findBody", v)} max={BODY} multiline rows={2} />
        <TextField label="After asking: heading" name="confirmationHeading" value={props.confirmationHeading} onChange={(v) => set("confirmationHeading", v)} max={HEADING} required />
        <TextField
          label="After asking: words"
          name="confirmationBody"
          value={props.confirmationBody}
          onChange={(v) => set("confirmationBody", v)}
          max={BODY}
          multiline
          rows={2}
          required
          hint="Shown whatever address was typed — never say whether it has workspaces."
        />
      </Section>
      <AnchorField value={props.anchor} onChange={(v) => set("anchor", v)} />
    </>
  );
}

function SignupFormForm({ props, onChange }: FormProps<"signupForm">) {
  const set = <K extends keyof SignupFormProps>(key: K, value: SignupFormProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <TextField label="Heading" name="heading" value={props.heading} onChange={(v) => set("heading", v)} max={HEADING} required hint="The page's main title (its h1)." />
      <TextField label="Words (signup open)" name="body" value={props.body} onChange={(v) => set("body", v)} max={BODY} multiline rows={3} />
      <TextField label="Words (invitation only)" name="bodyInviteOnly" value={props.bodyInviteOnly} onChange={(v) => set("bodyInviteOnly", v)} max={BODY} multiline rows={3} />
      <TextField label="Beside the form: heading" name="asideHeading" value={props.asideHeading} onChange={(v) => set("asideHeading", v)} max={HEADING} />
      <LinesField label="Beside the form: points" name="asideItems" value={props.asideItems} onChange={(v) => set("asideItems", v.length ? v : undefined)} max={300} maxItems={12} itemNoun="point" />
    </>
  );
}

// ─── Comparisons and internal links ──────────────────────────────────────────────────────────────

type ComparisonRow = ComparisonTableProps["rows"][number];

function ComparisonTableForm({ props, onChange }: FormProps<"comparisonTable">) {
  const set = <K extends keyof ComparisonTableProps>(key: K, value: ComparisonTableProps[K]) => onChange({ ...props, [key]: value });
  return (
    <>
      <SectionHeadFields props={props} onChange={onChange} />
      <Section title="The other product">
        <Row>
          <TextField label="Its name" name="competitor" value={props.competitor} onChange={(v) => set("competitor", v)} max={LABEL} required hint="As this page names it, e.g. Zoho One." />
          <DateField
            label="Its website read on"
            name="asOf"
            value={props.asOf}
            onChange={(v) => set("asOf", v)}
            required
            hint="Under the table: “Information about … from its public website as of” this day."
          />
        </Row>
      </Section>
      <ListField<ComparisonRow>
        label="Rows"
        name="rows"
        items={props.rows}
        onChange={(rows) => onChange({ ...props, rows })}
        newItem={() => ({ feature: "", us: "yes", them: "yes" })}
        itemNoun="row"
        itemTitle={(row) => row.feature}
        maxItems={40}
        hint="One feature a row. Say what each product does, from the other product's own website — and link the page you read it on."
        render={(row, setRow) => (
          <>
            <TextField label="Feature" name="feature" value={row.feature} onChange={(feature) => setRow({ ...row, feature })} max={SHORT} required />
            <Row>
              <MarkField label="This product" name="us" value={row.us} onChange={(us) => setRow({ ...row, us })} />
              <MarkField label="The other product" name="them" value={row.them} onChange={(them) => setRow({ ...row, them })} />
            </Row>
            <TextField label="Note" name="note" value={row.note} onChange={(note) => setRow({ ...row, note: note || undefined })} max={300} multiline rows={2} hint="Under the feature: what differs, in a line." />
            <HrefField label="Source: the other product's own page" name="source" value={row.source} onChange={(source) => setRow({ ...row, source: source || undefined })} webOnly />
          </>
        )}
      />
      <TextField
        label="Disclaimer"
        name="disclaimer"
        value={props.disclaimer}
        onChange={(v) => set("disclaimer", v)}
        max={400}
        multiline
        rows={3}
        required
        hint="Under the table: that what it says about other products is from their public websites as of the date above, and that trademarks belong to their owners."
      />
    </>
  );
}

type RelatedLink = RelatedLinksProps["links"][number];

function RelatedLinksForm({ props, onChange }: FormProps<"relatedLinks">) {
  return (
    <>
      <SectionHeadFields props={props} onChange={onChange} />
      <ListField<RelatedLink>
        label="Links"
        name="links"
        items={props.links}
        onChange={(links) => onChange({ ...props, links })}
        newItem={() => ({ label: "", href: "" })}
        itemNoun="link"
        itemTitle={(l) => l.label}
        maxItems={12}
        hint="Pages on this site only. Words that name the page read best: “GST invoicing”, not “Read more”."
        render={(item, set) => (
          <>
            <Row>
              <TextField label="Words on the link" name="label" value={item.label} onChange={(label) => set({ ...item, label })} max={LABEL} required />
              <HrefField label="Page" name="href" value={item.href} onChange={(href) => set({ ...item, href })} required internalOnly />
            </Row>
            <TextField label="What is there" name="description" value={item.description} onChange={(description) => set({ ...item, description: description || undefined })} max={200} multiline rows={2} />
          </>
        )}
      />
    </>
  );
}

type HighlightGroup = ModuleHighlightsProps["groups"][number];
type HighlightItem = HighlightGroup["items"][number];

function ModuleHighlightsForm({ props, onChange }: FormProps<"moduleHighlights">) {
  return (
    <>
      <SectionHeadFields props={props} onChange={onChange} />
      <ListField<HighlightGroup>
        label="Groups"
        name="groups"
        items={props.groups}
        onChange={(groups) => onChange({ ...props, groups })}
        newItem={() => ({ title: "", items: [{ label: "", href: "", description: "" }] })}
        itemNoun="group"
        itemTitle={(g) => g.title}
        maxItems={6}
        render={(group, setGroup) => (
          <>
            <TextField label="Group title" name="title" value={group.title} onChange={(title) => setGroup({ ...group, title })} max={SHORT} required />
            <ListField<HighlightItem>
              label="Links"
              name="items"
              items={group.items}
              onChange={(items) => setGroup({ ...group, items })}
              newItem={() => ({ label: "", href: "", description: "" })}
              itemNoun="link"
              itemTitle={(i) => i.label}
              maxItems={12}
              render={(item, setItem) => (
                <>
                  <Row>
                    <TextField label="Words on the link" name="label" value={item.label} onChange={(label) => setItem({ ...item, label })} max={LABEL} required />
                    <HrefField label="Page" name="href" value={item.href} onChange={(href) => setItem({ ...item, href })} required internalOnly />
                  </Row>
                  <TextField label="What it covers" name="description" value={item.description} onChange={(description) => setItem({ ...item, description })} max={200} multiline rows={2} required />
                </>
              )}
            />
          </>
        )}
      />
    </>
  );
}

/** The form for one block, by its type. */
export function BlockForm({ block, onChange }: { block: SiteBlock; onChange: (next: SiteBlock) => void }) {
  switch (block.type) {
    case "hero":
      return <HeroForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "pageHeader":
      return <PageHeaderForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "featureGrid":
      return <FeatureGridForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "moduleGrid":
      return <ModuleGridForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "richText":
      return <RichTextForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "imageText":
      return <ImageTextForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "stats":
      return <StatsForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "faq":
      return <FaqForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "cta":
      return <CtaForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "pricingTable":
      return <PricingTableForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "securityHighlights":
      return <SecurityHighlightsForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "contactForm":
      return <ContactFormForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "logoCloud":
      return <LogoCloudForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "testimonial":
      return <TestimonialForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "productPreviews":
      return <ProductPreviewsForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "workspaceSignin":
      return <WorkspaceSigninForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "signupForm":
      return <SignupFormForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "comparisonTable":
      return <ComparisonTableForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "relatedLinks":
      return <RelatedLinksForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    case "moduleHighlights":
      return <ModuleHighlightsForm props={block.props} onChange={(props) => onChange({ ...block, props })} />;
    default:
      return <p className="text-sm text-muted">This block&apos;s type is not known to this editor. It is kept as it is.</p>;
  }
}
