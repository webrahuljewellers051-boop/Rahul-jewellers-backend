
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readFileSync,
  existsSync
} from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const testsDir = path.dirname(currentFile);

const backendDir = path.resolve(testsDir, '..');
const projectDir = path.resolve(backendDir, '..');

const serverPath = path.join(
  backendDir,
  'server.js'
);

const schemePath = path.join(
  backendDir,
  'schemeLogic.js'
);

const adminPath = path.join(
  projectDir,
  'jewel-admin',
  'src',
  'components',
  'AdminPanel.jsx'
);

const directoryPath = path.join(
  projectDir,
  'jewel-admin',
  'src',
  'components',
  'AdminCustomerDirectory.jsx'
);

const customerPath = path.join(
  projectDir,
  'jewel-customer',
  'src',
  'Home.jsx'
);

const supportPath = path.join(
  projectDir,
  'jewel-customer',
  'src',
  'components',
  'SupportChatWidget.jsx'
);

console.log('\n================================');
console.log(' RAHUL JEWELLERS SHIVGANJ');
console.log(' INTEGRATION ROUTE TEST');
console.log('================================\n');

function readRequiredFile(filename) {
  assert.ok(
    existsSync(filename),
    `Missing file: ${filename}`
  );

  return readFileSync(filename, 'utf8');
}

const serverSource = readRequiredFile(
  serverPath
);

const routeRegex =
  /app\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2\s*,/g;

const routes = [];

for (
  const match of serverSource.matchAll(routeRegex)
) {
  routes.push({
    method: match[1].toUpperCase(),
    path: match[3],
    index: match.index,
    end: match.index + match[0].length
  });
}

function findRoute(method, routePath) {
  return routes.find(
    route =>
      route.method === method &&
      route.path === routePath
  );
}

function requireRoute(method, routePath) {
  assert.ok(
    findRoute(method, routePath),
    `Missing backend route: ${method} ${routePath}`
  );
}

function checkAuthentication(
  method,
  routePath,
  middleware
) {
  const route = findRoute(method, routePath);

  assert.ok(
    route,
    `Missing route: ${method} ${routePath}`
  );

  const afterRoute = serverSource.slice(
    route.end,
    route.end + 200
  );

  assert.ok(
    new RegExp(`\\b${middleware}\\b`).test(
      afterRoute
    ),
    `${method} ${routePath} may be missing ${middleware}`
  );
}

// ------------------------------------
// 1. PROJECT FILES
// ------------------------------------

test('Backend schemeLogic.js exists', () => {
  assert.ok(existsSync(schemePath));
});

test('AdminPanel.jsx exists', () => {
  assert.ok(existsSync(adminPath));
});

test('AdminCustomerDirectory.jsx exists', () => {
  assert.ok(existsSync(directoryPath));
});

test('Customer Home.jsx exists', () => {
  assert.ok(existsSync(customerPath));
});

test('SupportChatWidget.jsx exists', () => {
  assert.ok(existsSync(supportPath));
});

// ------------------------------------
// 2. PUBLIC WEBSITE ROUTES
// ------------------------------------

const publicRoutes = [
  ['GET', '/health'],
  ['GET', '/api/products'],
  ['GET', '/api/products/:slugOrId'],
  ['GET', '/api/categories'],
  ['GET', '/api/store/settings'],
  ['GET', '/api/gold-rate']
];

for (const [method, routePath] of publicRoutes) {
  test(
    `Public API: ${method} ${routePath}`,
    () => requireRoute(method, routePath)
  );
}

// ------------------------------------
// 3. CUSTOMER ROUTES
// ------------------------------------

const customerRoutes = [
  ['POST', '/api/customer/register'],
  ['POST', '/api/customer/login'],
  ['POST', '/api/customer/join-scheme'],
  ['POST', '/api/customer/pay-installment'],
  ['GET', '/api/customer/payment-requests'],
  ['POST', '/api/customer/redeem-scheme']
];

for (const [method, routePath] of customerRoutes) {
  test(
    `Customer API: ${method} ${routePath}`,
    () => requireRoute(method, routePath)
  );
}

// ------------------------------------
// 4. ADMIN ROUTES
// ------------------------------------

const adminRoutes = [
  ['GET', '/api/admin/customers'],
  ['POST', '/api/admin/create-customer'],
  ['POST', '/api/admin/products'],
  ['POST', '/api/admin/categories'],
  ['GET', '/api/admin/payment-requests'],
  ['GET', '/api/admin/pending-payments'],
  ['POST', '/api/admin/approve-payment'],
  ['POST', '/api/admin/reject-payment'],
  ['POST', '/api/admin/verify-payment'],
  ['POST', '/api/admin/manual-passbook-update'],
  ['POST', '/api/admin/manual-passbook-bulk'],
  ['PUT', '/api/store/settings'],
  ['PUT', '/api/admin/gold-rate']
];

for (const [method, routePath] of adminRoutes) {
  test(
    `Admin API: ${method} ${routePath}`,
    () => requireRoute(method, routePath)
  );
}

// ------------------------------------
// 5. ADMIN AUTHENTICATION
// ------------------------------------

const protectedAdminRoutes = [
  ['GET', '/api/admin/customers'],
  ['POST', '/api/admin/create-customer'],
  ['POST', '/api/admin/products'],
  ['POST', '/api/admin/categories'],
  ['GET', '/api/admin/payment-requests'],
  ['POST', '/api/admin/approve-payment'],
  ['POST', '/api/admin/manual-passbook-update'],
  ['PUT', '/api/store/settings'],
  ['PUT', '/api/admin/gold-rate']
];

for (
  const [method, routePath]
  of protectedAdminRoutes
) {
  test(
    `Admin Auth: ${method} ${routePath}`,
    () => {
      checkAuthentication(
        method,
        routePath,
        'adminAuth'
      );
    }
  );
}

// ------------------------------------
// 6. CUSTOMER AUTHENTICATION
// ------------------------------------

const protectedCustomerRoutes = [
  ['POST', '/api/customer/join-scheme'],
  ['POST', '/api/customer/pay-installment'],
  ['GET', '/api/customer/payment-requests'],
  ['POST', '/api/customer/redeem-scheme']
];

for (
  const [method, routePath]
  of protectedCustomerRoutes
) {
  test(
    `Customer Auth: ${method} ${routePath}`,
    () => {
      checkAuthentication(
        method,
        routePath,
        'customerAuth'
      );
    }
  );
}

// ------------------------------------
// 7. PRODUCT AND CATEGORY EDITING
// ------------------------------------

test('Product update route exists', () => {
  const found = routes.some(route =>
    ['PUT', 'PATCH'].includes(route.method) &&
    /^\/api\/admin\/products\/:/.test(route.path)
  );

  assert.ok(
    found,
    'Missing product edit/update API'
  );
});

test('Category update route exists', () => {
  const found = routes.some(route =>
    ['PUT', 'PATCH'].includes(route.method) &&
    /^\/api\/admin\/categories\/:/.test(route.path)
  );

  assert.ok(
    found,
    'Missing category edit/update API'
  );
});

// ------------------------------------
// 8. SCHEME SOURCE CHECKS
// ------------------------------------

test('Backend supports multiple installment numbers', () => {
  assert.match(
    serverSource,
    /\bmonthNums\b/,
    'Multiple installment payment handling not found'
  );
});

test('Backend contains scheme benefit logic', () => {
  assert.match(
    serverSource,
    /schemeBenefitDate|benefitDate|benefitStatus/,
    'Scheme benefit logic not found'
  );
});

test('Backend contains contact number configuration', () => {
  assert.match(
    serverSource,
    /contactNumbers/,
    'Store contact number configuration not found'
  );
});

// ------------------------------------
// 9. OPTIONAL FEATURE REPORT
// ------------------------------------

test('Report additional benefit claim routes', () => {
  const found = routes.filter(route =>
    /claim|benefit/i.test(route.path)
  );

  if (found.length === 0) {
    console.warn(
      'WARNING: No separate benefit claim route detected.'
    );
  } else {
    console.log(
      '\nBenefit-related routes:'
    );

    found.forEach(route => {
      console.log(
        `${route.method} ${route.path}`
      );
    });
  }
});

// ------------------------------------
// 10. FINAL SUMMARY
// ------------------------------------

test('Backend route inventory is not empty', () => {
  assert.ok(
    routes.length > 0,
    'No Express routes detected'
  );

  console.log(
    `\nTotal backend routes detected: ${routes.length}`
  );

  console.log(
    'This is a READ-ONLY source-code test.'
  );

  console.log(
    'No MongoDB records or payments were changed.'
  );
});
