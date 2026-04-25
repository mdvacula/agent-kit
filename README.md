# agent-kit

Skills, agents, and specs for autonomous coding workflows.

## Repo layout

```
agent-kit/
│
├── .agents/skills/             ← auto-discovered by OpenCode + pi (no install needed)
│   ├── agentic-setup/          ← bootstrap a project (dual-mode: local / template)
│   │   ├── SKILL.md
│   │   └── REFERENCE.md
│   └── mcp-hub-setup/          ← set up the MCP Task Hub
│       └── SKILL.md
│
├── agents/
│   └── opencode/               ← OpenCode agent definitions (pi has no agent concept)
│       ├── hub-runner.md
│       ├── hub-orchestrator.md
│       └── openspec-orchestrator.md
│
├── skills/                     ← general-purpose skills installed per-project
│   ├── shared/                 ← works in both OpenCode and pi
│   ├── opencode/               ← OpenCode-specific skills
│   └── pi/                     ← pi-specific skills
│
├── commands/                   ← slash commands / prompt templates installed per-project
│   ├── shared/                 ← same format, works in both tools
│   ├── opencode/               ← OpenCode commands (.opencode/commands/)
│   └── pi/                     ← pi prompt templates (.pi/prompts/) — supports $1/$@ args
│
├── specs/                      ← living specs for kit components
│   └── mcp-task-hub/
│       └── spec.md
│
├── .opencode/                  ← makes agents/skills live in OpenCode when editing agent-kit
│   └── agents/                 (symlinks → agents/opencode/)
│
└── .github/workflows/
    ├── sync-template.yml       ← push → pi agent → PR on agent-template
    └── sync-hub.yml            ← push → pi agent → PR on mcp-task-hub
```

## Three output repos

| Repo | What it is | How to get it |
|------|-----------|---------------|
| `agent-template` | Ready-to-clone project scaffold | `git clone github.com/mdvacula/agent-template my-project` |
| `mcp-task-hub` | Docker service — centralized task state | `git clone github.com/mdvacula/mcp-task-hub ~/mcp-task-hub` |
| `agent-kit` | This repo — source of truth | Edit here, outputs update via Actions |

## How to use this locally

### 1. Start the hub (once, outside any project)

```bash
git clone https://github.com/mdvacula/mcp-task-hub ~/mcp-task-hub
cd ~/mcp-task-hub && cp .env.example .env
docker compose up -d
curl http://localhost:8000/health   # → {"status":"ok","task_count":0}
```

Or run the `mcp-hub-setup` skill (Mode A) to generate the hub from scratch.

### 2. Bootstrap a new project

```bash
git clone https://github.com/mdvacula/agent-template my-project
# or invoke the agentic-setup skill (Mode A) in any existing project
```

## How the GitHub Actions work

```
push to agent-kit/main
        │
        ├── changed skills/mcp-hub-setup/ or specs/mcp-task-hub/
        │         └── sync-hub.yml → pi agent (Mode B) → PR on mcp-task-hub
        │
        └── changed agents/, .agents/skills/agentic-setup/, skills/, or commands/
                  └── sync-template.yml → pi agent (Mode B) → PR on agent-template
```

Both actions run independently. Merge the PRs when you've reviewed the diff.

## Toolchain docs

| Tool | Docs |
|------|------|
| Entire | [docs.entire.io](https://docs.entire.io/) |
| MCP | [modelcontextprotocol.io](https://modelcontextprotocol.io/) |
| TaskMD | [driangle.github.io/taskmd](https://driangle.github.io/taskmd/) |
| OpenSpec | [openspec.dev](https://openspec.dev/) |
