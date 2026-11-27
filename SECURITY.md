# Security Policy

## Supported Versions

Security fixes are applied to `main`:

| Version | Supported |
| :------ | :-------: |
| `0.1.x` |    Yes    |

---

## Reporting a Vulnerability

> [!IMPORTANT]
> **Please do NOT report security vulnerabilities in public GitHub issues or discussions.**

If you discover a security vulnerability in **Solwatch**, please report it privately through one of these channels:

1. **GitHub Private Vulnerability Reporting:** Open an advisory on [GitHub Security Advisories](https://github.com/oscarbol09/solwatch/security/advisories/new).
2. **Email:** [oscarbol09@gmail.com](mailto:oscarbol09@gmail.com) with subject `[Security] Solwatch Vulnerability Report`.

### What to Include

- Description of the vulnerability and potential impact
- Affected file paths or endpoints
- Minimal reproduction steps or proof of concept
- Suggested mitigation, if available

---

## Security Design Boundaries

1. **Strictly Read-Only Scope:** Solwatch monitors on-chain events and sends notifications. It does not sign transactions or manage private keys.
2. **SSRF & Secret Hygiene (`src/security/`):** Outbound webhook URLs undergo protocol and private-network checks (`src/security/ssrf.ts`), and tokens/URLs are redacted from logs (`src/security/sanitize.ts`).
3. **Timing-Safe Authentication:** Control-plane Bearer tokens (`API_TOKEN`) and inbound webhook signatures use constant-time comparison.
4. **Local SQLite Storage:** Ensure restrictive host filesystem permissions on the SQLite data directory in production.
