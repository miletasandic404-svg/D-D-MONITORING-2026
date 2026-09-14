# Legacy migration snapshot

This directory is retained for historical Supabase import/reference purposes
only. It is not an executable migration source for this project.

The authoritative migration source is [`../../db/migrations/`](../../db/migrations/).
Run and validate migrations from that directory only. Do not run
`supabase db push` or another Supabase CLI migration workflow against this
snapshot, because it does not contain the complete current migration history.

The SQL files are preserved unchanged for reproducibility and historical
reference. New schema or RLS migrations must be added only to
`db/migrations/`.
