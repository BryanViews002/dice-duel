import { LegalPage } from '@/components/LegalPage';

export const metadata = { title: 'Terms · Dice Duel' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="4 September 2026">
      <h2>1. Who can play</h2>
      <p>
        You must be 18 or over and legally permitted to gamble where you live. We
        may ask you to verify your age and identity at any time, and may hold a
        payout until you do. Accounts found to belong to under-18s are closed and
        stakes returned.
      </p>

      <h2>2. The game</h2>
      <p>
        Each player rolls two dice. Your score is the number of sixes you roll. The
        higher count wins the pot. An equal count is a tie and the round is
        replayed. The non-six faces are irrelevant.
      </p>
      <p>
        Both players stake the same amount before any die is thrown. The winner
        receives the pot less the rake, which is shown to you before you commit.
        Stakes run from ₦1,000 to ₦1,000,000 per player.
      </p>

      <h2>3. Fairness</h2>
      <p>
        Every match is sealed before it starts. We generate a secret server seed,
        publish its SHA-256 hash, and reveal the seed when the match ends. Both
        players also contribute a seed of their own. Any finished match can be
        independently recomputed at <strong>/verify</strong>. We cannot change a
        result after the fact without the published hash failing to match.
      </p>

      <h2>4. Your account</h2>
      <p>
        One account per person. Keep your credentials secure; you are responsible
        for activity on your account. Do not use another person&apos;s payment
        details or bank account.
      </p>

      <h2>5. Deposits and withdrawals</h2>
      <ul>
        <li>Deposits: ₦1,000 minimum, ₦1,000,000 maximum per transaction.</li>
        <li>
          Withdrawals: ₦2,000 minimum, ₦1,000,000 maximum per transaction, and
          ₦1,000,000 in any rolling 24 hours.
        </li>
        <li>A withdrawal fee is shown before you confirm.</li>
        <li>Deposited funds must be staked before they can be withdrawn.</li>
        <li>Payouts are sent only to a bank account in your own name.</li>
      </ul>
      <p>
        Withdrawals are currently reviewed and sent by an operator, so they are not
        instant. Your funds are reserved the moment you request a payout and cannot
        be staked while it is pending.
      </p>

      <h2>6. Fair use</h2>
      <p>
        Collusion between players, multiple accounts, automated play, and any
        attempt to interfere with the game or its randomness are prohibited. We may
        void affected matches, withhold funds obtained that way, and close accounts.
      </p>

      <h2>7. Interruptions</h2>
      <p>
        If a match cannot be completed, stakes are returned to both players. Where a
        technical fault produces an incorrect result, we may correct balances, and
        we will tell you when we do.
      </p>

      <h2>8. Responsible play</h2>
      <p>
        You can set a daily deposit limit or exclude yourself at{' '}
        <strong>/responsible</strong>. Self-exclusion cannot be lifted early, by you
        or by us.
      </p>

      <h2>9. Closing an account</h2>
      <p>
        You may close your account at any time and withdraw any remaining balance,
        subject to the wagering requirement on deposited funds and to any
        verification we are required to complete.
      </p>

      <h2>10. Changes</h2>
      <p>
        Changes to these terms are published here. Continuing to play after a change
        means you accept it.
      </p>
    </LegalPage>
  );
}
