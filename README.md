# gemini-plugin-cc

Based on https://github.com/anthropic/codex-plugin-cc

**Use Gemini from Claude Code** — adversarial code reviews, task delegation, and a stop-time review gate.

This plugin integrates [Gemini CLI](https://github.com/google-gemini/gemini-cli) into [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as an **adversarial reviewer and rescue agent**. It lets you challenge Claude's implementation choices by getting a second opinion from Google's Gemini model.

## 🚀 Quick Start

### 1. Install Gemini CLI

```bash
npm install -g @google/gemini-cli
```

### 2. Authenticate

```bash
gemini   # Follow the browser login flow
```

### 3. Install the plugin in Claude Code

```bash
claude plugin install /path/to/gemini-plugin-cc
```

### 4. Check readiness

```
/gemini:setup
```

## 📋 Commands

| Command | Description |
|---------|-------------|
| `/gemini:review` | Standard code review against local git state |
| `/gemini:adversarial-review` | Adversarial review — challenges design choices and assumptions |
| `/gemini:rescue` | Delegate investigation or fix tasks to Gemini |
| `/gemini:setup` | Check CLI readiness, toggle review gate |
| `/gemini:status` | Show active and recent jobs |
| `/gemini:result` | Show stored output for a finished job |
| `/gemini:cancel` | Cancel an active background job |

## 🔴 Adversarial Review

The `/gemini:adversarial-review` command instructs Gemini to **actively try to break your code**:

- Default to skepticism
- Target auth, data loss, race conditions, rollback safety
- Report only material, defensible findings
- Structured JSON output with severity, confidence, and recommendations

```
/gemini:adversarial-review --wait
/gemini:adversarial-review --background focus on auth and error handling
```

## 🚧 Stop-Time Review Gate

When enabled, this gate **blocks Claude from stopping** if Gemini finds issues in the most recent turn:

```
/gemini:setup --enable-review-gate    # Enable
/gemini:setup --disable-review-gate   # Disable
```

## 🛠 Architecture

Unlike the Codex plugin which uses a persistent `app-server` + broker, this plugin uses Gemini CLI's **headless mode** (`gemini -p "..." --output-format json`). This makes the architecture significantly simpler:

```
Claude Code → gemini-companion.mjs → gemini -p "..." → JSON output
```

No broker, no Unix sockets, no JSON-RPC protocol — just clean process spawning.

## ⚙️ Configuration

| Env Variable | Description |
|-------------|-------------|
| `GEMINI_COMPANION_SESSION_ID` | Auto-set by SessionStart hook |
| `CLAUDE_PLUGIN_DATA` | Plugin state directory |
| `GEMINI_API_KEY` | Alternative auth via API key |

**Default model:** `gemini-3.1-pro-preview`

## 📄 License

MIT
