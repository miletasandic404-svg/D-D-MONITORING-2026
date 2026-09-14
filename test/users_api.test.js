'use strict';

/**
 * Tests for api/users.js - specifically the user invite flow.
 *
 * Regression coverage for P1-1: temporary password exposure in API response.
 * Verifies that tempPassword is NOT returned in the JSON response when
 * inviting a new user.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('users API - invite user tempPassword exposure', () => {
  test('invite user response does NOT contain tempPassword in source code', () => {
    const fs = require('fs');
    const path = require('path');
    const usersFilePath = path.join(__dirname, '..', 'api', 'users.js');
    const usersSource = fs.readFileSync(usersFilePath, 'utf-8');

    // Find the sendSuccess call specifically in the invite user section
    // Look for the pattern between "Generate a temporary password" and "// PATCH"
    const inviteSectionMatch = usersSource.match(/\/\/ Generate a temporary password[\s\S]*?\/\/ PATCH/);
    assert.ok(inviteSectionMatch, 'Should find invite user section');

    const inviteSection = inviteSectionMatch[0];

    // Find the sendSuccess call within the invite section
    const sendSuccessMatch = inviteSection.match(/return sendSuccess\(res, \{[\s\S]*?\}\);/);
    assert.ok(sendSuccessMatch, 'Should find sendSuccess call in invite section');

    const sendSuccessCall = sendSuccessMatch[0];

    // Critical assertion: tempPassword must NOT be in the sendSuccess call
    assert.doesNotMatch(sendSuccessCall, /tempPassword/,
      'tempPassword must NOT be present in sendSuccess response');
    assert.doesNotMatch(sendSuccessCall, /temp_password/,
      'temp_password (snake_case) must NOT be present in sendSuccess response');
    assert.doesNotMatch(sendSuccessCall, /password/,
      'password must NOT be present in sendSuccess response');

    // The endpoint does not create a reset token or send email. Its response
    // must not claim that either happened.
    assert.doesNotMatch(sendSuccessCall, /password reset link sent/i,
      'Response must not claim that a reset link was sent');
    assert.match(sendSuccessCall, /temporary invitation credentials/i,
      'Response must describe the actual temporary-credential flow');
    assert.match(sendSuccessCall, /no email was sent/i,
      'Response must disclose that this endpoint does not send email');
  });
});
