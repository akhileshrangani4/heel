import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';
import { githubUrl } from '@/lib/shared';

export const metadata: Metadata = {
  title: 'Terms',
  description: 'The terms for using heel and useheel.dev.',
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms" updated="November 19, 2026">
      <p>
        heel is open-source software that you download and run yourself. These terms cover the heel
        software, the Google sign-in it includes, and this website.
      </p>

      <h2>The software</h2>
      <ul>
        <li>
          heel is licensed under the{' '}
          <a href={`${githubUrl}/blob/main/LICENSE`}>Apache License 2.0</a>. It is provided as is,
          without warranties or conditions of any kind, as the license says.
        </li>
        <li>
          You run heel, so you are responsible for your installation: where it runs, who can reach
          it, the accounts you connect, the rules you write, and what you approve. heel checks the
          calls that go through it; it can&apos;t stop an agent that holds credentials of its own.
        </li>
      </ul>

      <h2>Google sign-in</h2>
      <ul>
        <li>
          heel includes its own Google sign-in so you can connect Gmail and Google Calendar without
          setting up a Google Cloud project. Using it, you also agree to Google&apos;s{' '}
          <a href="https://policies.google.com/terms">Terms of Service</a>.
        </li>
        <li>
          The heel project may change or withdraw this sign-in, and Google may limit it. You can
          always use your own Google OAuth client instead.
        </li>
        <li>How heel handles Google user data is described in the <a href="/privacy">privacy policy</a>.</li>
      </ul>

      <h2>This website</h2>
      <p>useheel.dev is provided as is. Its content may change at any time.</p>

      <h2>Changes and contact</h2>
      <p>
        If these terms change, this page shows the new date. Questions: open an issue on{' '}
        <a href={githubUrl}>GitHub</a>.
      </p>
    </LegalPage>
  );
}
