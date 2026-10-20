# My Agent Setup

Requires OpenCode Desktop or CLI and Node.js 22+.

## Install

```sh
git clone git@github.com:0xsven/my-agent-setup.git
cd my-agent-setup
node scripts/install.mjs --install --yes
```

The installer symlinks the configuration into `~/.config/opencode`
and backs up existing managed files.

Restart OpenCode and any running OpenCode background service.

## Uninstall

```sh
node scripts/install.mjs --uninstall --yes
```
