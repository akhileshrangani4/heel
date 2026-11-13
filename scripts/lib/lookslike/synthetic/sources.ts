/**
 * Where the synthetic `looks_like` corpus comes from (spec: Hiding,
 * `looks_like`; decided Nov 13: reset and code mail generated from public
 * provider templates). Each family in `families.ts` transcribes the English
 * wording of one template listed here, at the pinned commit. Licenses are as
 * GitHub's license API reported them for each repository on 2026-11-13.
 *
 * What is transcribed: subjects and body sentences. What is synthetic: every
 * name, brand, host, URL, token and code, and the surrounding layout
 * (greetings, footers, HTML wrapper, link tracking), drawn by `generate.ts`.
 */

export interface TemplateSource {
  repo: string;
  commit: string;
  /** SPDX id. */
  license: string;
  licenseFile: string;
  /** Template files read, relative to the repository root at `commit`. */
  files: readonly string[];
  /** Anything a reader should know about how the wording was taken. */
  note?: string;
}

export const TEMPLATE_SOURCES = {
  django: {
    repo: "django/django",
    commit: "f24f38c6b2825f15628c07bf2892f1664eed9361",
    license: "BSD-3-Clause",
    licenseFile: "LICENSE",
    files: [
      "django/contrib/admin/templates/registration/password_reset_email.html",
      "django/contrib/auth/templates/registration/password_reset_subject.txt",
    ],
  },
  devise: {
    repo: "heartcombo/devise",
    commit: "05811fb8366edd08874111d0f6fb44543e1c91ef",
    license: "MIT",
    licenseFile: "MIT-LICENSE",
    files: [
      "app/views/devise/mailer/reset_password_instructions.html.erb",
      "app/views/devise/mailer/confirmation_instructions.html.erb",
      "app/views/devise/mailer/password_change.html.erb",
      "app/views/devise/mailer/email_changed.html.erb",
      "config/locales/en.yml",
    ],
  },
  laravel: {
    repo: "laravel/framework",
    commit: "c980cb5827c6512c12ac44493d172a593b41299a",
    license: "MIT",
    licenseFile: "LICENSE.md",
    files: ["src/Illuminate/Auth/Notifications/ResetPassword.php"],
    note: "Subject and lines only; the reset URL shape is synthetic.",
  },
  rails: {
    repo: "rails/rails",
    commit: "50c54eed065b8bfb1b0bbb5fa770c859baa98f9b",
    license: "MIT",
    licenseFile: "MIT-LICENSE",
    files: [
      "railties/lib/rails/generators/rails/authentication/templates/app/views/passwords_mailer/reset.text.erb.tt",
      "railties/lib/rails/generators/rails/authentication/templates/app/mailers/passwords_mailer.rb.tt",
    ],
  },
  wagtail: {
    repo: "wagtail/wagtail",
    commit: "3002dd0084f95ce43904fd7ae49eaeee4c463637",
    license: "BSD-3-Clause",
    licenseFile: "LICENSE",
    files: [
      "wagtail/admin/templates/wagtailadmin/account/password_reset/email.txt",
      "wagtail/admin/templates/wagtailadmin/account/password_reset/email_subject.txt",
    ],
  },
  allauth: {
    repo: "pennersr/django-allauth",
    commit: "1a70b222fa9d5c13c2a33f64da94a99e9d248033",
    license: "MIT",
    licenseFile: "LICENSE",
    files: [
      "allauth/templates/account/email/base_message.txt",
      "allauth/templates/account/email/login_code_message.txt",
      "allauth/templates/account/email/login_code_subject.txt",
      "allauth/templates/account/email/password_reset_code_message.txt",
      "allauth/templates/account/email/password_reset_code_subject.txt",
      "allauth/templates/account/email/password_reset_key_message.txt",
      "allauth/templates/account/email/password_reset_key_subject.txt",
      "allauth/templates/account/email/email_confirmation_message.txt",
      "allauth/templates/account/email/email_confirmation_subject.txt",
    ],
  },
  keycloak: {
    repo: "keycloak/keycloak",
    commit: "a29205c778402c02bad1d90b00c390f923d059ac",
    license: "Apache-2.0",
    licenseFile: "LICENSE.txt",
    files: ["themes/src/main/resources/theme/base/email/messages/messages_en.properties"],
    note: "Only the email message keys used by the families below.",
  },
  kratos: {
    repo: "ory/kratos",
    commit: "b86338da04a040247a07f46100a86dcfb3875909",
    license: "Apache-2.0",
    licenseFile: "LICENSE",
    files: [
      "courier/template/courier/builtin/templates/login_code/valid/email.body.plaintext.gotmpl",
      "courier/template/courier/builtin/templates/login_code/valid/email.subject.gotmpl",
      "courier/template/courier/builtin/templates/recovery/valid/email.body.plaintext.gotmpl",
      "courier/template/courier/builtin/templates/recovery/valid/email.subject.gotmpl",
      "courier/template/courier/builtin/templates/recovery_code/valid/email.body.plaintext.gotmpl",
      "courier/template/courier/builtin/templates/recovery_code/valid/email.subject.gotmpl",
      "courier/template/courier/builtin/templates/registration_code/valid/email.body.plaintext.gotmpl",
      "courier/template/courier/builtin/templates/registration_code/valid/email.subject.gotmpl",
      "courier/template/courier/builtin/templates/verification/valid/email.body.plaintext.gotmpl",
      "courier/template/courier/builtin/templates/verification/valid/email.subject.gotmpl",
      "courier/template/courier/builtin/templates/verification_code/valid/email.body.plaintext.gotmpl",
      "courier/template/courier/builtin/templates/verification_code/valid/email.subject.gotmpl",
    ],
  },
  supabase: {
    repo: "supabase/auth",
    commit: "3e79d8513b67d7dc3f234153aacc074daf82db5f",
    license: "MIT",
    licenseFile: "LICENSE",
    files: ["internal/mailer/templatemailer/templatemailer.go"],
  },
  nextauth: {
    repo: "nextauthjs/next-auth",
    commit: "a1a16a5a7780488c7449feece410033f445d0b31",
    license: "ISC",
    licenseFile: "LICENSE",
    files: ["packages/core/src/providers/nodemailer.ts", "packages/core/src/lib/utils/email.ts"],
  },
  authelia: {
    repo: "authelia/authelia",
    commit: "92d501e08ef631a7e9d4defcaa527d2e8092919e",
    license: "Apache-2.0",
    licenseFile: "LICENSE",
    files: [
      "internal/templates/embed/notification/IdentityVerificationOTC.txt",
      "internal/templates/embed/notification/IdentityVerificationJWT.txt",
    ],
    note: "Authelia sets subjects in code that was not read; each family uses the template's heading line as its subject.",
  },
  gitea: {
    repo: "go-gitea/gitea",
    commit: "eaa4fe918d6f296d4280f5f571686eb9f00a8bd8",
    license: "MIT",
    licenseFile: "LICENSE",
    files: ["options/locale/locale_en-US.json"],
    note: "The mail.activate_account, mail.activate_email, mail.reset_password and mail.register_notify strings.",
  },
  payload: {
    repo: "payloadcms/payload",
    commit: "56033d9561275b2f3457fc86666d8da232a8528e",
    license: "MIT",
    licenseFile: "LICENSE.md",
    files: [
      "packages/payload/src/auth/operations/forgotPassword.ts",
      "packages/payload/src/auth/sendVerificationEmail.ts",
      "packages/translations/src/languages/en.ts",
    ],
  },
  ghost: {
    repo: "TryGhost/Ghost",
    commit: "e30976bcebf104298554b012e6b7047fe173f9bd",
    license: "MIT",
    licenseFile: "LICENSE",
    files: ["ghost/core/server/services/members/emails/signin.js"],
    note: "The subject is the template's <title>; the code that sets Ghost's real subject was not read.",
  },
  pocketbase: {
    repo: "pocketbase/pocketbase",
    commit: "7f2773ec234b62d0b80ca47c508397cb3d0da3ea",
    license: "MIT",
    licenseFile: "LICENSE.md",
    files: ["core/collection_model_auth_templates.go"],
  },
  appwrite: {
    repo: "appwrite/appwrite",
    commit: "f7076dc691a7d747889b1c79ae88dbb0550eadd0",
    license: "BSD-3-Clause",
    licenseFile: "LICENSE",
    files: ["app/config/locale/translations/en.json"],
    note: "The emails.* strings.",
  },
  heel: {
    repo: "akhileshrangani4/heel",
    commit: "",
    license: "Apache-2.0",
    licenseFile: "LICENSE",
    files: ["scripts/lib/lookslike/synthetic/families.ts"],
    note: "Ordinary transactional mail written for this corpus (hard negatives); no upstream template.",
  },
} as const satisfies Record<string, TemplateSource>;

export type SourceId = keyof typeof TEMPLATE_SOURCES;
