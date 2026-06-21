-- Add user_id column to notes table
ALTER TABLE notes ADD COLUMN user_id TEXT;

-- Backfill existing notes cannot be done safely — leave NULL for legacy rows
-- All new notes will require a user_id

-- Add index for user-based lookups
CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes (user_id);
