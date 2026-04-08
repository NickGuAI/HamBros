# Hammurabi Auth0 RBAC Manual Checklist

This repo change closes the code-side authorization gaps in Hammurabi, but it does not mutate the Auth0 tenant itself. Complete the dashboard steps below before treating issue `#731` as fully closed.

## What The Code Now Assumes

- Access tokens expose Hammurabi permissions through either:
  - the standard Auth0 `permissions` claim
  - a space-delimited `scope` claim
  - a namespaced custom claim ending in `/permissions`
- Hammurabi route enforcement now requires:
  - resource-scoped permissions for `combinedAuth(...)` routes such as `/api/telemetry/*`
  - the full `API_KEY_SCOPES` set for `/api/auth/*` admin routes

## Manual Auth0 Dashboard Steps

1. Disable open registration.
   - Auth0 Dashboard -> Authentication -> Database -> `Username-Password-Authentication` -> Settings
   - Enable `Disable Sign Ups`
2. Require verified email for human users.
   - Auth0 Dashboard -> Settings -> General
   - Enable the tenant setting that requires email verification for database users
3. Audit existing Auth0 users.
   - Auth0 Dashboard -> User Management -> Users
   - Review every account with Hammurabi access and remove unauthorized registrations
4. Confirm API authorization is RBAC-backed.
   - Auth0 Dashboard -> Applications -> APIs -> Hammurabi API
   - Enable `RBAC`
   - Enable `Add Permissions in the Access Token` if available in the tenant UI
5. Create or confirm Hammurabi permissions.
   - The permission set must cover:
     - `telemetry:read`
     - `telemetry:write`
     - `agents:read`
     - `agents:write`
     - `commanders:read`
     - `commanders:write`
     - `services:read`
     - `services:write`
     - `factory:read`
     - `factory:write`
6. Create or confirm roles.
   - `viewer`: read-only Hammurabi permissions
   - `admin`: all Hammurabi permissions listed above
7. Assign roles to legitimate users only.
8. Verify the access token claims actually contain permissions.
   - Preferred: Auth0 API setting `Add Permissions in the Access Token`
   - Fallback: Post-Login Action that injects a namespaced `/permissions` claim

## Evidence To Capture

- Screenshot or export showing `Disable Sign Ups` is enabled
- Screenshot or export showing email verification is required
- Screenshot or export of the Hammurabi API RBAC settings
- Screenshot or export of the `admin` and `viewer` roles with their permissions
- A decoded access token from a legitimate user showing the permissions claim
- User audit notes listing which existing Auth0 accounts were verified as legitimate

## Evidence Gap

- I could not execute tenant/dashboard changes from this repo environment.
- Issue `#731` is only fully complete after the dashboard evidence above is collected.
