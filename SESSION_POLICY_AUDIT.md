# Session Policy Audit

## Current Session Configuration

### Better Auth Default Behavior
The application uses Better Auth with the following default session policy:

- **Session Duration**: 7 days
- **Update Age**: 1 day
- **Refresh Mechanism**: Sliding refresh
- **Idle Timeout**: None (no idle timeout)

### Policy Details

1. **Session Lifetime**: Sessions remain valid for 7 days from creation
2. **Sliding Refresh**: Each time the session is used within the update age window (1 day), the session expiration is extended
3. **No Idle Timeout**: Sessions do not expire due to inactivity - only the absolute 7-day lifetime applies
4. **Update Age**: Sessions can be refreshed/extended if they are less than 1 day old

### Observed Behavior

Users are not logged out after extended periods of inactivity (e.g., full day). This is expected behavior given the current configuration:
- No idle timeout means sessions persist regardless of activity
- 7-day absolute lifetime means sessions only expire after 7 days
- Sliding refresh extends session lifetime on each use within the 1-day update window

### Security Considerations

The current policy prioritizes user convenience over strict security:
- **Pros**: Users don't need to re-authenticate frequently, better UX
- **Cons**: Longer session window increases risk if session tokens are compromised

### Recommendations

If stricter session security is required, consider:
1. Adding an idle timeout (e.g., 30 minutes of inactivity)
2. Reducing the absolute session lifetime (e.g., from 7 days to 1 day)
3. Implementing device/session management for users to revoke sessions manually

### Implementation Notes

- Session policy is managed by Better Auth library
- Configuration is in `lib/auth.js` (Better Auth setup)
- No custom session middleware overrides the default behavior
- Session tokens are stored according to Better Auth's default storage mechanism

### Audit Date

2026-08-15

### Context

This audit was conducted as part of the `/api/operators` security fix investigation. The session policy was reviewed to understand why users were not being logged out after extended inactivity periods.
