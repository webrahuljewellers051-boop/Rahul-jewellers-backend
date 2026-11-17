import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validOptionalCustomerEmail } from '../customerEmailPolicy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => readFileSync(path.join(root, p), 'utf8');
const backend = read('jewel-backend/server.js');
const home = read('jewel-customer/src/Home.jsx');
const login = read('jewel-customer/src/components/loginmodal.jsx');
const profile = read('jewel-customer/src/components/CustomerProfileModal.jsx');
const admin = read('jewel-admin/src/components/AdminCustomerDirectory.jsx');

test('blank, missing and correctly formatted customer emails are allowed', () => {
  for (const value of [undefined, null, '', '   ', 'a@example.com', '  PERSON@Example.COM  ']) {
    assert.equal(validOptionalCustomerEmail(value), true);
  }
});

test('invalid nonempty customer emails are rejected', () => {
  for (const value of ['invalid', 'a@', '@example.com', 'a b@example.com', 'a@example', 'a@' + 'b'.repeat(255) + '.com']) {
    assert.equal(validOptionalCustomerEmail(value), false);
  }
});

test('registration, profile edit and admin creation use optional email policy', () => {
  assert.match(backend, /validOptionalCustomerEmail\(email\)/);
  assert.equal((backend.match(/validOptionalCustomerEmail\(email\)/g) || []).length, 4);
  assert.doesNotMatch(backend, /Add a valid email to your profile before joining/);
  assert.doesNotMatch(home, /Please add your email in My Profile before joining/);
  assert.match(login, /Email Address \(Optional\)/);
  assert.match(profile, /Email Address \(Optional\)/);
  assert.match(admin, /Email Address \(Optional\)/);
});

test('admin OTP login is not changed by optional customer email', () => {
  assert.match(backend, /email !== ADMIN_EMAIL/);
  assert.match(backend, /app\.post\('\/api\/client\/send-email-otp'/);
});
