import { LegalPage } from '@/components/LegalPage';

export const metadata = { title: 'Privacy · Dice Duel' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="4 September 2026">
      <h2>What we hold</h2>
      <ul>
        <li>Your email address and the display name you choose.</li>
        <li>
          Your balance, and a record of every deposit, stake, win, loss and payout.
        </li>
        <li>
          Bank details you add for payouts: bank, account number and account name.
        </li>
        <li>
          Match history, including the dice and the seeds used to generate them.
        </li>
        <li>Messages you send in table chat.</li>
      </ul>

      <h2>What we do with it</h2>
      <p>
        We use it to run your account, settle matches, process deposits and payouts,
        meet our legal and licensing obligations, and detect fraud or collusion. We
        do not sell it.
      </p>

      <h2>Who else sees it</h2>
      <ul>
        <li><strong>Supabase</strong> hosts our database and authentication.</li>
        <li>
          <strong>Flutterwave</strong> processes deposits and receives your name,
          email and payment details.
        </li>
        <li><strong>Vercel</strong> serves the site.</li>
        <li>
          Regulators, banks or law enforcement, where we are legally required to
          disclose.
        </li>
      </ul>
      <p>
        Other players can see your display name, avatar and match results. They
        cannot see your balance, your email, or your bank details.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Financial and match records are kept for as long as gambling and
        anti-money-laundering rules require, which is generally several years after
        an account closes — even if you ask us to delete the account.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your data, ask us to correct it, or ask us to
        delete anything we are not required to keep. Use the complaints route to
        contact us.
      </p>

      <h2>Security</h2>
      <p>
        Access is enforced at the database level: a player can read only their own
        balance, bank details and payment history. Passwords are handled by our
        authentication provider and are never stored by us in readable form.
      </p>
    </LegalPage>
  );
}
