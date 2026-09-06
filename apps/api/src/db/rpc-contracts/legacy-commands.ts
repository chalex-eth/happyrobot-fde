// Compatibility command shapes. These names are dispatched in TypeScript, never sent to Twin.
export interface LegacyCommands {
  poc_book_call: {
    Args: {
      p_session_hash: string | null;
      p_action: string | null;
      p_metadata?: unknown;
    };
    Returns: unknown;
  };
  poc_call_action: {
    Args: {
      p_session_hash: string | null;
      p_action: string | null;
      p_challenge?: string | null;
      p_digest?: string | null;
      p_recipient?: string | null;
      p_metadata?: unknown;
      p_matches?: boolean | null;
    };
    Returns: unknown;
  };
  poc_finalize_call: {
    Args: {
      p_session_hash: string | null;
      p_outcome: string | null;
      p_summary: string | null;
      p_review?: unknown;
    };
    Returns: unknown;
  };
  poc_negotiate: {
    Args: {
      p_session_hash: string | null;
      p_action: string | null;
      p_load_id: string | null;
      p_revision?: number | null;
      p_listed_cents?: number | string | null;
      p_max_cents?: number | string | null;
      p_offer_id?: string | null;
      p_amount_cents?: number | string | null;
    };
    Returns: unknown;
  };
  poc_operator: {
    Args: {
      p_key: string | null;
      p_action: string | null;
      p_metadata?: unknown;
    };
    Returns: unknown;
  };
  poc_record_load_interest: {
    Args: {
      p_session_hash: string | null;
      p_load_id: string | null;
      p_callback_number: string | null;
      p_consent: boolean | null;
      p_revision: number | null;
    };
    Returns: unknown;
  };
  poc_resolve_voice: {
    Args: {
      p_run_id: string | null;
    };
    Returns: unknown;
  };
  poc_start_call: {
    Args: {
      p_id: string | null;
      p_session_hash: string | null;
      p_previous_hash?: string | null;
    };
    Returns: unknown;
  };
  poc_track_call: {
    Args: {
      p_session_hash: string | null;
      p_action: string | null;
      p_metadata?: unknown;
    };
    Returns: unknown;
  };
}
