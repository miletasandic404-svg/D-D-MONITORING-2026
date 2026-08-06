# Operational Warnings and Limitations

## ⚠️ CRITICAL: Single Point of Failure - Laptop-as-Media-Node

### Current Architecture
The platform uses a **laptop as the media node** for local camera processing. This architecture has significant operational risks that must be communicated to customers before deployment.

### Risks

1. **No Automatic Failover**
   - If the laptop goes to sleep, restarts due to Windows updates, or loses WiFi connection, **all cameras at that location go offline immediately**
   - No automatic failover mechanism exists
   - Manual intervention required to restore service

2. **Windows Update Interruptions**
   - Windows automatic updates can force restarts without warning
   - Camera streaming stops during restart and does not auto-recover
   - Requires manual restart of media node services

3. **Network Dependency**
   - WiFi disconnection or network switching causes immediate service interruption
   - No cellular backup or redundant network path
   - Cameras become inaccessible until network is restored and services restarted

4. **Hardware Reliability**
   - Consumer-grade laptops are not designed for 24/7 operation
   - Potential for hardware failure (disk, memory, power)
   - No hot-spare or backup hardware

### Customer Communication Requirements

**Before signing any contract or deployment agreement, you must:**

1. **Explicitly warn customers** that the current architecture has a single point of failure
2. **Document the expected downtime** during laptop restarts (typically 2-5 minutes)
3. **Provide SLA exclusions** for downtime caused by:
   - Windows updates
   - Laptop hardware failure
   - Network connectivity issues
   - Power outages (if no UPS)
4. **Recommend dedicated hardware** for production deployments:
   - Mini PC (Intel NUC, ASUS PN series)
   - Raspberry Pi with auto-restart configuration
   - Industrial-grade embedded systems
   - UPS backup for power redundancy

### Recommended Production Architecture

For mission-critical deployments (emergency services, security monitoring):

1. **Dedicated Hardware**
   - 24/7 rated hardware (not consumer laptops)
   - Solid-state storage (no spinning disks)
   - Passive cooling or industrial fans
   - UPS backup (minimum 30 minutes)

2. **Redundancy**
   - Multiple media nodes per location
   - Automatic failover between nodes
   - Health monitoring and auto-recovery

3. **Network Redundancy**
   - Primary + backup internet connection
   - Cellular fallback (4G/5G)
   - Network bonding for reliability

4. **Monitoring**
   - Real-time health checks
   - Automated alerts (SMS, email, Slack)
   - Predictive failure detection

### Temporary Mitigations (if using laptop)

If deploying with laptop media node temporarily:

1. **Disable Windows automatic updates** during critical periods
2. **Configure laptop to never sleep** on AC power
3. **Use wired Ethernet** instead of WiFi
4. **Add UPS backup** for power redundancy
5. **Set up monitoring alerts** for heartbeat failures
6. **Document restart procedure** for quick recovery

### Legal and Contractual Considerations

**Important:** The current "D&D Security ne snosi NIKAKVU odgovornost" (no liability) clause may not hold up in court for:
- Loss of human life due to system failure
- Property damage due to monitoring interruption
- Emergency response failures

**Recommendation:** Consult with a lawyer specializing in SaaS liability and emergency services contracts before deploying to critical infrastructure clients (police stations, emergency services, critical infrastructure).

---

## Other Operational Concerns

### Rate Limiting
- **Status:** ✅ Fixed - Now uses Upstash Redis for distributed rate limiting
- **Previous Issue:** In-memory rate limiting was ineffective across serverless cold starts
- **Configuration:** Requires `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` environment variables

### Disaster Recovery
- **Status:** ⚠️ Untested
- **Claim:** RTO < 2 hours for database loss
- **Action Required:** Perform actual DR exercise (delete test database, restore from backup, measure actual time)
- **Priority:** High - Before production deployment

### Security Audit
- **Status:** ⚠️ Self-audit only
- **Action Required:** Independent penetration test before public launch
- **Priority:** High - Critical for systems handling RTSP credentials and emergency services data

### Logging and Monitoring
- **Status:** ⚠️ Mixed - 135+ console.log/console.error calls
- **Action Required:** Replace with structured logger + Sentry integration
- **Priority:** High - Essential for production debugging

### Background Worker Monitoring
- **Status:** ⚠️ No health checks or alerts
- **Workers at risk:**
  - retention-job.js (GDPR compliance)
  - recording-worker.js (video storage)
  - pending-activation-worker.js (payment processing)
  - media-node-heartbeat.js (camera connectivity)
- **Action Required:** Add health check endpoints + alerting
- **Priority:** High - Critical for service reliability

---

## Priority Order for Resolution

1. ✅ Upstash Redis rate limiting (COMPLETED)
2. ✅ GitHub Actions CI/CD pipeline (COMPLETED)
3. ⏳ Document single point of failure warning (IN PROGRESS)
4. ⏳ Replace console.* with logger.* + Sentry
5. ⏳ Add monitoring/alerting for background workers
6. ⏳ Verify retention policy matches code implementation
7. ⏳ Schedule DR exercise and record actual RTO
8. ⏳ Legal review of ToS/liability clauses
9. ⏳ Independent security audit
10. ⏳ Frontend refactor (Dashboard component)
11. ⏳ Frontend tests for critical paths

---

## Conclusion

The platform has solid technical foundations but lacks operational maturity for mission-critical deployments. The single point of failure (laptop media node) is the most significant risk and must be addressed before any production deployment to emergency services or critical infrastructure customers.
