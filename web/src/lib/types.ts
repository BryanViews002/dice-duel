import type { RoundResult, Seat } from './game';

export type MatchStatus = 'waiting' | 'playing' | 'finished' | 'void';

export type Profile = {
  id: string;
  username: string;
  avatar_seed: string;
  balance_kobo: number;
  last_faucet_at: string | null;
  created_at: string;
};

export type PublicProfile = {
  id: string;
  username: string;
  avatar_seed: string;
  created_at: string;
};

export type Match = {
  id: string;
  stake_kobo: number;
  rake_bps: number;
  player_a: string;
  player_b: string | null;
  client_seed_a: string;
  client_seed_b: string | null;
  server_seed_hash: string;
  revealed_server_seed: string | null;
  round: number;
  turn: Seat;
  status: MatchStatus;
  roll_deadline: string | null;
  is_private: boolean;
  invite_code: string | null;
  winner: Seat | null;
  pot_kobo: number | null;
  rake_kobo: number | null;
  payout_kobo: number | null;
  created_at: string;
  finished_at: string | null;
};

export type MatchRound = {
  match_id: string;
  round_no: number;
  dice_a: number[] | null;
  dice_b: number[] | null;
  score_a: number | null;
  score_b: number | null;
  result: RoundResult | null;
  created_at: string;
};

export type ChatMessage = {
  id: number;
  match_id: string;
  player_id: string;
  body: string | null;
  emote: string | null;
  created_at: string;
};

export type PlayerStats = {
  id: string;
  username: string;
  avatar_seed: string;
  wins: number;
  losses: number;
  played: number;
  win_pct: number;
  profit_kobo: number;
  biggest_pot_kobo: number;
};

export type LedgerEntry = {
  id: number;
  player_id: string;
  match_id: string | null;
  kind: 'signup' | 'escrow' | 'payout' | 'refund' | 'rake' | 'faucet';
  amount_kobo: number;
  balance_after_kobo: number;
  created_at: string;
};

// ---------------------------------------------------------------- payments

export type BankAccount = {
  id: string;
  player_id: string;
  bank_code: string;
  bank_name: string;
  account_number: string;
  /** Resolved with the bank via Flutterwave — never typed by the user. */
  account_name: string;
  /** True only when the bank confirmed the name via the provider. */
  is_verified: boolean;
  verified_at: string | null;
  created_at: string;
};

export type DepositStatus = 'pending' | 'successful' | 'failed' | 'abandoned';

export type Deposit = {
  id: string;
  player_id: string;
  reference: string;
  amount_kobo: number;
  status: DepositStatus;
  flw_tx_id: number | null;
  flw_status: string | null;
  credited_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * 'requested' | 'review' | 'processing' are non-terminal — the money is locked
 * but the outcome is unknown. Only 'paid', 'failed' and 'reversed' are terminal,
 * and only 'failed' / 'reversed' return funds.
 */
export type PayoutStatus =
  | 'requested' | 'review' | 'processing'
  | 'paid' | 'failed' | 'reversed';

export type Withdrawal = {
  id: string;
  player_id: string;
  bank_account_id: string;
  reference: string;
  amount_kobo: number;
  fee_kobo: number;
  net_kobo: number;
  status: PayoutStatus;
  flw_transfer_id: number | null;
  flw_status: string | null;
  failure_reason: string | null;
  attempts: number;
  refunded_at: string | null;
  requested_at: string;
  sent_at: string | null;
  settled_at: string | null;
};

export type PlatformSettings = {
  min_withdrawal_kobo: number;
  max_withdrawal_kobo: number;
  withdrawal_fee_kobo: number;
  review_threshold_kobo: number;
  min_deposit_kobo: number;
  wagering_multiplier_bps: number;
  withdrawals_enabled: boolean;
  deposits_enabled: boolean;
};
