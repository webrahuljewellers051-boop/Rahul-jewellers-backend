import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIN_JEWELLERY_CATEGORIES,
  mainCategoryName,
  isProtectedRoot,
  canMoveBetweenRoots
} from '../categoryPolicy.js';

test('only five main categories are available', () => {
  assert.deepEqual(MAIN_JEWELLERY_CATEGORIES, [
    'Gold', 'Polki', 'Kundan', 'Diamond', 'Silver'
  ]);
});

test('root names are normalized without accepting arbitrary categories', () => {
  assert.equal(mainCategoryName(' gOlD '), 'Gold');
  assert.equal(mainCategoryName('diamond'), 'Diamond');
  assert.equal(mainCategoryName('fashion'), null);
});

test('main roots are permanent', () => {
  assert.equal(isProtectedRoot({name:'Gold',parentCategory:null}), true);
  assert.equal(isProtectedRoot({name:'Silver',parentCategory:null}), true);
  assert.equal(isProtectedRoot({name:'Haar',parentCategory:'parent-id'}), false);
  assert.equal(isProtectedRoot({name:'Gold',parentCategory:'parent-id'}), false);
});

test('Gold subfolders cannot move into Diamond or Silver', () => {
  assert.equal(canMoveBetweenRoots('Gold','Diamond'), false);
  assert.equal(canMoveBetweenRoots('Gold','Silver'), false);
});

test('same-root subfolder moves are permitted', () => {
  assert.equal(canMoveBetweenRoots('Gold','Gold'), true);
  assert.equal(canMoveBetweenRoots('Kundan','Kundan'), true);
});

test('legacy folders may migrate into a known main root', () => {
  assert.equal(canMoveBetweenRoots('Old Jewellery','Gold'), true);
  assert.equal(canMoveBetweenRoots('Old Jewellery','Unknown'), false);
});
