/**
 * Synthetic mail families. Each positive family transcribes the subject and
 * sentences of one upstream template listed in `sources.ts` (English, at the
 * pinned commit); placeholders are filled from the seeded `Ctx`. Hard
 * negatives are account notices from the same templates that grant nothing
 * (password changed, new sign-in alert), plus ordinary transactional mail
 * written for this corpus under the `heel` source.
 *
 * Labels follow what a message grants, not what it mentions:
 * - `password_reset`: a link or code that resets a password or recovers an account;
 * - `login_code`: a link or code that signs in or proves identity once
 *   (magic links, OTPs, email verification links and codes).
 */
import type { LooksLikeCategory } from "../../../../src/core/lookslike/types.ts";
import type { Ctx } from "./context.ts";
import type { SourceId } from "./sources.ts";

export type Block =
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string }
  | { kind: "link"; url: string; label?: string }
  | { kind: "code"; code: string }
  | { kind: "rule" };

export interface Draft {
  subject: string;
  /** The template's own salutation; without one the renderer may add a generic greeting. */
  greeting?: string;
  /** Hidden preview text; only rendered in HTML. */
  preheader?: string;
  blocks: Block[];
}

export interface Family {
  id: string;
  source: SourceId;
  /** Empty for ordinary mail (a hard negative). */
  labels: readonly LooksLikeCategory[];
  /** How the source sends it. The renderer switches format for a share of messages. */
  format: "text" | "html";
  draft(ctx: Ctx): Draft;
}

const RESET: readonly LooksLikeCategory[] = ["password_reset"];
const CODE: readonly LooksLikeCategory[] = ["login_code"];
const NONE: readonly LooksLikeCategory[] = [];

const text = (value: string): Block => ({ kind: "text", text: value });
const heading = (value: string): Block => ({ kind: "heading", text: value });
const code = (value: string): Block => ({ kind: "code", code: value });
const rule: Block = { kind: "rule" };
function link(url: string, label?: string): Block {
  return label === undefined ? { kind: "link", url } : { kind: "link", url, label };
}

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Django's `uidb64/token` pair: base64 of the user pk, then `<ts36>-<hmac hex>`. */
function djangoUidToken(ctx: Ctx): string {
  const uid = Buffer.from(String(ctx.rng.int(1, 99_999))).toString("base64url");
  return `${uid}/${ctx.token(6, LOWER_ALNUM)}-${ctx.hex(32)}`;
}
const displayName = (ctx: Ctx) => `${ctx.user.first} ${ctx.user.last}`;
const linkedProvider = (ctx: Ctx) => ctx.rng.pick(["Google", "GitHub", "Microsoft", "Apple"]);

// Template sentences use `{{x}}`-style placeholders upstream; here they are
// filled inline. Strings stay verbatim apart from the filled values.
const POSITIVES: readonly Family[] = [
  {
    id: "django.password_reset",
    source: "django",
    labels: RESET,
    format: "text",
    draft: (ctx) => ({
      subject: `Password reset on ${ctx.brand}`,
      blocks: [
        text(
          `You're receiving this email because you requested a password reset for your user account at ${ctx.brand}.`,
        ),
        text("Please go to the following page and choose a new password:"),
        link(`${ctx.appUrl}/reset/${djangoUidToken(ctx)}/`),
        text(`In case you’ve forgotten, you are: ${ctx.user.username}`),
        text("Thanks for using our site!"),
        text(`The ${ctx.brand} team`),
      ],
    }),
  },
  {
    id: "devise.reset_password_instructions",
    source: "devise",
    labels: RESET,
    format: "html",
    draft: (ctx) => ({
      subject: "Reset password instructions",
      greeting: `Hello ${ctx.user.email}!`,
      blocks: [
        text(
          "Someone has requested a link to change your password. You can do this through the link below.",
        ),
        link(
          `${ctx.appUrl}/users/password/edit?reset_password_token=${ctx.token(20)}`,
          "Change my password",
        ),
        text("If you didn't request this, please ignore this email."),
        text("Your password won't change until you access the link above and create a new one."),
      ],
    }),
  },
  {
    id: "devise.confirmation_instructions",
    source: "devise",
    labels: CODE,
    format: "html",
    draft: (ctx) => ({
      subject: "Confirmation instructions",
      greeting: `Welcome ${ctx.user.email}!`,
      blocks: [
        text("You can confirm your account email through the link below:"),
        link(
          `${ctx.appUrl}/users/confirmation?confirmation_token=${ctx.token(20)}`,
          "Confirm my account",
        ),
      ],
    }),
  },
  {
    id: "laravel.reset_password",
    source: "laravel",
    labels: RESET,
    format: "html",
    draft: (ctx) => ({
      subject: "Reset your password",
      blocks: [
        text(
          "You are receiving this email because we received a password reset request for your account.",
        ),
        link(
          `${ctx.appUrl}/reset-password/${ctx.hex(64)}?email=${encodeURIComponent(ctx.user.email)}`,
          "Reset Password",
        ),
        text(`This password reset link will expire in ${ctx.minutes([15, 30, 60])} minutes.`),
        text("If you did not request a password reset, no further action is required."),
      ],
    }),
  },
  {
    id: "rails.passwords_reset",
    source: "rails",
    labels: RESET,
    format: "text",
    draft: (ctx) => ({
      subject: "Reset your password",
      blocks: [
        text("You can reset your password on"),
        link(`${ctx.appUrl}/passwords/${ctx.token(32)}/edit`),
        text(
          `This link will expire in ${ctx.rng.pick(["15 minutes", "about 1 hour", "30 minutes"])}.`,
        ),
      ],
    }),
  },
  {
    id: "wagtail.password_reset",
    source: "wagtail",
    labels: RESET,
    format: "text",
    draft: (ctx) => ({
      subject: "Password reset",
      blocks: [
        text("Please follow the link below to reset your password:"),
        link(`${ctx.appUrl}/admin/password_reset/confirm/${djangoUidToken(ctx)}/`),
        ...(ctx.rng.chance(0.5)
          ? [text(`Your username (in case you've forgotten): ${ctx.user.username}`)]
          : []),
      ],
    }),
  },
  ...allauthFamilies(),
  ...keycloakFamilies(),
  ...kratosFamilies(),
  ...supabaseFamilies(),
  {
    id: "nextauth.sign_in",
    source: "nextauth",
    labels: CODE,
    format: "text",
    draft: (ctx) => ({
      subject: `Sign in to ${ctx.host}`,
      blocks: [
        text(`Sign in to ${ctx.host}`),
        link(
          `${ctx.appUrl}/api/auth/callback/nodemailer?callbackUrl=${encodeURIComponent(ctx.appUrl)}&token=${ctx.hex(64)}&email=${encodeURIComponent(ctx.user.email)}`,
        ),
      ],
    }),
  },
  ...autheliaFamilies(),
  ...giteaFamilies(),
  ...payloadFamilies(),
  ...ghostFamilies(),
  ...pocketbaseFamilies(),
  ...appwriteFamilies(),
];

function allauthWrap(ctx: Ctx, subject: string, blocks: Block[]): Draft {
  return {
    subject,
    greeting: `Hello from ${ctx.brand}!`,
    blocks: [...blocks, text(`Thank you for using ${ctx.brand}!`), text(ctx.host)],
  };
}

function allauthFamilies(): Family[] {
  const ignore = "This mail can be safely ignored if you did not initiate this action.";
  return [
    {
      id: "allauth.password_reset_key",
      source: "allauth",
      labels: RESET,
      format: "text",
      draft: (ctx) =>
        allauthWrap(ctx, "Password Reset Email", [
          text(
            "You're receiving this email because you or someone else has requested a password reset for your user account.\nIt can be safely ignored if you did not request a password reset. Click the link below to reset your password.",
          ),
          link(
            `${ctx.appUrl}/accounts/password/reset/key/${ctx.token(3, LOWER_ALNUM)}-${ctx.token(32)}/`,
          ),
          ...(ctx.rng.chance(0.5)
            ? [text(`In case you forgot, your username is ${ctx.user.username}.`)]
            : []),
        ]),
    },
    {
      id: "allauth.password_reset_code",
      source: "allauth",
      labels: RESET,
      format: "text",
      draft: (ctx) =>
        allauthWrap(ctx, "Password Reset Code", [
          text(
            "Your password reset code is listed below. Please enter it in your open browser window.",
          ),
          code(ctx.code()),
          text(ignore),
        ]),
    },
    {
      id: "allauth.login_code",
      source: "allauth",
      labels: CODE,
      format: "text",
      draft: (ctx) =>
        allauthWrap(ctx, "Sign-In Code", [
          text("Your sign-in code is listed below. Please enter it in your open browser window."),
          code(ctx.code()),
          text(ignore),
        ]),
    },
    {
      id: "allauth.email_confirmation_link",
      source: "allauth",
      labels: CODE,
      format: "text",
      draft: (ctx) =>
        allauthWrap(ctx, "Please Confirm Your Email Address", [
          text(
            `You're receiving this email because user ${ctx.user.username} has given your email address to register an account on ${ctx.host}.`,
          ),
          text(
            `To confirm this is correct, go to ${ctx.appUrl}/accounts/confirm-email/${ctx.token(48)}/`,
          ),
        ]),
    },
    {
      id: "allauth.email_confirmation_code",
      source: "allauth",
      labels: CODE,
      format: "text",
      draft: (ctx) =>
        allauthWrap(ctx, "Please Confirm Your Email Address", [
          text(
            `You're receiving this email because user ${ctx.user.username} has given your email address to register an account on ${ctx.host}.`,
          ),
          text(
            "Your email verification code is listed below. Please enter it in your open browser window.",
          ),
          code(ctx.code()),
        ]),
    },
  ];
}

function keycloakFamilies(): Family[] {
  const actionUrl = (ctx: Ctx) =>
    `${ctx.appUrl}/realms/${ctx.rng.pick(["master", "main", "customers", "staff"])}/login-actions/action-token?key=${ctx.token(24)}.${ctx.token(120)}.${ctx.token(43)}&client_id=account-console`;
  return [
    {
      id: "keycloak.password_reset",
      source: "keycloak",
      labels: RESET,
      format: "html",
      draft: (ctx) => ({
        subject: "Reset password",
        blocks: [
          text(
            `Someone just requested to change your ${ctx.brand} account's credentials. If this was you, click on the link below to reset them.`,
          ),
          link(actionUrl(ctx)),
          text(`This link and code will expire within ${ctx.expiry()}.`),
          text(
            "If you don't want to reset your credentials, just ignore this message and nothing will be changed.",
          ),
        ],
      }),
    },
    {
      id: "keycloak.execute_actions_update_password",
      source: "keycloak",
      labels: RESET,
      format: "html",
      draft: (ctx) => ({
        subject: "Update Your Account",
        blocks: [
          text(
            `Your administrator has just requested that you update your ${ctx.brand} account by performing the following action(s): ${ctx.rng.pick(["Update Password", "Update Password, Configure OTP", "Update Profile, Update Password"])}. Click on the link below to start this process.`,
          ),
          link(actionUrl(ctx)),
          text(`This link will expire within ${ctx.expiry()}.`),
          text(
            "If you are unaware that your administrator has requested this, just ignore this message and nothing will be changed.",
          ),
        ],
      }),
    },
    {
      id: "keycloak.email_verification",
      source: "keycloak",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: "Verify email",
        blocks: [
          text(
            `Someone has created a ${ctx.brand} account with this email address. If this was you, click the link below to verify your email address`,
          ),
          link(actionUrl(ctx)),
          text(`This link will expire within ${ctx.expiry()}.`),
          text("If you didn't create this account, just ignore this message."),
        ],
      }),
    },
    {
      id: "keycloak.email_verification_code",
      source: "keycloak",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: "Verify email",
        blocks: [
          text("Please verify your email address by entering in the following code."),
          code(ctx.code()),
        ],
      }),
    },
    {
      id: "keycloak.email_update_confirmation",
      source: "keycloak",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: "Verify new email",
        blocks: [
          text(
            `To update your ${ctx.brand} account with email address ${ctx.otherEmail()}, click the link below`,
          ),
          link(actionUrl(ctx)),
          text(`This link will expire within ${ctx.expiry()}.`),
          text("If you don't want to proceed with this modification, just ignore this message."),
        ],
      }),
    },
    {
      id: "keycloak.identity_provider_link",
      source: "keycloak",
      labels: CODE,
      format: "html",
      draft: (ctx) => {
        const provider = linkedProvider(ctx);
        return {
          subject: `Link ${provider}`,
          blocks: [
            text(
              `Someone wants to link your "${ctx.brand}" account with "${provider}" account of user ${ctx.user.username} . If this was you, click the link below to link accounts`,
            ),
            link(actionUrl(ctx)),
            text(`This link will expire within ${ctx.expiry()}.`),
            text(
              `If you didn't initiate this process or don't want to link account, just ignore this message. If you link accounts, you will be able to login to ${ctx.brand} through ${provider}.`,
            ),
          ],
        };
      },
    },
  ];
}

function kratosFamilies(): Family[] {
  const flowUrl = (ctx: Ctx, flow: string) =>
    `${ctx.appUrl}/self-service/${flow}?flow=${uuid(ctx)}&token=${ctx.token(32)}`;
  const minutes = (ctx: Ctx) => ctx.minutes([10, 15, 30, 60]);
  return [
    {
      id: "kratos.login_code",
      source: "kratos",
      labels: CODE,
      format: "text",
      draft: (ctx) => {
        const c = ctx.code();
        return {
          subject: `Use code ${c} to log in`,
          blocks: [
            text("Login to your account with the following code:"),
            code(c),
            text(`It expires in ${minutes(ctx)} minutes.`),
          ],
        };
      },
    },
    {
      id: "kratos.recovery_link",
      source: "kratos",
      labels: RESET,
      format: "text",
      draft: (ctx) => ({
        subject: "Recover access to your account",
        blocks: [
          text("Recover access to your account by clicking the following link:"),
          link(flowUrl(ctx, "recovery")),
          text(`If this was not you, do nothing. This link expires in ${minutes(ctx)} minutes.`),
        ],
      }),
    },
    {
      id: "kratos.recovery_code",
      source: "kratos",
      labels: RESET,
      format: "text",
      draft: (ctx) => {
        const c = ctx.code();
        return {
          subject: `Use code ${c} to recover access to your account`,
          blocks: [
            text("Recover access to your account by entering the following code:"),
            code(c),
            text(`If this was not you, do nothing. This code expires in ${minutes(ctx)} minutes.`),
          ],
        };
      },
    },
    {
      id: "kratos.registration_code",
      source: "kratos",
      labels: CODE,
      format: "text",
      draft: (ctx) => {
        const c = ctx.code();
        return {
          subject: `Use code ${c} to complete your account registration`,
          blocks: [
            text("Complete your account registration with the following code:"),
            code(c),
            text(`This code expires in ${minutes(ctx)} minutes.`),
          ],
        };
      },
    },
    {
      id: "kratos.verification_link",
      source: "kratos",
      labels: CODE,
      format: "text",
      draft: (ctx) => ({
        subject: "Please verify your email address",
        blocks: [
          text("Verify your account by opening the following link:"),
          link(flowUrl(ctx, "verification")),
          text(`If this was not you, do nothing. This link expires in ${minutes(ctx)} minutes.`),
        ],
      }),
    },
    {
      id: "kratos.verification_code",
      source: "kratos",
      labels: CODE,
      format: "text",
      draft: (ctx) => {
        const c = ctx.code();
        return {
          subject: `Use code ${c} to verify your account`,
          blocks: [
            text("Verify your account with the following code:"),
            code(c),
            text("or clicking the following link:"),
            link(flowUrl(ctx, "verification")),
            text(
              `If this was not you, do nothing. This code / link expires in ${minutes(ctx)} minutes.`,
            ),
          ],
        };
      },
    },
  ];
}

function uuid(ctx: Ctx): string {
  return `${ctx.hex(8)}-${ctx.hex(4)}-4${ctx.hex(3)}-a${ctx.hex(3)}-${ctx.hex(12)}`;
}

function supabaseFamilies(): Family[] {
  const verifyUrl = (ctx: Ctx, type: string) =>
    `https://${ctx.token(20, LOWER_ALNUM)}.supabase.co/auth/v1/verify?token=${ctx.hex(56)}&type=${type}&redirect_to=${encodeURIComponent(ctx.appUrl)}`;
  return [
    {
      id: "supabase.confirmation",
      source: "supabase",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: "Confirm your email address",
        blocks: [
          heading("Confirm your email address"),
          text("Follow the link below to confirm this email address and finish signing up."),
          link(verifyUrl(ctx, "signup"), "Confirm email address"),
        ],
      }),
    },
    {
      id: "supabase.recovery",
      source: "supabase",
      labels: RESET,
      format: "html",
      draft: (ctx) => ({
        subject: "Reset your password",
        blocks: [
          heading("Reset your password"),
          text(
            "We received a request to reset your password. Follow the link below to choose a new one.",
          ),
          link(verifyUrl(ctx, "recovery"), "Reset password"),
          text("If you didn't request this, you can safely ignore this email."),
        ],
      }),
    },
    {
      id: "supabase.magic_link",
      source: "supabase",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: "Your sign-in link",
        blocks: [
          heading("Your sign-in link"),
          text(
            "Follow the link below to sign in. This link expires shortly and can only be used once.",
          ),
          link(verifyUrl(ctx, "magiclink"), "Sign in"),
        ],
      }),
    },
    {
      id: "supabase.email_change",
      source: "supabase",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: "Confirm your new email address",
        blocks: [
          heading("Confirm your new email address"),
          text(`Follow the link below to confirm ${ctx.otherEmail()} as your new email address.`),
          link(verifyUrl(ctx, "email_change"), "Confirm new email address"),
          text("If you didn't request this change, you can safely ignore this email."),
        ],
      }),
    },
    {
      id: "supabase.reauthentication",
      source: "supabase",
      labels: CODE,
      format: "html",
      draft: (ctx) => {
        const c = ctx.code();
        return {
          subject: `${c} is your verification code`,
          blocks: [
            heading("Your verification code"),
            text("Use the code below to verify your identity. It expires shortly."),
            code(c),
          ],
        };
      },
    },
  ];
}

function autheliaFamilies(): Family[] {
  const revoke = (ctx: Ctx) => `${ctx.appUrl}/revoke/one-time-code?id=${uuid(ctx)}`;
  const footer = (ctx: Ctx, kind: "code" | "link"): Block[] => [
    rule,
    text(
      kind === "code"
        ? `This notification was intended for ${displayName(ctx)}. This one-time code was generated due to an action from ${ctx.ip()}. If you do not believe that your actions could have triggered this event or if you are concerned about your account's safety, please follow the explicit directions in this notification.`
        : `This email was intended for ${displayName(ctx)}. This event was generated due to an action from ${ctx.ip()}. If you do not believe that your actions could have triggered this event or if you are concerned about your account's safety, please follow the explicit directions in this notification.`,
    ),
    text("Powered by Authelia https://www.authelia.com"),
  ];
  return [
    {
      id: "authelia.one_time_code",
      source: "authelia",
      labels: CODE,
      format: "text",
      draft: (ctx) => ({
        subject: "A ONE-TIME CODE HAS BEEN GENERATED TO COMPLETE A REQUESTED ACTION",
        greeting: `Hi ${displayName(ctx)},`,
        blocks: [
          text(
            `This notification has been sent to you in order to verify your identity to change security details for your account at ${ctx.host}.`,
          ),
          text("Do not share this notification or the content of this notification with anyone."),
          text(
            "The following one-time code should only be used in the prompt displayed in your browser.",
          ),
          rule,
          code(ctx.code()),
          rule,
          text(
            "If you did not initiate the process your credentials may have been compromised and you should:\n 1. Revoke this code using the provided links below\n 2. Reset your password or other login credentials\n 3. Contact an Administrator",
          ),
          text("To revoke the code, click the link below:"),
          link(revoke(ctx)),
          ...footer(ctx, "code"),
        ],
      }),
    },
    {
      id: "authelia.one_time_link",
      source: "authelia",
      labels: CODE,
      format: "text",
      draft: (ctx) => ({
        subject: "A ONE-TIME LINK HAS BEEN GENERATED TO COMPLETE A REQUESTED ACTION",
        greeting: `Hi ${displayName(ctx)},`,
        blocks: [
          text(
            `We would like to confirm a requested action related to the security of your account at ${ctx.host}`,
          ),
          text("Do not share this notification or the content of this notification with anyone."),
          rule,
          text("If you made this request, click the validation link below."),
          link(
            `${ctx.appUrl}/settings/two-factor?token=${ctx.token(36)}.${ctx.token(80)}.${ctx.token(43)}`,
          ),
          rule,
          text(
            "If you did NOT initiate this request, your credentials may have been compromised and you should:\n 1. Revoke the validation link using the provided links below\n 2. Reset your password or other login credentials\n 3. Contact an Administrator",
          ),
          text("To revoke the code, click the link below:"),
          link(revoke(ctx)),
          ...footer(ctx, "link"),
        ],
      }),
    },
  ];
}

function giteaFamilies(): Family[] {
  const within = (ctx: Ctx) => ctx.rng.pick(["3 hours", "1 day", "2 days"]);
  const paste = "Not working? Try copying and pasting it to your browser.";
  return [
    {
      id: "gitea.activate_account",
      source: "gitea",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: "Please activate your account",
        blocks: [
          heading(`${ctx.user.username}, please activate your account`),
          text(`Hi ${ctx.user.username}, thanks for registering at ${ctx.brand}!`),
          text(`Please click the following link to activate your account within ${within(ctx)}:`),
          link(`${ctx.appUrl}/user/activate?code=${ctx.hex(80)}`),
          text(paste),
        ],
      }),
    },
    {
      id: "gitea.activate_email",
      source: "gitea",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: "Verify your email address",
        blocks: [
          heading(`${ctx.user.username}, please verify your email address`),
          text(`Hi ${ctx.user.username},`),
          text(
            `Please click the following link to verify your email address within ${within(ctx)}:`,
          ),
          link(
            `${ctx.appUrl}/user/activate_email?code=${ctx.hex(80)}&email=${encodeURIComponent(ctx.user.email)}`,
          ),
          text(paste),
        ],
      }),
    },
    {
      id: "gitea.reset_password",
      source: "gitea",
      labels: RESET,
      format: "html",
      draft: (ctx) => ({
        subject: "Recover your account",
        blocks: [
          heading(`${ctx.user.username}, you have requested to recover your account`),
          text(`Hi ${ctx.user.username},`),
          text(`Please click the following link to recover your account within ${within(ctx)}:`),
          link(`${ctx.appUrl}/user/recover_account?code=${ctx.hex(80)}`),
          text(paste),
        ],
      }),
    },
    {
      // The admin-created variant carries a set-password link: a credential.
      id: "gitea.register_notify_set_password",
      source: "gitea",
      labels: RESET,
      format: "html",
      draft: (ctx) => ({
        subject: `Welcome to ${ctx.brand}`,
        blocks: [
          heading(`${ctx.user.username}, welcome to ${ctx.brand}`),
          text(`Hi ${ctx.user.username},`),
          text(`This is your registration confirmation email for ${ctx.brand}!`),
          text(`You can now log in via username: ${ctx.user.username}.`),
          text("If this account has been created for you, please set your password first."),
          link(`${ctx.appUrl}/user/recover_account?code=${ctx.hex(80)}`, "set your password"),
        ],
      }),
    },
  ];
}

function payloadFamilies(): Family[] {
  return [
    {
      id: "payload.forgot_password",
      source: "payload",
      labels: RESET,
      format: "html",
      draft: (ctx) => {
        const url = `${ctx.appUrl}/admin/reset/${ctx.hex(40)}`;
        return {
          subject: "Reset Your Password",
          blocks: [
            text(
              "You are receiving this because you (or someone else) have requested the reset of the password for your account. Please click on the following link, or paste this into your browser to complete the process:",
            ),
            link(url, url),
            text(
              "If you did not request this, please ignore this email and your password will remain unchanged.",
            ),
          ],
        };
      },
    },
    {
      id: "payload.verify_email",
      source: "payload",
      labels: CODE,
      format: "html",
      draft: (ctx) => {
        const url = `${ctx.appUrl}/admin/users/verify/${ctx.hex(40)}`;
        return {
          subject: "Verify your email",
          blocks: [
            text(
              `A new account has just been created for you to access ${ctx.appUrl} Please click on the following link or paste the URL below into your browser to verify your email:`,
            ),
            link(url, url),
            text("After verifying your email, you will be able to log in successfully."),
          ],
        };
      },
    },
  ];
}

function ghostFamilies(): Family[] {
  const magic = (ctx: Ctx) =>
    `https://${ctx.host}/members/?token=${ctx.token(32)}&action=signin&r=${encodeURIComponent(`https://${ctx.host}/`)}`;
  const tail = (ctx: Ctx): Block[] => [
    text("If you did not make this request, you can safely ignore this email."),
    text(`This message was sent from ${ctx.host} to ${ctx.user.email}.`),
  ];
  return [
    {
      id: "ghost.sign_in_link",
      source: "ghost",
      labels: CODE,
      format: "html",
      draft: (ctx) => {
        const url = magic(ctx);
        return {
          subject: `🔑 Secure sign in link for ${ctx.brand}`,
          greeting: "Hey there,",
          blocks: [
            text(`Welcome back! Use this link to securely sign in to your ${ctx.brand} account:`),
            link(url, "Sign in now"),
            text("For your security, the link will expire in 24 hours time."),
            text("See you soon!"),
            rule,
            text("You can also copy & paste this URL into your browser:"),
            text(url),
            ...tail(ctx),
          ],
        };
      },
    },
    {
      id: "ghost.sign_in_code",
      source: "ghost",
      labels: CODE,
      format: "html",
      draft: (ctx) => {
        const otc = ctx.code();
        return {
          subject: `🔑 Sign in to ${ctx.brand} with code ${otc}`,
          preheader: `Welcome back to ${ctx.brand}! Your verification code is ${otc}.`,
          blocks: [
            heading(`Welcome back to ${ctx.brand}!`),
            code(otc),
            text("For your security, the link will expire in 24 hours time."),
            text("Or, skip the code and sign in directly"),
            link(magic(ctx), "Sign in now"),
            ...tail(ctx),
          ],
        };
      },
    },
  ];
}

function pocketbaseFamilies(): Family[] {
  const tokenUrl = (ctx: Ctx, path: string) =>
    `${ctx.appUrl}/_/#/auth/${path}/${ctx.token(36)}.${ctx.token(120)}.${ctx.token(43)}`;
  const thanks = (ctx: Ctx): Block[] => [text("Thanks,"), text(`${ctx.brand} team`)];
  return [
    {
      id: "pocketbase.verification",
      source: "pocketbase",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: `Verify your ${ctx.brand} email`,
        greeting: "Hello,",
        blocks: [
          text(`Thank you for joining us at ${ctx.brand}.`),
          text("Click on the button below to verify your email address."),
          link(tokenUrl(ctx, "confirm-verification"), "Verify"),
          text("If you didn't recently register, please ignore this email."),
          ...thanks(ctx),
        ],
      }),
    },
    {
      id: "pocketbase.password_reset",
      source: "pocketbase",
      labels: RESET,
      format: "html",
      draft: (ctx) => ({
        subject: `Reset your ${ctx.brand} password`,
        greeting: "Hello,",
        blocks: [
          text("Click on the button below to reset your password."),
          link(tokenUrl(ctx, "confirm-password-reset"), "Reset password"),
          text("If you didn't ask to reset your password, please ignore this email."),
          ...thanks(ctx),
        ],
      }),
    },
    {
      id: "pocketbase.confirm_email_change",
      source: "pocketbase",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: `Confirm your ${ctx.brand} new email address`,
        greeting: "Hello,",
        blocks: [
          text("Click on the button below to confirm your new email address."),
          link(tokenUrl(ctx, "confirm-email-change"), "Confirm new email"),
          text("If you didn't ask to change your email address, please ignore this email."),
          ...thanks(ctx),
        ],
      }),
    },
    {
      id: "pocketbase.otp",
      source: "pocketbase",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: `OTP for ${ctx.brand}`,
        greeting: "Hello,",
        blocks: [
          text(`Your one-time password is: ${ctx.code()}`),
          text("If you didn't ask for the one-time password, you can ignore this email."),
          ...thanks(ctx),
        ],
      }),
    },
  ];
}

function appwriteFamilies(): Family[] {
  const sign = (ctx: Ctx): Block[] => [text("Thanks,"), text(`${ctx.brand} team`)];
  const phrase = (ctx: Ctx) =>
    `${ctx.rng.pick(["Brave", "Quiet", "Golden", "Swift", "Lucky"])} ${ctx.rng.pick(["Otter", "Falcon", "Maple", "Comet", "Harbor"])}`;
  const agent = (ctx: Ctx) => {
    const d = ctx.device();
    return `${d.client} on ${d.device} ${d.os}`;
  };
  const otpFamily = (
    id: string,
    labels: readonly LooksLikeCategory[],
    subject: (ctx: Ctx) => string,
    preview: (ctx: Ctx, otp: string) => string,
    headingText: (ctx: Ctx) => string,
    description: (ctx: Ctx) => string,
    clientInfo: (ctx: Ctx) => string,
    phraseWhere: string | undefined,
  ): Family => ({
    id,
    source: "appwrite",
    labels,
    format: "html",
    draft: (ctx) => {
      const otp = ctx.code();
      return {
        subject: subject(ctx),
        preheader: preview(ctx, otp),
        greeting: `Hello ${ctx.user.first},`,
        blocks: [
          heading(headingText(ctx)),
          text(description(ctx)),
          code(otp),
          text(clientInfo(ctx)),
          ...(phraseWhere === undefined
            ? []
            : [
                text(
                  `Security phrase for this email is ${phrase(ctx)}. You can trust this email if this phrase matches the phrase shown ${phraseWhere}.`,
                ),
              ]),
          ...sign(ctx),
        ],
      };
    },
  });
  const linkUrl = (ctx: Ctx, path: string) =>
    `${ctx.appUrl}/${path}?userId=${ctx.hex(20)}&secret=${ctx.hex(64)}&expire=2026-11-14`;
  return [
    {
      id: "appwrite.verification",
      source: "appwrite",
      labels: CODE,
      format: "html",
      draft: (ctx) => ({
        subject: `Account Verification for ${ctx.brand}`,
        preheader: `Verify your email to activate your ${ctx.brand} account.`,
        greeting: `Hello ${ctx.user.first},`,
        blocks: [
          heading(`Verify your email to start using ${ctx.brand}`),
          text(`Follow this link to verify your email address to your ${ctx.brand} account.`),
          link(linkUrl(ctx, "verify"), "Confirm email address"),
          ...sign(ctx),
        ],
      }),
    },
    {
      id: "appwrite.magic_session",
      source: "appwrite",
      labels: CODE,
      format: "html",
      draft: (ctx) => {
        const url = linkUrl(ctx, "auth/magic-url");
        return {
          subject: `${ctx.brand} Login`,
          preheader: `Sign in to ${ctx.brand} with your secure link. Expires in 1 hour.`,
          greeting: `Hello ${ctx.user.first},`,
          blocks: [
            text(
              `Click the button below to securely sign in to your ${ctx.brand} account. This link will expire in 1 hour.`,
            ),
            link(url, `Sign in to ${ctx.brand}`),
            text(
              "If you are unable to sign in using the button above, please visit the following link:",
            ),
            text(url),
            text(
              `This sign in was requested using ${agent(ctx)}. If you didn't request the sign in, you can safely ignore this email.`,
            ),
            text(
              `Security phrase for this email is ${phrase(ctx)}. You can trust this email if this phrase matches the phrase shown during sign in.`,
            ),
            ...sign(ctx),
          ],
        };
      },
    },
    otpFamily(
      "appwrite.otp_session",
      CODE,
      (ctx) => `OTP for ${ctx.brand} Login`,
      (ctx, otp) => `Use OTP ${otp} to sign in to ${ctx.brand}. Expires in 15 minutes.`,
      (ctx) => `Login with OTP to use ${ctx.brand}`,
      (ctx) =>
        `Enter the following verification code when prompted to securely sign in to your ${ctx.brand} account. This code will expire in 15 minutes.`,
      (ctx) =>
        `This sign in was requested using ${agent(ctx)}. If you didn't request the sign in, you can safely ignore this email.`,
      "during sign in",
    ),
    otpFamily(
      "appwrite.otp_verification",
      CODE,
      (ctx) => `Verify your email for ${ctx.brand}`,
      (ctx, otp) => `Use OTP ${otp} to verify your ${ctx.brand} email. Expires in 15 minutes.`,
      (ctx) => `Verify your email for ${ctx.brand}`,
      (ctx) =>
        `Enter the following code to verify your email address for your ${ctx.brand} account. This code will expire in 15 minutes.`,
      (ctx) =>
        `This verification was requested using ${agent(ctx)}. If you didn't request this, you can safely ignore this email.`,
      "during verification",
    ),
    otpFamily(
      "appwrite.otp_recovery",
      RESET,
      (ctx) => `Password Reset for ${ctx.brand}`,
      (ctx, otp) => `Use OTP ${otp} to reset your ${ctx.brand} password. Expires in 15 minutes.`,
      (ctx) => `Reset your ${ctx.brand} password`,
      (ctx) =>
        `Enter the following code to reset your ${ctx.brand} password. This code will expire in 15 minutes.`,
      (ctx) =>
        `This reset was requested using ${agent(ctx)}. If you didn't request a password reset, you can safely ignore this email.`,
      "during the reset",
    ),
    otpFamily(
      "appwrite.mfa_challenge",
      CODE,
      (ctx) => `Verification Code for ${ctx.brand}`,
      (ctx, otp) =>
        `Use code ${otp} for two-step verification in ${ctx.brand}. Expires in 15 minutes.`,
      (ctx) => `Complete two-step verification to use ${ctx.brand}`,
      (ctx) =>
        `Enter the following code to confirm your two-step verification in ${ctx.brand}. This code will expire in 15 minutes.`,
      (ctx) =>
        `This verification code was requested using ${agent(ctx)}. If you didn't request the verification code, you can safely ignore this email.`,
      undefined,
    ),
    {
      id: "appwrite.recovery",
      source: "appwrite",
      labels: RESET,
      format: "html",
      draft: (ctx) => ({
        subject: `Password Reset for ${ctx.brand}`,
        preheader: `Reset your ${ctx.brand} password using the link.`,
        greeting: `Hello ${ctx.user.first},`,
        blocks: [
          text(`Follow this link to reset your ${ctx.brand} password.`),
          link(linkUrl(ctx, "reset-password"), "Reset password"),
          ...sign(ctx),
        ],
      }),
    },
  ];
}

/** Account notices from the same templates that grant nothing. */
const TEMPLATE_NEGATIVES: readonly Family[] = [
  {
    id: "devise.password_change",
    source: "devise",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: "Password Changed",
      greeting: `Hello ${ctx.user.email}!`,
      blocks: [text("We're contacting you to notify you that your password has been changed.")],
    }),
  },
  {
    id: "devise.email_changed",
    source: "devise",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: "Email Changed",
      greeting: `Hello ${ctx.user.email}!`,
      blocks: [
        text(
          ctx.rng.chance(0.5)
            ? `We're contacting you to notify you that your email is being changed to ${ctx.otherEmail()}.`
            : `We're contacting you to notify you that your email has been changed to ${ctx.otherEmail()}.`,
        ),
      ],
    }),
  },
  {
    id: "keycloak.event_login_error",
    source: "keycloak",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: "Login error",
      blocks: [
        text(
          `A failed login attempt was detected to your account on ${ctx.when()} from ${ctx.ip()}. If this was not you, please contact an administrator.`,
        ),
      ],
    }),
  },
  {
    id: "keycloak.event_update_password",
    source: "keycloak",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: "Update password",
      blocks: [
        text(
          `Your password was changed on ${ctx.when()} from ${ctx.ip()}. If this was not you, please contact an administrator.`,
        ),
      ],
    }),
  },
  {
    id: "keycloak.event_update_totp",
    source: "keycloak",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: "Update OTP",
      blocks: [
        text(
          `OTP was updated for your account on ${ctx.when()} from ${ctx.ip()}. If this was not you, please contact an administrator.`,
        ),
      ],
    }),
  },
  {
    id: "supabase.password_changed",
    source: "supabase",
    labels: NONE,
    format: "html",
    draft: () => ({
      subject: "Your password was changed",
      blocks: [
        heading("Your password was changed"),
        text("The password for your account was recently changed."),
        text(
          "If you didn't make this change, reset your password and contact support immediately.",
        ),
      ],
    }),
  },
  {
    id: "supabase.email_changed",
    source: "supabase",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: "Your email address was changed",
      blocks: [
        heading("Your email address was changed"),
        text(
          `The email address for your account was changed from ${ctx.otherEmail()} to ${ctx.user.email}.`,
        ),
        text("If you didn't make this change, contact support immediately."),
      ],
    }),
  },
  {
    id: "supabase.identity_linked",
    source: "supabase",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: "A new sign-in method was linked to your account",
      blocks: [
        heading("A new sign-in method was linked"),
        text(
          `Your ${linkedProvider(ctx)} account was linked as a new sign-in method for ${ctx.user.email}.`,
        ),
        text("If you didn't make this change, contact support immediately."),
      ],
    }),
  },
  {
    id: "supabase.mfa_factor_enrolled",
    source: "supabase",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: "A new verification method was added to your account",
      blocks: [
        heading("A new verification method was added"),
        text(
          `Sign-in verification method ${ctx.rng.pick(["totp", "phone", "webauthn"])} was added to your account.`,
        ),
        text("If you didn't make this change, contact support immediately."),
      ],
    }),
  },
  {
    id: "pocketbase.login_alert",
    source: "pocketbase",
    labels: NONE,
    format: "html",
    draft: (ctx) => {
      const d = ctx.device();
      return {
        subject: "Login from a new location",
        greeting: "Hello,",
        blocks: [
          text(`We noticed a login to your ${ctx.brand} account from a new location:`),
          text(`${d.client} on ${d.os}, ${ctx.ip()}`),
          text(
            `If this wasn't you, you should immediately change your ${ctx.brand} account password to revoke access from all other locations.`,
          ),
          text("If this was you, you may disregard this email."),
          text("Thanks,"),
          text(`${ctx.brand} team`),
        ],
      };
    },
  },
  {
    id: "appwrite.session_alert",
    source: "appwrite",
    labels: NONE,
    format: "html",
    draft: (ctx) => {
      const d = ctx.device();
      return {
        subject: `Security alert: new session on your ${ctx.brand} account`,
        greeting: `Hello ${ctx.user.first},`,
        blocks: [
          text(`A new session has been created on your ${ctx.brand} account, on ${ctx.when()}.`),
          text("Here are the details of the new session:"),
          text(
            `Device: ${d.client} on ${d.os}\nIP Address: ${ctx.ip()}\nCountry: ${ctx.rng.pick(["Germany", "Brazil", "Canada", "Japan"])}`,
          ),
          text("Thanks,"),
          text(`${ctx.brand} team`),
        ],
      };
    },
  },
  {
    id: "appwrite.invitation",
    source: "appwrite",
    labels: NONE,
    format: "html",
    draft: (ctx) => {
      const team = ctx.rng.pick(["Design", "Platform", "Growth", "Support"]);
      const owner = ctx.otherEmail();
      return {
        subject: `Invitation to ${team} Team at ${ctx.brand}`,
        preheader: `${owner} invited you to join ${team} at ${ctx.brand}`,
        greeting: `Hello ${ctx.user.first},`,
        blocks: [
          text(
            `This mail was sent to you because ${owner} invited you to become a member of the ${team} team at ${ctx.brand}.`,
          ),
          link(
            `${ctx.appUrl}/invite?teamId=${ctx.hex(20)}&membershipId=${ctx.hex(20)}`,
            `Accept invite to ${team}`,
          ),
          text("Thanks,"),
          text(`${ctx.brand} team`),
        ],
      };
    },
  },
  {
    id: "appwrite.data_export_ready",
    source: "appwrite",
    labels: NONE,
    format: "html",
    draft: (ctx) => {
      const type = ctx.rng.pick(["CSV", "JSON", "database"]);
      return {
        subject: `Your ${type} export is ready`,
        preheader: "Your data export has been completed successfully.",
        greeting: `Hello ${ctx.user.first},`,
        blocks: [
          text(
            `Your ${type} export is ready to download. Click the button below to download your data export.`,
          ),
          link(`${ctx.appUrl}/exports/${ctx.hex(24)}/download`, `Download ${type}`),
          text("Thanks,"),
          text("Appwrite team"),
        ],
      };
    },
  },
  {
    id: "gitea.register_notify",
    source: "gitea",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: `Welcome to ${ctx.brand}`,
      blocks: [
        heading(`${ctx.user.username}, welcome to ${ctx.brand}`),
        text(`Hi ${ctx.user.username},`),
        text(`This is your registration confirmation email for ${ctx.brand}!`),
        text(`You can now log in via username: ${ctx.user.username}.`),
      ],
    }),
  },
];

/**
 * Ordinary transactional mail written for this corpus. Each one carries a
 * near-miss signal: numbers that look like codes, words like "confirm",
 * "verify", "password" or "sign in", or links with opaque tokens.
 */
const HEEL_NEGATIVES: readonly Family[] = [
  {
    id: "heel.order_confirmation",
    source: "heel",
    labels: NONE,
    format: "html",
    draft: (ctx) => {
      const order = String(ctx.rng.int(100_000, 9_999_999));
      return {
        subject: `Your ${ctx.brand} order #${order} is confirmed`,
        blocks: [
          heading("Thanks for your order!"),
          text(
            `We've received order #${order} and will email you again when it ships. Estimated delivery: ${ctx.rng.int(2, 7)} business days.`,
          ),
          text(
            `Items: ${ctx.rng.int(1, 4)} × ${ctx.rng.pick(["Wool socks", "Ceramic mug", "Notebook", "USB-C cable"])} — $${ctx.rng.int(9, 120)}.${ctx.rng.int(10, 99)}`,
          ),
          link(`${ctx.appUrl}/orders/${order}?ref=email&t=${ctx.token(24)}`, "View order"),
        ],
      };
    },
  },
  {
    id: "heel.shipping_notice",
    source: "heel",
    labels: NONE,
    format: "html",
    draft: (ctx) => {
      const tracking = `1Z${ctx.token(16, "0123456789ABCDEFGHJKLMNPRSTUVWXYZ")}`;
      return {
        subject: "Your package is on its way",
        blocks: [
          text(`Good news — your ${ctx.brand} order has shipped.`),
          text(`Tracking number: ${tracking}`),
          link(`https://track.${ctx.host}/${tracking}`, "Track package"),
          text(`Delivery code for the parcel locker: ${ctx.rng.int(1000, 9999)}`),
        ],
      };
    },
  },
  {
    id: "heel.invoice",
    source: "heel",
    labels: NONE,
    format: "html",
    draft: (ctx) => {
      const invoice = `INV-${ctx.rng.int(2026, 2026)}-${String(ctx.rng.int(1, 99_999)).padStart(5, "0")}`;
      return {
        subject: `Receipt for invoice ${invoice}`,
        blocks: [
          text(
            `Your payment of $${ctx.rng.int(5, 900)}.00 to ${ctx.brand} was successful. Card ending in ${ctx.rng.int(1000, 9999)}.`,
          ),
          text(`Invoice number: ${invoice}`),
          link(`${ctx.appUrl}/billing/invoices/${ctx.hex(24)}.pdf`, "Download PDF"),
          text("Questions? Reply to this email and our billing team will help."),
        ],
      };
    },
  },
  {
    id: "heel.meeting_invite",
    source: "heel",
    labels: NONE,
    format: "text",
    draft: (ctx) => {
      const id = `${ctx.rng.int(100, 999)} ${ctx.rng.int(1000, 9999)} ${ctx.rng.int(1000, 9999)}`;
      return {
        subject: `Invitation: ${ctx.rng.pick(["Weekly sync", "Design review", "Quarterly planning", "1:1"])} @ ${ctx.when()}`,
        blocks: [
          text(`${ctx.otherEmail()} has invited you to a meeting.`),
          text(
            `Join the video call: https://meet.${ctx.host}/j/${ctx.rng.int(10_000_000, 99_999_999)}`,
          ),
          text(`Meeting ID: ${id}\nPasscode: ${ctx.rng.int(100_000, 999_999)}`),
          text("Dial in: +1 555 0100, then enter the meeting ID followed by #."),
        ],
      };
    },
  },
  {
    id: "heel.newsletter",
    source: "heel",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: `${ctx.brand} monthly: ${ctx.rng.pick(["what we shipped", "new features", "tips for teams", "our roadmap"])}`,
      blocks: [
        heading(`What's new at ${ctx.brand}`),
        text(
          "This month we shipped faster search, a redesigned dashboard and dark mode. Thanks to everyone who sent feedback.",
        ),
        link(`https://${ctx.host}/blog/${ctx.token(8, LOWER_ALNUM)}`, "Read the post"),
        text("Tip: turn on two-factor authentication in Settings to keep your account secure."),
        link(`https://${ctx.host}/unsubscribe?token=${ctx.token(40)}`, "Unsubscribe"),
      ],
    }),
  },
  {
    id: "heel.two_factor_enabled",
    source: "heel",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: "Two-factor authentication is now on",
      blocks: [
        text(
          `You turned on two-factor authentication for your ${ctx.brand} account on ${ctx.when()}. From now on we'll ask for a code from your authenticator app when you sign in.`,
        ),
        text(
          "Keep your recovery codes somewhere safe. If you didn't make this change, contact support.",
        ),
      ],
    }),
  },
  {
    id: "heel.subscription_renewal",
    source: "heel",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: `Your ${ctx.brand} subscription renews soon`,
      blocks: [
        text(
          `Your ${ctx.rng.pick(["Pro", "Team", "Plus"])} plan renews on ${ctx.when()} for $${ctx.rng.int(5, 60)}.00. No action is needed.`,
        ),
        text(
          "To change plans or update your payment method, sign in to your account and open Billing.",
        ),
        link(`${ctx.appUrl}/settings/billing`, "Manage subscription"),
      ],
    }),
  },
  {
    id: "heel.support_ticket",
    source: "heel",
    labels: NONE,
    format: "text",
    draft: (ctx) => {
      const ticket = ctx.rng.int(10_000, 999_999);
      return {
        subject: `[${ctx.brand} Support] Re: ticket #${ticket}`,
        blocks: [
          text(`Hi ${ctx.user.first},`),
          text(
            "Thanks for your patience. We looked into the export issue and confirmed it was caused by a timeout on our side. It's fixed now — please try again and let us know.",
          ),
          text(`Reply above this line to add a comment to ticket #${ticket}.`),
        ],
      };
    },
  },
  {
    id: "heel.flight_booking",
    source: "heel",
    labels: NONE,
    format: "html",
    draft: (ctx) => {
      const pnr = ctx.token(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
      return {
        subject: `Booking confirmed: ${ctx.rng.pick(["LIS", "BER", "SFO", "NRT"])} → ${ctx.rng.pick(["AMS", "JFK", "SIN", "MEX"])}`,
        blocks: [
          text(`Your trip is booked. Confirmation code: ${pnr}`),
          text(
            `Departs ${ctx.when()}. Check in online 24 hours before departure using your confirmation code and last name.`,
          ),
          link(`https://${ctx.host}/trips/${pnr}`, "Manage booking"),
        ],
      };
    },
  },
  {
    id: "heel.password_tips",
    source: "heel",
    labels: NONE,
    format: "html",
    draft: (ctx) => ({
      subject: `${ctx.rng.pick(["5", "7", "3"])} ways to keep your ${ctx.brand} account safe`,
      blocks: [
        text(
          "Use a password manager and a unique password for every site. Never share a verification code with anyone — our staff will never ask for it.",
        ),
        text("Turn on passkeys for faster, phishing-resistant sign-in."),
        link(`https://${ctx.host}/security`, "Read our security guide"),
      ],
    }),
  },
  {
    id: "heel.appointment_reminder",
    source: "heel",
    labels: NONE,
    format: "text",
    draft: (ctx) => ({
      subject: `Reminder: your appointment on ${ctx.when()}`,
      blocks: [
        text(
          `This is a reminder of your appointment with ${ctx.brand}. Please arrive 10 minutes early and bring a photo ID.`,
        ),
        text(
          `To confirm, reply YES. To reschedule, visit ${ctx.appUrl}/appointments/${ctx.rng.int(10_000, 99_999)}.`,
        ),
      ],
    }),
  },
  {
    id: "heel.pull_request_notification",
    source: "heel",
    labels: NONE,
    format: "text",
    draft: (ctx) => {
      const n = ctx.rng.int(10, 9999);
      return {
        subject: `Re: [${ctx.brand.toLowerCase().replace(/\s+/g, "-")}/api] Fix token refresh race (PR #${n})`,
        blocks: [
          text(
            `@${ctx.user.username} approved these changes. The refresh token is now rotated before the access token expires, and the retry uses the new credential.`,
          ),
          text(
            `View it on the web: https://git.${ctx.host}/api/pull/${n}#pullrequestreview-${ctx.rng.int(1e6, 9e6)}`,
          ),
          text("You are receiving this because you were mentioned."),
        ],
      };
    },
  },
];

export const FAMILIES: readonly Family[] = [...POSITIVES, ...TEMPLATE_NEGATIVES, ...HEEL_NEGATIVES];
