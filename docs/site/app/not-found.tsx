import { HomeLayout } from 'fumadocs-ui/layouts/home';
import Link from 'next/link';
import { baseOptions } from '@/lib/layout.shared';

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="flex flex-1 flex-col items-center justify-center px-5 py-32 text-center">
        <pre className="text-left font-mono text-xs leading-[1.25] text-neutral-500">
          {String.raw`   / \__
  (    @\___
  /         O
 /   (_____/
/_____/   U`}
        </pre>
        <h1 className="mt-6 text-4xl font-semibold tracking-[-0.04em]">denied: no such page</h1>
        <p className="mt-3 text-neutral-600 dark:text-neutral-400">
          No rule matched, so heel sat this one out.
        </p>
        <div className="mt-8 flex gap-5 text-sm font-medium">
          <Link href="/" className="underline underline-offset-4">
            home
          </Link>
          <Link href="/docs" className="underline underline-offset-4">
            docs
          </Link>
        </div>
      </main>
    </HomeLayout>
  );
}
