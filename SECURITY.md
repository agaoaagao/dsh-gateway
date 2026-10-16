# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| latest release on `master` | ✅ |
| older tags | ❌ — please update |

## Reporting a vulnerability

This gateway is meant for a **trusted LAN** and intentionally serves plain HTTP
(that is a documented design decision, not a vulnerability). It should never be
exposed directly to the public internet.

If you found a real security issue — something that breaks account isolation,
leaks another account's data, cookies or credentials, or lets an
unauthenticated caller reach a user's dsh — please report it privately:

1. Open the repository's
   [**Security** tab](https://github.com/agaoaagao/dsh-gateway/security) and use
   **Report a vulnerability** (GitHub private vulnerability reporting).
2. Include: affected version/commit, how you run the gateway, and minimal
   reproduction steps.

Please do not open a public issue for security problems. You will be credited
in the release notes if you wish.

## Scope notes

- Passwords are stored only as scrypt digests; dsh credentials never reach the
  browser.
- Repeated failed sign-ins are throttled per client address and per user name.
- If you expose the gateway beyond your LAN, put it behind a TLS reverse proxy.
