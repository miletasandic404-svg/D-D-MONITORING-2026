'use strict';

/**
 * Tests for lib/auth.js createUser() field mapping.
 *
 * Verifies that createUser() sends the correct snake_case field names
 * (organization_id, user_type) as KEYS in the signUpEmail body, NOT
 * the camelCase variants (organizationId, userType).
 *
 * Better Auth additionalFields config uses snake_case:
 *   - organization_id (input: false, type: 'string')
 *   - user_type (input: false, defaultValue: 'operator')
 *
 * Source-code analysis approach (same pattern as test/users_api.test.js)
 * — reliable in air-gapped environment where Better Auth can't connect to DB.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let authSource;

describe('lib/auth.js — createUser field mapping', () => {
  beforeEach(() => {
    const authFilePath = path.join(__dirname, '..', 'lib', 'auth.js');
    authSource = fs.readFileSync(authFilePath, 'utf-8');
  });

  test('createUser signUpEmail body uses organization_id as key', () => {
    const match = authSource.match(/auth\.api\.signUpEmail\([\s\S]*?body:\s*\{([\s\S]*?)\}\s*\)/);
    assert.ok(match, 'Should find signUpEmail body block');
    const bodyContent = match[1];

    assert.match(bodyContent, /organization_id\s*:/,
      'signUpEmail body must use organization_id as a key');
  });

  test('createUser signUpEmail body uses user_type as key', () => {
    const match = authSource.match(/auth\.api\.signUpEmail\([\s\S]*?body:\s*\{([\s\S]*?)\}\s*\)/);
    assert.ok(match, 'Should find signUpEmail body block');
    const bodyContent = match[1];

    assert.match(bodyContent, /user_type\s*:/,
      'signUpEmail body must use user_type as a key');
  });

  test('createUser signUpEmail body does NOT use organizationId as key', () => {
    const match = authSource.match(/auth\.api\.signUpEmail\([\s\S]*?body:\s*\{([\s\S]*?)\}\s*\)/);
    assert.ok(match, 'Should find signUpEmail body block');
    const bodyContent = match[1];

    assert.doesNotMatch(bodyContent, /organizationId\s*:/,
      'signUpEmail body must NOT use organizationId as a key (camelCase)');
  });

  test('createUser signUpEmail body does NOT use userType as key', () => {
    const match = authSource.match(/auth\.api\.signUpEmail\([\s\S]*?body:\s*\{([\s\S]*?)\}\s*\)/);
    assert.ok(match, 'Should find signUpEmail body block');
    const bodyContent = match[1];

    assert.doesNotMatch(bodyContent, /userType\s*:/,
      'signUpEmail body must NOT use userType as a key (camelCase)');
  });

  test('createUser defaults user_type to operator in signUpEmail body', () => {
    const match = authSource.match(/auth\.api\.signUpEmail\([\s\S]*?body:\s*\{([\s\S]*?)\}\s*\)/);
    assert.ok(match, 'Should find signUpEmail body block');
    const bodyContent = match[1];

    assert.match(bodyContent, /user_type.*operator/,
      'signUpEmail body should default user_type to operator');
  });

  test('function signature retains camelCase params (unchanged for backward compat)', () => {
    // api/users.js calls createUser with camelCase params.
    // The fix changes only the signUpEmail body field names, not the
    // function signature.
    assert.match(authSource, /organizationId.*userType/,
      'createUser signature should retain camelCase params');
  });

  test('databaseHooks.user.create.before also uses snake_case', () => {
    const hookMatch = authSource.match(/before:\s*async\s*\([^)]+\)\s*=>\s*\{[^]*?return\s*\{[^]*?data:\s*\{([^}]+)\}/);
    assert.ok(hookMatch, 'Should find databaseHooks before hook');
    const hookData = hookMatch[1];

    assert.match(hookData, /organization_id/,
      'databaseHooks should use organization_id');
    assert.match(hookData, /user_type/,
      'databaseHooks should use user_type');
  });

  test('Add Operator flow integrity: api/users.js calls createUser correctly', () => {
    // Verify that api/users.js still calls createUser with org-scoped values
    // and runs the catch-up UPDATE (safety net)
    const usersPath = path.join(__dirname, '..', 'api', 'users.js');
    const usersSource = fs.readFileSync(usersPath, 'utf-8');

    assert.match(usersSource, /await createUser\(\{[\s\S]*?organizationId: auth\.organizationId/,
      'api/users.js should pass organizationId from auth');
    assert.match(usersSource, /userType: user_type/,
      'api/users.js should pass user_type as userType');

    // The catch-up UPDATE should still exist as safety net
    assert.match(usersSource, /UPDATE users SET.*organization_id/,
      'api/users.js should still have catch-up UPDATE for organization_id');
  });
});
