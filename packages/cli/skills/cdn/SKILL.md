# cdn

## cdn auth

Manage which host you upload to, and the token that lets you

### cdn auth login

Verify a token and store it at ~/.config/cdn/hosts/<host>.env, mode 0600

#### Environment Variables

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `CDN_HOST` | `string` | no |  | Which host to talk to; overrides the hosts file |
| `CDN_TOKEN` | `string` | no |  | Upload bearer; overrides the host file's |
| `XDG_CONFIG_HOME` | `string` | no |  | Where host files live; defaults to ~/.config |
| `HOME` | `string` | no |  | Used to locate ~/.config when XDG_CONFIG_HOME is unset |

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--host` | `string` |  | The CDN host, e.g. cdn.example.com — becomes the filename |
| `--token` | `string` |  | The upload bearer. Prompted for when omitted, if there is a terminal to ask |

#### Output

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | `string` | yes |  |
| `file` | `string` | yes | Where the token was written |
| `mode` | `string` | yes | The file's permissions, as octal |
| `contract` | `number` | yes | The API contract version the host speaks |

#### Examples

```sh
# Prompt for the token
cdn auth login --host cdn.example.com

# Non-interactive, e.g. from a secret manager
cdn auth login --host cdn.example.com --token …
```

> The token is CDN_UPLOAD_TOKEN on the Worker. Get it from `wrangler secret list` — or set it with `wrangler secret put CDN_UPLOAD_TOKEN`.

### cdn auth status

Show every configured host, which one is in effect, and why

#### Environment Variables

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `CDN_HOST` | `string` | no |  | Which host to talk to; overrides the hosts file |
| `CDN_TOKEN` | `string` | no |  | Upload bearer; overrides the host file's |
| `XDG_CONFIG_HOME` | `string` | no |  | Where host files live; defaults to ~/.config |
| `HOME` | `string` | no |  | Used to locate ~/.config when XDG_CONFIG_HOME is unset |

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--host` | `string` |  | Resolve as if this host had been asked for |

#### Output

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `dir` | `string` | yes | Where host files live |
| `hosts` | `array` | yes |  |
| `hosts[].host` | `string` | yes |  |
| `hosts[].file` | `string` | yes |  |
| `hosts[].mode` | `string` | yes | Permissions as octal; 0600 is what login writes |
| `hosts[].secure` | `boolean` | yes | False when the group or the world can read the token |
| `hosts[].active` | `boolean` | yes | Whether this is the host that would be used |
| `active` | `string` | no | The host that would be used, if one resolves |
| `why` | `string` | yes | The precedence step that decided, in words |

> Precedence is flags > env > config file: --host beats CDN_HOST, which beats the sole file in the hosts directory.

## cdn up

### cdn up

Upload a file or a directory and print the URL the CDN returns

#### Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | yes | File or directory to upload |
| `dest` | `string` | no | Where to put it: a trailing slash is a namespace (`notes/`), anything else is the exact key |

#### Environment Variables

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `CDN_HOST` | `string` | no |  | Which host to talk to; overrides the hosts file |
| `CDN_TOKEN` | `string` | no |  | Upload bearer; overrides the host file's |
| `XDG_CONFIG_HOME` | `string` | no |  | Where host files live; defaults to ~/.config |
| `HOME` | `string` | no |  | Used to locate ~/.config when XDG_CONFIG_HOME is unset |

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--permanent` | `boolean` |  | Exempt from the 30-day expiry sweep. Sticks across later overwrites of the key |
| `--host` | `string` |  | Upload to this host instead of the configured default |

#### Output

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | yes | Public URL — the file's own, or the folder page for a directory |
| `key` | `string` | yes | Object key, or the prefix a directory landed under |
| `files` | `number` | yes | Objects written |
| `bytes` | `number` | yes | Total bytes uploaded |
| `permanent` | `boolean` | yes | Whether the object is exempt from the expiry sweep |

#### Examples

```sh
# One file, random slug, real extension
cdn up shot.png

# Into a namespace
cdn up shot.png notes/

# At an exact key
cdn up shot.png notes/hero.png

# A directory, served as a listing page
cdn up ./dist

# Something that must outlive the sweep
cdn up app.zip releases/app.zip --permanent true
```

> No `ls` or `rm`: the upload bearer can add but not remove, and listing is a decision this project has not made yet (see README open threads).
