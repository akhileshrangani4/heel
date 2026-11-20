import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/'>) {
  const base = baseOptions();
  return (
    // heel-dots: one dot grid behind the whole page, the top bar included; the bar is clear
    // until you scroll, so it reads as the same surface.
    <HomeLayout {...base} nav={{ ...base.nav, transparentMode: 'top' }} className="heel-dots">
      {children}
    </HomeLayout>
  );
}
