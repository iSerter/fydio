-- =============================================================================
-- pgTAP · 012 — Limited-Use Invite Codes (T11 §9)
-- =============================================================================

begin;

select plan(29);

-- --- Tables and functions exist ----------------------------------------------

select has_table('public', 'invite_codes', 'invite_codes exists');
select has_table('public', 'invite_code_redemptions', 'invite_code_redemptions exists');
select has_function('public', 'claim_invite_code', array['text', 'uuid'], 'claim_invite_code exists');

-- --- Security & Privileges ---------------------------------------------------

select ok(
  has_function_privilege('anon', 'public.claim_invite_code(text,uuid)', 'execute') is false,
  'anon cannot execute claim_invite_code'
);

select ok(
  has_function_privilege('authenticated', 'public.claim_invite_code(text,uuid)', 'execute') is false,
  'authenticated cannot execute claim_invite_code'
);

select ok(
  has_function_privilege('service_role', 'public.claim_invite_code(text,uuid)', 'execute') is true,
  'service_role can execute claim_invite_code'
);

select ok(
  (select array_to_string(proacl, ', ') = 'postgres=X/postgres, service_role=X/postgres'
     from pg_proc
    where proname = 'claim_invite_code'),
  'claim_invite_code ACL is restricted strictly to postgres and service_role'
);

-- --- Constraints -------------------------------------------------------------

select throws_ok(
  $$ insert into public.invite_codes (code_hash, code_length, max_uses)
     values (extensions.digest('short', 'sha256'), 15, 5); $$,
  '23514'::varchar, null,
  'code_length < 16 is rejected by check constraint'
);

select throws_ok(
  $$ insert into public.invite_codes (code_hash, code_length, max_uses)
     values (extensions.digest('toolong', 'sha256'), 33, 5); $$,
  '23514'::varchar, null,
  'code_length > 32 is rejected by check constraint'
);

select throws_ok(
  $$ insert into public.invite_codes (code_hash, code_length, max_uses)
     values (extensions.digest('zero', 'sha256'), 20, 0); $$,
  '23514'::varchar, null,
  'max_uses < 1 is rejected by check constraint'
);

select throws_ok(
  $$ insert into public.invite_codes (code_hash, code_length, max_uses)
     values (extensions.digest('over', 'sha256'), 20, 1001); $$,
  '23514'::varchar, null,
  'max_uses > 1000 is rejected by check constraint'
);

select throws_ok(
  $$ insert into public.invite_codes (code_hash, code_length, max_uses, used_count)
     values (extensions.digest('badcount', 'sha256'), 20, 5, 6); $$,
  '23514'::varchar, null,
  'used_count > max_uses is rejected by check constraint'
);

-- --- Fixtures ----------------------------------------------------------------

create temporary table fx (
  u1 uuid not null,
  u2 uuid not null,
  u3 uuid not null,
  u4 uuid not null
) on commit drop;

grant select on fx to authenticated;
grant select on fx to service_role;

-- Select four distinct member profiles
insert into fx (u1, u2, u3, u4)
select p1.id, p2.id, p3.id, p4.id
  from public.profiles p1
  cross join public.profiles p2
  cross join public.profiles p3
  cross join public.profiles p4
 where p1.id <> p2.id and p1.id <> p3.id and p1.id <> p4.id
   and p2.id <> p3.id and p2.id <> p4.id and p3.id <> p4.id
   and p1.role = 'member' and p2.role = 'member' and p3.role = 'member' and p4.role = 'member'
 limit 1;

-- Insert test invite codes as postgres
insert into public.invite_codes (id, label, code_hash, code_length, max_uses)
values (
  '11111111-1111-1111-1111-111111111111',
  'batch-test',
  extensions.digest('CODEVALID1234567890', 'sha256'),
  20,
  2
);

insert into public.invite_codes (id, label, code_hash, code_length, max_uses, revoked_at)
values (
  '22222222-2222-2222-2222-222222222222',
  'batch-revoked',
  extensions.digest('CODEREVOKED12345678', 'sha256'),
  20,
  5,
  now()
);

insert into public.invite_codes (id, label, code_hash, code_length, max_uses, expires_at)
values (
  '33333333-3333-3333-3333-333333333333',
  'batch-expired',
  extensions.digest('CODEEXPIRED12345678', 'sha256'),
  20,
  5,
  now() - interval '1 hour'
);

insert into public.invite_codes (id, label, code_hash, code_length, max_uses)
values (
  '44444444-4444-4444-4444-444444444444',
  'batch-second',
  extensions.digest('CODESECOND123456789', 'sha256'),
  20,
  5
);

-- --- RLS Enforcement ---------------------------------------------------------

set local role anon;

select is(
  (select count(*)::integer from public.invite_codes),
  0,
  'anon sees 0 rows from invite_codes under RLS'
);

select is(
  (select count(*)::integer from public.invite_code_redemptions),
  0,
  'anon sees 0 rows from invite_code_redemptions under RLS'
);

select throws_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('CODEVALID1234567890', 'sha256'), 'hex'), gen_random_uuid()) $$,
  '42501'::varchar, null,
  'anon cannot call claim_invite_code'
);

reset role;

-- Non-admin authenticated user sees 0 rows
set local role authenticated;

select is(
  (select count(*)::integer from public.invite_codes),
  0,
  'non-admin authenticated member sees 0 rows from invite_codes'
);

select is(
  (select count(*)::integer from public.invite_code_redemptions),
  0,
  'non-admin authenticated member sees 0 rows from invite_code_redemptions'
);

select throws_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('CODEVALID1234567890', 'sha256'), 'hex'), gen_random_uuid()) $$,
  '42501'::varchar, null,
  'authenticated member cannot call claim_invite_code directly'
);

reset role;

-- --- Redemption Authority via service_role -----------------------------------

set local role service_role;

-- Unknown code rejected
select throws_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('NONEXISTENTCODE1234', 'sha256'), 'hex'), (select u1 from fx)) $$,
  'P0002'::varchar, null,
  'unknown code hash returns P0002 invalid code'
);

-- Revoked code rejected
select throws_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('CODEREVOKED12345678', 'sha256'), 'hex'), (select u1 from fx)) $$,
  '23514'::varchar, null,
  'revoked code is refused with 23514'
);

-- Expired code rejected
select throws_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('CODEEXPIRED12345678', 'sha256'), 'hex'), (select u1 from fx)) $$,
  '23514'::varchar, null,
  'expired code is refused with 23514'
);

-- First claim (1 of 2) succeeds
select lives_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('CODEVALID1234567890', 'sha256'), 'hex'), (select u1 from fx)) $$,
  'first claim on a 2-use code succeeds'
);

select is(
  (select used_count from public.invite_codes where id = '11111111-1111-1111-1111-111111111111'),
  1,
  'used_count incremented to 1'
);

-- Replay by same user rejected
select throws_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('CODEVALID1234567890', 'sha256'), 'hex'), (select u1 from fx)) $$,
  '23505'::varchar, null,
  'same user claiming again is refused'
);

-- Second claim (2 of 2) succeeds
select lives_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('CODEVALID1234567890', 'sha256'), 'hex'), (select u2 from fx)) $$,
  'second claim taking last slot succeeds'
);

select is(
  (select used_count from public.invite_codes where id = '11111111-1111-1111-1111-111111111111'),
  2,
  'used_count incremented to 2 (cap reached)'
);

-- Third claim on exhausted code rejected
select throws_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('CODEVALID1234567890', 'sha256'), 'hex'), (select u3 from fx)) $$,
  '23505'::varchar, null,
  'third claim on 2-use code is refused as fully claimed'
);

-- User who already redeemed code 1 cannot redeem code 2
select throws_ok(
  $$ select public.claim_invite_code(encode(extensions.digest('CODESECOND123456789', 'sha256'), 'hex'), (select u1 from fx)) $$,
  '23505'::varchar, null,
  'user who redeemed code 1 cannot redeem a second code'
);

-- Claim never changes member role to admin
select is(
  (select role from public.profiles where id = (select u1 from fx)),
  'member'::public.profile_role,
  'claim_invite_code preserves member role and never elevates to admin'
);

reset role;

select * from finish();
rollback;
