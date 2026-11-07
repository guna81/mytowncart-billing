-- PINs are stored as salted, iterated hashes in their own table so that no
-- user listing or generic read can expose them. `users.pin` is legacy and is
-- emptied at startup once its value has been hashed (see auth::upgrade_legacy_pins).
CREATE TABLE user_pins (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash    TEXT NOT NULL
);
