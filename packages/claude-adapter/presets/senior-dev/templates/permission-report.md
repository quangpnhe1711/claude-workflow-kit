# Permission / Security Report

<!-- Deep-workflow deliverable. Every row must be backed by code, configuration or
schema evidence - never by a file name or a plausible assumption. -->

## 1. Mission

## 2. Permission Requirement

## 3. Current Permission Model

- Where permission is loaded:
- Where it is enforced (backend):
- Where it is enforced (frontend):
- Cache / session behavior:

## 4. Target Permission Model

## 5. Actors, Resources, Actions

| Actor | Resource | Action | Allowed | Evidence |
| --- | --- | --- | --- | --- |
| | | | | |

## 6. Data Scope

<!-- Which records each actor may read or write, and what enforces the boundary. -->

## 7. UI Visibility

| Element | Visible to | Enforced where |
| --- | --- | --- |
| | | |

## 8. Backend Enforcement

## 9. Frontend Enforcement

<!-- Frontend visibility is UX, never the security boundary. Name the backend
control that actually protects the data. -->

## 10. Cache Impact

- Cached permission data:
- Invalidation trigger:
- Stale-permission window:

## 11. Security Risk

| Risk | Level | Attack path | Mitigation |
| --- | --- | --- | --- |
| | | | |

## 12. Implementation

| File | Change | Reason |
| --- | --- | --- |
| | | |

## 13. Permission Matrix (after change)

| Role | Read | Create | Update | Delete | Export |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## 14. Testing

- Permission tests:
- Negative tests (denied paths):
- Integration:
- Not covered, and why:

## 15. Migration

<!-- Existing users, roles or records that need a data change, or "No migration." -->

## 16. Rollback

## 17. Status
