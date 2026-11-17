import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withinVerifiedDeposits } from '../schemePurchasePolicy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const backend = readFileSync(path.join(root, 'jewel-backend/server.js'), 'utf8');
const admin = readFileSync(path.join(root, 'jewel-admin/src/components/AdminPanel.jsx'), 'utf8');
const home = readFileSync(path.join(root, 'jewel-customer/src/Home.jsx'), 'utf8');
const slider = readFileSync(path.join(root, 'jewel-customer/src/components/HeroSlider.jsx'), 'utf8');

test('purchase value must be above zero and no higher than deposits', () => {
  assert.equal(withinVerifiedDeposits(60000, 60000), true);
  assert.equal(withinVerifiedDeposits(50000, 60000), true);
  for (const value of [60000.01, 0, -1, Infinity, NaN, null, undefined]) {
    assert.equal(withinVerifiedDeposits(value, 60000), false);
  }
  assert.equal(withinVerifiedDeposits(1, 0), false);
});

test('server enforces verified purchase cap at redemption', () => {
  assert.match(backend, /withinVerifiedDeposits\(purchaseAmount, verifiedDeposits\)/);
  assert.match(backend, /purchaseAmount,\s*makingCharges/);
  assert.match(admin, /purchaseAmount,\s*standardMakingCharges: charges/);
});

test('archived customer directory is separate and admin protected', () => {
  assert.match(backend, /const CustomerContact/);
  assert.match(backend, /app\.get\('\/api\/admin\/customer-contacts', adminAuth/);
  assert.match(backend, /app\.delete\('\/api\/admin\/customer-contacts\/:id', adminAuth/);
  assert.match(backend, /CustomerContact\.updateOne/);
  assert.match(backend, /await BenefitClaim\.deleteMany/);
});

test('news/offer slide management requires admin authentication', () => {
  assert.match(backend, /app\.post\('\/api\/admin\/site\/announcements', adminAuth/);
  assert.match(backend, /app\.get\('\/api\/site\/announcements', wrap/);
});

test('carousel has five built-in slides and can loop without image-ready blocking', () => {
  assert.match(home, /title: 'स्वर्ण बचत योजना'/);
  assert.match(home, /title: 'No Making Charge\\non Jewellery'/);
  assert.match(slider, /\(index \+ 1\) % slides\.length/);
  assert.doesNotMatch(slider, /if \(ready\[next\]\)/);
});

test('first three slide actions show all collections', () => {
  assert.match(home, /else openCollection\('All'\)/);
});
