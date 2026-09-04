import { LegalPage } from '@/components/LegalPage';

export const metadata = { title: 'Complaints · Dice Duel' };

export default function ComplaintsPage() {
  return (
    <LegalPage title="Complaints" updated="4 September 2026">
      <h2>Before you complain about a result</h2>
      <p>
        Every finished match can be checked by you, not just by us. Go to{' '}
        <strong>/verify</strong>, paste the match id from your history, and your own
        browser will recompute every die from the revealed seed. If the dice do not
        reproduce, that is a serious fault and we want to hear about it immediately.
      </p>

      <h2>How to raise a complaint</h2>
      <p>Contact us with:</p>
      <ul>
        <li>your display name and the email on your account;</li>
        <li>the match id, payout reference or deposit reference involved;</li>
        <li>what happened, and what you would like us to do.</li>
      </ul>
      <p>
        <strong>
          Replace this line with your real support email address before launch.
        </strong>
      </p>

      <h2>What happens next</h2>
      <ul>
        <li>We acknowledge within <strong>2 working days</strong>.</li>
        <li>
          We aim to resolve within <strong>8 weeks</strong>, and will explain any
          delay.
        </li>
        <li>You get our decision in writing, with our reasoning.</li>
      </ul>

      <h2>If you are not satisfied</h2>
      <p>
        You can escalate to our licensing regulator.{' '}
        <strong>
          Add your regulator&apos;s name and contact details here.
        </strong>{' '}
        Licence conditions normally require these to be published, and a complaints
        page without them is usually non-compliant.
      </p>

      <h2>Payout delays</h2>
      <p>
        Withdrawals are currently sent by hand, so they are not instant. Your funds
        are reserved as soon as you request a payout. If one has been pending
        unusually long, contact us with the reference shown on your wallet page
        rather than requesting it again — a second request is blocked by design, so
        that a double payment cannot happen.
      </p>
    </LegalPage>
  );
}
