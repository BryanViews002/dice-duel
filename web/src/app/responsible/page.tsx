import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { PlayControls } from '@/components/PlayControls';

export const metadata = { title: 'Responsible play · Dice Duel' };
export const dynamic = 'force-dynamic';

export default async function ResponsiblePlayPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/');

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="display text-[30px] sm:text-[42px]">Responsible play</h1>
      <p className="mt-2.5 max-w-xl text-[14px] leading-relaxed text-ivory-dim/70">
        Dice Duel is a 50/50 game with a house rake, which means over enough hands
        the maths favours the house, not you. Play with money you can afford to
        lose, and use the controls below if that stops being true.
      </p>

      <div className="mt-8">
        <PlayControls />
      </div>

      <div className="surface mt-8 p-6">
        <div className="eyebrow mb-3">Getting help</div>
        <p className="text-[13.5px] leading-relaxed text-ivory-dim/75">
          If gambling is affecting your money, work, or relationships, please talk
          to someone. In Nigeria you can contact the{' '}
          <strong>Nigeria Suicide Prevention Initiative counselling line</strong> on{' '}
          <a href="tel:+2348062106493" className="text-brass-300 underline-offset-4 hover:underline">
            0806 210 6493
          </a>
          , and international support is available through{' '}
          <a href="https://www.gamblingtherapy.org" target="_blank" rel="noreferrer"
             className="text-brass-300 underline-offset-4 hover:underline">
            Gambling Therapy
          </a>{' '}
          and{' '}
          <a href="https://www.gamblersanonymous.org" target="_blank" rel="noreferrer"
             className="text-brass-300 underline-offset-4 hover:underline">
            Gamblers Anonymous
          </a>
          .
        </p>
        <p className="mt-4 text-[12.5px] leading-relaxed text-ivory-dim/50">
          You must be 18 or over to play. If someone under 18 has access to your
          account, close it and contact us.
        </p>
      </div>
    </div>
  );
}
