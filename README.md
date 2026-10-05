# GitHub downtime clock

A static page that prices the last 90 days of GitHub downtime at an hourly rate.

Two clocks:

- **Full outage** is time GitHub marked the component in a major outage.
- **Degraded** is time GitHub marked the component degraded or in a partial outage.

GitHub's published uptime counts a major outage in full and a partial outage at 30%. Degraded performance does not change that percentage. This page prices every one of those minutes at the hourly rate, because the impact lasts the whole interval. Overlapping incidents are counted once.

The rate stays in the browser. Nothing is sent anywhere except the read of GitHub's public status API.

Actions is selected by default. The component list is the same one GitHub publishes on [githubstatus.com](https://www.githubstatus.com/).

## Publish

On GitHub: Settings → Pages → Deploy from a branch → `main` → `/ (root)`. There is no build step.

## Local preview

```bash
python3 -m http.server
```

Open the local URL the server prints. The status API allows browser requests from any origin.
