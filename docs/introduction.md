# Introduction

heel is an open-source gateway that lets your AI agents use your accounts without ever holding their keys, and asks you before anything risky runs.

Your agents reach GitHub, Gmail, Slack, any MCP server, API or CLI through heel instead of directly. heel holds the credentials. For each call, your rules decide: it runs, it waits for you, or it never runs. No model decides a call. When one waits, you approve or deny it from your phone with a passkey.

![An approval request on a phone: my-agent wants to send an email to bob@vendor.com](images/approval-email.png)

## How it works

- **Connect an account once.** heel keeps the credential encrypted. Your agent only sees its name, like `github`.
- **Point your agent at heel.** It gets one MCP server with every account's tools, and its own heel token instead of your keys.
- **Rules decide every call.** The starter rules let reads run and make everything else ask you. A call no rule matches is denied.
- **You approve what asks.** heel shows exactly what will run, in plain words. Nothing runs until you approve.

heel is open source and runs on your own machine or server. Nothing goes through a heel cloud.

## Start here

- **[Quickstart](quickstart.md):** have your agent set heel up with one line, or do it by hand in about 10 minutes.
- **[Connect accounts](connect.md):** built-in services, any MCP server, HTTP API or CLI.
- **[Write rules](rules.md):** decide what runs on its own, what asks, and what never runs.
- **[Approve requests](approvals.md):** what a request shows you, approving from your phone, and pausing everything.
