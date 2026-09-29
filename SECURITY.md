# Security policy

Please do not include credentials or sensitive logs in public issues. Report
security issues privately to the repository owner and include only a minimal
reproduction.

Never commit gateway passwords, session cookies, API tokens, signing
keystores, `local.properties`, device serial numbers, private gateway URLs, or
personal chat data. Rotate any credential that has appeared in Git history,
logs, screenshots, artifacts, or a public issue. Releases are draft by
default; verify the APK and its signature before publishing.

The app connects to the Gateway URL configured by the user. Chat content and
attachments are sent to that Gateway as required for normal operation. Review
the Gateway operator's privacy and retention policies before connecting.
