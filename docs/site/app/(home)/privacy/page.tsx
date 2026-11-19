import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';
import { githubUrl } from '@/lib/shared';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What heel does with your data: it runs on your machine, and your data stays there.',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="November 19, 2026">
      <p>
        heel is open-source software that you run yourself, on your own computer or server. This
        page explains what heel does with your data, including data from Google accounts you
        connect, and what this website collects.
      </p>

      <h2>The heel software</h2>
      <ul>
        <li>
          heel runs on your machine. The accounts you connect, their credentials, your rules, and
          the record of what your agents did are stored in heel&apos;s database on that machine.
          Credentials are encrypted with a key that only your installation holds.
        </li>
        <li>
          The heel project runs no servers that receive this data. heel sends no telemetry or usage
          data to the heel project or anyone else.
        </li>
        <li>
          heel talks to the services you connect (such as GitHub, Gmail or Slack) only to make the
          calls your agents ask for and your rules allow, and to refresh their sign-ins.
        </li>
      </ul>

      <h2>Google user data</h2>
      <p>
        When you connect a Gmail or Google Calendar account, Google issues access tokens to your own
        heel installation. heel uses them only to:
      </p>
      <ul>
        <li>make the calls your AI agents request and your rules allow, such as searching mail or creating an event;</li>
        <li>check facts your rules ask about, such as whether everyone on an email was already in the thread;</li>
        <li>show you a request to approve, with exactly what it would do.</li>
      </ul>
      <p>
        Tokens are stored encrypted on your installation. heel doesn&apos;t keep copies of your mail
        or calendar. It keeps what appears in a call your agent asks to make (for example, an email
        it wants to send) in the approval and activity records on your installation, so you can
        review it. heel never sells Google user data, never uses it for advertising, and never uses
        it to train AI models.
      </p>
      <p>
        heel&apos;s use and transfer of information received from Google APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>
      <p>
        <strong>Optional hints.</strong> heel can add hints to a waiting approval request using
        TypeSafe. It&apos;s off by default. If you turn it on, heel sends TypeSafe the details of a
        call that is waiting for your approval, which can include data from a connected account,
        and nothing else. You can turn it off at any time.
      </p>
      <p>
        You can remove heel&apos;s access at any time: run <code>heel account remove</code>, and
        revoke heel in your{' '}
        <a href="https://myaccount.google.com/permissions">Google account&apos;s permissions</a>.
      </p>

      <h2>This website</h2>
      <p>
        useheel.dev uses Vercel Web Analytics to count page views. It uses no cookies and collects
        no personal information. The site has no accounts and no forms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about privacy: open an issue on <a href={githubUrl}>GitHub</a>.
      </p>
    </LegalPage>
  );
}
