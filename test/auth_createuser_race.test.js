'use strict';

/**
 * Regression test for the create-user race condition (lib/auth.js).
 *
 * The old implementation used a module-level `_createUserContext` variable
 * to pass organizationId from createUser() into the databaseHooks
 * user.create.before callback. When two createUser() calls ran
 * concurrently, the second call could overwrite `_createUserContext.organizationId`
 * before the first call's database hook fired, causing a user to be
 * created in the wrong organization.
 *
 * The fix passes organizationId and status via Better Auth's request-local
 * context (the AsyncLocalStorage-backed context available inside the hook),
 * eliminating all shared mutable state.
 *
 * Tests verify:
 * 1. No module-level mutable state exists (source-code check).
 * 2. createUser passes orgId and status as request-local top-level properties.
 * 3. The databaseHook accepts a context parameter and reads from it.
 * 4. The hook function itself is safe under concurrent calls with
 *    different contexts (extracted hook + concurrent invocation).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const authPath = path.join(__dirname, '..', 'lib', 'auth');
const authSource = fs.readFileSync(authPath + '.js', 'utf-8');

describe('lib/auth.js — createUser race condition fix', () => {
  test('no module-level mutable _createUserContext exists', () => {
    assert.doesNotMatch(authSource, /_createUserContext/,
      '_createUserContext module-level state must be removed');
  });

  test('createUser passes organizationId and status as top-level signUpEmail properties', () => {
    const signUpSection = authSource.match(/auth\.api\.signUpEmail\(\{([\s\S]*?)\}\)/);
    assert.ok(signUpSection, 'Should find signUpEmail call');
    const callContent = signUpSection[1];

    // organizationId should appear as a top-level property (after the body block)
    assert.match(callContent, /organizationId\s*,/,
      'organizationId should be a top-level property of signUpEmail call');
    assert.match(callContent, /status:\s*'invited'/,
      'status should be a top-level property of signUpEmail call');

    const bodyMatch = callContent.match(/body:\s*\{([\s\S]*?)\}/);
    assert.ok(bodyMatch, 'Should find body block');
    assert.doesNotMatch(bodyMatch[1], /organizationId|organization_id/,
      'organizationId should NOT be in the body');
    assert.doesNotMatch(bodyMatch[1], /status/,
      'status should NOT be in the body');
  });

  test('databaseHook before accepts context parameter and reads organizationId from it', () => {
    const hookSig = authSource.match(/before:\s*async\s*\(([^)]+)\)/);
    assert.ok(hookSig, 'Should find databaseHooks before hook signature');
    assert.ok(hookSig[1].includes('context'),
      'Hook should accept context as second parameter');

    assert.match(authSource, /context\?\.organizationId/,
      'Hook should read organizationId from context');
    assert.match(authSource, /context\?\.status/,
      'Hook should read status from context');
  });

  test('createUser does NOT set or clear module-level context vars', () => {
    assert.doesNotMatch(authSource, /_createUserContext\.(organizationId|status)\s*=/,
      'No module-level set or clear of _createUserContext');
  });

  test('createUser error handler does not reference _createUserContext', () => {
    const errorHandlerMatch = authSource.match(/catch\s*\(err\s*\)\s*\{([\s\S]*?)\n\s*\}/);
    assert.ok(errorHandlerMatch, 'Should find error handler');
    assert.doesNotMatch(errorHandlerMatch[1], /_createUserContext/,
      'Error handler should not reference _createUserContext');
  });

  test('concurrent hook invocations each get their own organization_id from context', async () => {
    // Extract the hook function from the source code.
    const beforeIdx = authSource.indexOf('before:');
    assert.ok(beforeIdx >= 0, 'Should find before: hook in source');

    const afterBefore = authSource.substring(beforeIdx);

    // Match the full arrow function: async (user, context) => { ... }
    // We need to capture from 'async' to the matching closing brace
    const arrowStart = afterBefore.match(/before:\s*(async\s*\([^)]+\)\s*=>\s*\{)/);
    assert.ok(arrowStart, 'Should find hook arrow function');
    const paramsAndArrow = arrowStart[1]; // "async (user, context) => {"

    // Extract just the params
    const sigMatch = arrowStart[1].match(/async\s*\(([^)]+)\)/);
    const params = sigMatch[1];
    assert.ok(params.includes('context'), 'Hook should accept context parameter');

    // Find body start (the { after =>)
    const bodyStartInSlice = arrowStart[0].lastIndexOf('{');
    let depth = 1;
    let bodyEnd = bodyStartInSlice + 1;
    while (depth > 0 && bodyEnd < afterBefore.length) {
      if (afterBefore[bodyEnd] === '{') depth++;
      if (afterBefore[bodyEnd] === '}') depth--;
      bodyEnd++;
    }

    // Build the function: async (user, context) => { return { data: {...} }; }
    const hookBody = afterBefore.substring(arrowStart.index + arrowStart[0].length - 1, bodyEnd);
    const fullHook = `async (${params}) => ${hookBody}`;
    const hookFn = eval(`(${fullHook})`);

    // Simulate two concurrent hook invocations with different contexts
    const orgA = 'org-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const orgB = 'org-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    const [resultA, resultB] = await Promise.all([
      hookFn({ email: 'userA@example.com', user_type: 'operator' }, {
        organizationId: orgA,
        status: 'invited',
      }),
      hookFn({ email: 'userB@example.com', user_type: 'operator' }, {
        organizationId: orgB,
        status: 'invited',
      }),
    ]);

    assert.equal(resultA.data.organization_id, orgA,
      'Hook A should read organizationId from its own context (not leaked from B)');
    assert.equal(resultB.data.organization_id, orgB,
      'Hook B should read organizationId from its own context (not leaked from A)');
    assert.equal(resultA.data.status, 'invited',
      'Hook A should read status from its own context');
    assert.equal(resultB.data.status, 'invited',
      'Hook B should read status from its own context');
  });

  test('hook with null context falls back gracefully', async () => {
    const beforeIdx = authSource.indexOf('before:');
    assert.ok(beforeIdx >= 0, 'Should find before: hook in source');

    const afterBefore = authSource.substring(beforeIdx);
    const arrowStart = afterBefore.match(/before:\s*(async\s*\([^)]+\)\s*=>\s*\{)/);
    const sigMatch = arrowStart[1].match(/async\s*\(([^)]+)\)/);
    const params = sigMatch[1];

    const bodyStartInSlice = arrowStart[0].lastIndexOf('{');
    let depth = 1;
    let bodyEnd = bodyStartInSlice + 1;
    while (depth > 0 && bodyEnd < afterBefore.length) {
      if (afterBefore[bodyEnd] === '{') depth++;
      if (afterBefore[bodyEnd] === '}') depth--;
      bodyEnd++;
    }

    const hookBody = afterBefore.substring(arrowStart.index + arrowStart[0].length - 1, bodyEnd);
    const fullHook = `async (${params}) => ${hookBody}`;
    const hookFn = eval(`(${fullHook})`);

    const result = await hookFn({ email: 'test@example.com' }, null);
    assert.ok(result, 'Hook should not crash with null context');
    assert.equal(result.data.organization_id, null,
      'With null context, organization_id should fall back to null');
    assert.equal(result.data.status, 'invited',
      'With null context, status should fall back to invited');
  });
});
