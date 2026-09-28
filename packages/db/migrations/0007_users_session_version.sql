-- QA-108: server-side session revocation. Session cookies embed the version;
-- bumping it (logout) invalidates every outstanding session for the user.
alter table users add column if not exists session_version int not null default 1;
